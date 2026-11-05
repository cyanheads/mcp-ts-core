/**
 * @fileoverview User-facing DataCanvas service. Wraps the provider and registry
 * with debug logging and tenant-id resolution, and serializes the shared-canvas
 * acquire that keeps a canvas id in `ctx.state`; the registry handles TTL,
 * caps, and provider-keying.
 * @module src/services/canvas/core/DataCanvas
 */

import type { Context } from '@/core/context.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';
import type { AcquireOptions, AcquireSharedOptions } from '../types.js';
import { CanvasInstance } from './CanvasInstance.js';
import { CanvasIdSchema, type CanvasRegistry } from './CanvasRegistry.js';
import type { IDataCanvasProvider } from './IDataCanvasProvider.js';

/** `ctx.state` key {@link DataCanvas.acquireShared} keeps the id under by default. */
const DEFAULT_SHARED_STATE_KEY = 'canvas-id';

/** What `ctx.state` holds under a shared-canvas key, resolved against the registry. */
type SharedSlot =
  | { status: 'empty' }
  /** A stored value with no live canvas behind it; `previousId` is unset when it was not a canvas id. */
  | { status: 'dead'; previousId: string | undefined }
  | { status: 'live'; instance: CanvasInstance };

/** Resolve the effective tenant ID; throw when absent. */
function requireTenantId(context: RequestContext): string {
  const tenantId = context.tenantId;
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    // No data: nothing here is caller-actionable, and the handler's error path
    // logs the request context (#548).
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      'Tenant ID is required for canvas operations but was not found in the request context.',
    );
  }
  return tenantId;
}

/**
 * Join `queue` and wait to be called. A waiter whose signal aborts first leaves
 * the queue and rejects with the signal's reason, without waiting for its turn.
 */
async function waitInQueue(queue: Array<() => void>, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    // Once handed the turn the waiter is no longer queued and its promise has
    // resolved: it runs, and its own `ctx.state` read reports the abort.
    const index = queue.indexOf(resolve);
    if (index !== -1) queue.splice(index, 1);
    reject(signal.reason);
  };
  queue.push(resolve);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await promise;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Service entry point for the DataCanvas primitive. Returned from
 * `core.canvas` on `CoreServices` when a canvas provider is configured.
 *
 * @example
 * ```ts
 * const canvas = await core.canvas!.acquire(input.canvas_id, ctx);
 * await canvas.registerTable('germplasm', rows);
 * const result = await canvas.query('SELECT name FROM germplasm LIMIT 10');
 * return { canvas_id: canvas.canvasId, expires_at: canvas.expiresAt, ... };
 * ```
 */
export class DataCanvas {
  /**
   * Callers waiting behind the {@link acquireShared} resolution running for a
   * (tenant, `stateKey`). An entry exists only while one runs: the last caller
   * out deletes it.
   */
  private readonly sharedQueues = new Map<string, Array<() => void>>();

  constructor(
    private readonly provider: IDataCanvasProvider,
    private readonly registry: CanvasRegistry,
  ) {
    logger.info(`DataCanvas initialized with provider: ${provider.name}`);
  }

  /**
   * Resolve an existing canvas or create a new one. The returned
   * {@link CanvasInstance} captures `(canvasId, tenantId)` so subsequent
   * operations don't need to repeat them.
   */
  async acquire(
    maybeId: string | undefined,
    context: RequestContext,
    options?: AcquireOptions,
  ): Promise<CanvasInstance> {
    const tenantId = requireTenantId(context);
    const result = await this.registry.acquire(maybeId, tenantId, context, options);
    logger.debug('Canvas acquired.', {
      ...withExtra(context, { canvasId: result.canvasId, isNew: result.isNew }),
      tenantId,
    });
    return new CanvasInstance(
      result.canvasId,
      result.tenantId,
      result.isNew,
      result.expiresAt,
      this.registry,
      this.provider,
      context,
    );
  }

