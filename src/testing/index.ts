/**
 * @fileoverview Test utilities for MCP server development.
 * Provides `createMockContext()` for testing tool and resource handlers
 * against the unified Context interface, plus `createMockLogger()` and
 * `createInMemoryStorage()` for unit-testing services in isolation.
 * @module src/testing/index
 */

import type {
  CreateMessageResult,
  ElicitResult,
  SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodType, z } from 'zod';
import type {
  AuthContext,
  Context,
  ContextLogger,
  ContextProgress,
  ContextState,
  SamplingOpts,
} from '@/core/context.js';
import { attachTypedFail } from '@/core/context.js';
import { StorageService } from '@/storage/core/StorageService.js';
import {
  InMemoryProvider,
  type InMemoryProviderOptions,
} from '@/storage/providers/inMemory/inMemoryProvider.js';
import type { ErrorContract } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MockContextOptions {
  /** Auth context. */
  auth?: AuthContext;
  /** Mock elicitation handler. */
  elicit?: (message: string, schema: z.ZodObject<z.ZodRawShape>) => Promise<ElicitResult>;
  /**
   * Error contract to attach a typed `ctx.fail` against. Pass the definition's
   * own `errors` array (`createMockContext({ errors: myTool.errors })`) so the
   * mock's `fail` matches what the production handler factory wires up. Tests
   * can then assert on `data.reason` without manually composing `createFail`.
   */
  errors?: readonly ErrorContract[];
  /** Mock resource list changed notifier. */
  notifyResourceListChanged?: () => void;
  /** Mock resource updated notifier. */
  notifyResourceUpdated?: (uri: string) => void;
  /** Enable task progress (creates a mock ContextProgress). */
  progress?: boolean;
  /** Request ID override. Defaults to 'test-request-id'. */
  requestId?: string;
  /** Mock sampling handler. */
  sample?: (messages: SamplingMessage[], opts?: SamplingOpts) => Promise<CreateMessageResult>;
  /**
   * HTTP session ID. Defaults to undefined. Set to exercise handlers that
   * branch on `ctx.sessionId` — mirrors what a stateful HTTP request would
   * surface, or what the opt-in `exposeStatelessSessionId` path produces.
   */
  sessionId?: string;
  /** Custom AbortSignal. Defaults to a fresh AbortController's signal. */
  signal?: AbortSignal;
  /** Tenant ID. Enables ctx.state operations when provided. */
  tenantId?: string;
  /** Resource URI for resource handler testing. */
  uri?: URL;
}

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

/** A `ContextLogger` that records every call to an inspectable `calls` array. */
export type MockContextLogger = ContextLogger & {
  /** Every log call in insertion order. `data` is the per-call metadata argument. */
  calls: Array<{ level: string; msg: string; data?: unknown }>;
};

/**
 * Create a `ContextLogger` whose calls are recorded for inspection.
 * Useful when unit-testing code that accepts a `ContextLogger` directly.
 *
 * @example
 * ```ts
 * import { createMockLogger } from '@cyanheads/mcp-ts-core/testing';
 *
 * const log = createMockLogger();
 * log.info('started', { step: 1 });
 * expect(log.calls).toEqual([{ level: 'info', msg: 'started', data: { step: 1 } }]);
 * ```
 */
export function createMockLogger(): MockContextLogger {
  const calls: Array<{ level: string; msg: string; data?: unknown }> = [];

  const logFn = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    calls.push({ level, msg, data });
  };

  return {
    calls,
    debug: logFn('debug'),
    info: logFn('info'),
    notice: logFn('notice'),
    warning: logFn('warning'),
    error: (msg: string, _error?: Error, data?: Record<string, unknown>) => {
      calls.push({ level: 'error', msg, data });
    },
  };
}

