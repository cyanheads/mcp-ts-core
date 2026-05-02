/**
 * @fileoverview User-facing DataCanvas service. Wraps the provider and registry
 * with debug logging and tenant-id resolution; the registry handles TTL,
 * caps, and provider-keying. Mirrors the StorageService surface pattern but
 * stays OTel-free in v1 (per issue #97 scope).
 * @module src/canvas/core/DataCanvas
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import type { AcquireOptions } from '../types.js';
import { CanvasInstance } from './CanvasInstance.js';
import type { CanvasRegistry } from './CanvasRegistry.js';
import type { IDataCanvasProvider } from './IDataCanvasProvider.js';

/**
 * Resolve the effective tenant ID from the context, throwing when absent.
 * Mirrors `requireTenantId` in StorageService — canvas operations are
 * tenant-scoped by construction.
 */
function requireTenantId(context: RequestContext): string {
  const tenantId = context.tenantId;
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      'Tenant ID is required for canvas operations but was not found in the request context.',
      { operation: context.operation || 'DataCanvas.acquire', requestId: context.requestId },
    );
  }
  return tenantId;
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
    _options?: AcquireOptions,
  ): Promise<CanvasInstance> {
    const tenantId = requireTenantId(context);
    const result = await this.registry.acquire(maybeId, tenantId, context);
    logger.debug('Canvas acquired.', {
      ...context,
      canvasId: result.canvasId,
      tenantId,
      isNew: result.isNew,
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
}