  /**
   * Resolve the canvas whose id `ctx.state` holds under `stateKey`, minting
   * and storing one when none is live. At most one resolution per (tenant,
   * `stateKey`) runs at a time in this process, so concurrent first calls
   * converge on one canvas instead of each minting its own.
   *
   * A stored id the registry holds for the tenant returns without queueing.
   * Otherwise the call queues; in its turn it re-reads the id under its own
   * `ctx` and, finding no live canvas, runs `onReplace`, then mints and stores
   * the bare id with a TTL of the registry's absolute cap — or, with
   * `create: false`, deletes a dead stored value and returns `undefined`. No
   * stored value, `canvas_not_found`, and a value that is not a canvas id all
   * count as no live canvas; any other failure propagates and leaves the
   * stored id as it was.
   *
   * Scope is this process, as canvases are: instances sharing one storage
   * backend read each other's ids as dead and replace them, so route each
   * tenant (or key) to one instance.
   *
   * @throws The `ctx.state` `ValidationError` for an invalid `stateKey`, before
   *   anything is minted; whatever `onReplace` throws; the id write's error,
   *   after the canvas it was storing is dropped; the signal's reason when
   *   `ctx.signal` aborts, a queued call included.
   */
  acquireShared(
    ctx: Context,
    options?: AcquireSharedOptions & { create?: true },
  ): Promise<CanvasInstance>;
  acquireShared(
    ctx: Context,
    options: AcquireSharedOptions & { create: false },
  ): Promise<CanvasInstance | undefined>;
  acquireShared(ctx: Context, options?: AcquireSharedOptions): Promise<CanvasInstance | undefined>;
  async acquireShared(
    ctx: Context,
    options: AcquireSharedOptions = {},
  ): Promise<CanvasInstance | undefined> {
    const { create = true, onReplace, stateKey = DEFAULT_SHARED_STATE_KEY } = options;
    const seen = await this.readSharedSlot(ctx, stateKey);
    if (seen.status === 'live') return seen.instance;

    const lockKey = JSON.stringify([requireTenantId(ctx), stateKey]);
    return await this.serialize(lockKey, ctx.signal, async () => {
      const slot = await this.readSharedSlot(ctx, stateKey);
      if (slot.status === 'live') return slot.instance;
      const previousId = slot.status === 'dead' ? slot.previousId : undefined;
      await onReplace?.(previousId);
      if (!create) {
        if (slot.status === 'dead') await ctx.state.delete(stateKey);
        return;
      }

      const instance = await this.acquire(undefined, ctx, { signal: ctx.signal });
      try {
        // No canvas outlives the absolute cap, so the id never expires first.
        await ctx.state.set(stateKey, instance.canvasId, {
          ttl: Math.ceil(this.registry.absoluteCapMs / 1000),
        });
      } catch (error) {
        // An unstored canvas is unreachable and would hold a cap slot until it expires.
        await this.drop(instance.canvasId, ctx);
        throw error;
      }
      logger.debug('Shared canvas stored.', {
        ...withExtra(ctx, { canvasId: instance.canvasId, previousId, stateKey }),
        tenantId: instance.tenantId,
      });
      return instance;
    });
  }

  /**
   * Drop a canvas explicitly. Returns true when the canvas existed and was
   * destroyed.
   */
  async drop(canvasId: string, context: RequestContext): Promise<boolean> {
    const tenantId = requireTenantId(context);
    return await this.registry.drop(canvasId, tenantId, context);
  }

  /** Active canvas count for the calling tenant. */
  countForTenant(context: RequestContext): number {
    const tenantId = requireTenantId(context);
    return this.registry.countForTenant(tenantId);
  }

  /** Liveness check on the underlying provider. */
  healthCheck(): Promise<boolean> {
    return this.provider.healthCheck();
  }

  /** Tear down the registry and provider. Called from `ServerHandle.shutdown()`. */
  async shutdown(context: RequestContext): Promise<void> {
    await this.registry.shutdown(context);
  }

  /** @internal Surface the underlying provider for advanced use cases. */
  getProvider(): IDataCanvasProvider {
    return this.provider;
  }

  /** Read what `ctx.state` holds under `stateKey` and resolve it against the registry. */
  private async readSharedSlot(ctx: Context, stateKey: string): Promise<SharedSlot> {
    const stored = await ctx.state.get(stateKey);
    if (stored === null) return { status: 'empty' };
    const id = CanvasIdSchema.safeParse(stored);
    if (!id.success) return { status: 'dead', previousId: undefined };
    try {
      return {
        status: 'live',
        instance: await this.acquire(id.data, ctx, { signal: ctx.signal }),
      };
    } catch (error) {
      if (error instanceof McpError && error.data?.reason === 'canvas_not_found') {
        return { status: 'dead', previousId: id.data };
      }
      throw error;
    }
  }

  /** Run `run` once every earlier caller queued under `key` has finished. */
  private async serialize<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const waiting = this.sharedQueues.get(key);
    const queue = waiting ?? [];
    if (waiting) await waitInQueue(queue, signal);
    else this.sharedQueues.set(key, queue);
    try {
      return await run();
    } finally {
      const next = queue.shift();
      if (next) next();
      else this.sharedQueues.delete(key);
    }
  }
}