function createMockState(tenantId?: string): ContextState {
  const store = new Map<string, unknown>();

  const requireTenant = () => {
    if (!tenantId) {
      throw new Error('tenantId required for state operations');
    }
  };

  return {
    get<T = unknown>(key: string, schema?: ZodType<T>) {
      requireTenant();
      const value = store.get(key);
      if (value === undefined) return Promise.resolve(null);
      return Promise.resolve(schema ? schema.parse(value) : (value as T));
    },
    set(key, value) {
      requireTenant();
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key) {
      requireTenant();
      store.delete(key);
      return Promise.resolve();
    },
    deleteMany(keys) {
      requireTenant();
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return Promise.resolve(count);
    },
    getMany<T = unknown>(keys: string[]) {
      requireTenant();
      const result = new Map<string, T>();
      for (const key of keys) {
        if (store.has(key)) result.set(key, store.get(key) as T);
      }
      return Promise.resolve(result);
    },
    setMany(entries) {
      requireTenant();
      for (const [key, value] of entries) {
        store.set(key, value);
      }
      return Promise.resolve();
    },
    list(prefix) {
      requireTenant();
      const items: Array<{ key: string; value: unknown }> = [];
      for (const [key, value] of store) {
        if (!prefix || key.startsWith(prefix)) {
          items.push({ key, value });
        }
      }
      return Promise.resolve({ items });
    },
  };
}

function createMockProgress(): ContextProgress & {
  _total: number;
  _completed: number;
  _messages: string[];
} {
  const state = { _total: 0, _completed: 0, _messages: [] as string[] };

  return {
    get _total() {
      return state._total;
    },
    get _completed() {
      return state._completed;
    },
    get _messages() {
      return state._messages;
    },
    setTotal(n) {
      state._total = n;
      state._completed = 0;
      return Promise.resolve();
    },
    increment(amount = 1) {
      state._completed = Math.min(
        state._completed + amount,
        state._total || state._completed + amount,
      );
      return Promise.resolve();
    },
    update(message) {
      state._messages.push(message);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock Context for testing tool and resource handlers.
 *
 * @example
 * ```ts
 * // Minimal — works for most tests
 * const ctx = createMockContext();
 *
 * // With tenant (for tools that use ctx.state)
 * const ctx = createMockContext({ tenantId: 'test-tenant' });
 *
 * // With sampling capability
 * const ctx = createMockContext({
 *   sample: vi.fn().mockResolvedValue({
 *     role: 'assistant',
 *     content: { type: 'text', text: 'Response' },
 *     model: 'test',
 *   }),
 * });
 *
 * // With task progress
 * const ctx = createMockContext({ progress: true });
 * ```
 */
export function createMockContext(options: MockContextOptions = {}): Context {
  const log = createMockLogger();
  const state = createMockState(options.tenantId);
  const progress = options.progress ? createMockProgress() : undefined;

  const ctx: Context = {
    requestId: options.requestId ?? 'test-request-id',
    timestamp: new Date().toISOString(),
    log,
    state,
    signal: options.signal ?? new AbortController().signal,
    tenantId: options.tenantId,
    sessionId: options.sessionId,
    auth: options.auth,
    elicit: options.elicit,
    sample: options.sample,
    notifyResourceListChanged: options.notifyResourceListChanged,
    notifyResourceUpdated: options.notifyResourceUpdated,
    progress,
    uri: options.uri,
    // No-op resolver for definitions without a contract. `attachTypedFail` below
    // overwrites it with a contract-aware resolver when `options.errors` is set.
    recoveryFor: () => ({}),
  };

  // Mirror the production handler factory: when a contract is declared, attach
  // a typed `fail` and `recoveryFor` keyed by the contract's reasons. Empty
  // contracts leave the no-op resolver in place.
  return attachTypedFail(ctx, options.errors);
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Build a real `StorageService` backed by an in-memory provider, suitable for
 * unit-testing services that accept a `StorageService` dependency.
 *
 * Because this uses the production `StorageService` + `InMemoryProvider`, the
 * behavior (tenant isolation, TTL, validation, list pagination) matches what
 * you'd see in a running server — no hand-rolled fake required.
 *
 * @example
 * ```ts
 * import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
 *
 * const storage = createInMemoryStorage();
 * const svc = new MyService(config, storage);
 * const ctx = createMockContext({ tenantId: 'test-tenant' });
 * await svc.doWork(input, ctx);
 * ```
 */
export function createInMemoryStorage(options?: InMemoryProviderOptions): StorageService {
  return new StorageService(new InMemoryProvider(options));
}
