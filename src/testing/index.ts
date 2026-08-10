/**
 * @fileoverview Test utilities for MCP server development.
 * Provides `createMockContext()` for testing tool and resource handlers
 * against the unified Context interface, plus `createMockLogger()` and
 * `createInMemoryStorage()` for unit-testing services in isolation.
 * @module src/testing/index
 */

import type {
  CallToolResult,
  ContentBlock,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type {
  AuthContext,
  Context,
  ContextLogger,
  ContextProgress,
  ElicitFn,
  HandlerContext,
  ReasonOf,
} from '@/core/context.js';
import {
  attachTypedFail,
  createContentCollect,
  createContentStore,
  createContextState,
  createEnrich,
  createEnrichmentStore,
  readContentStore,
  readEnrichmentStore,
  stashContentStore,
  stashEnrichmentStore,
} from '@/core/context.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  buildToolSuccessResult,
  classifyAndBuildToolErrorResult,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { StorageService } from '@/storage/core/StorageService.js';
import {
  InMemoryProvider,
  type InMemoryProviderOptions,
} from '@/storage/providers/inMemory/inMemoryProvider.js';
import type { ErrorContract } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link createMockContext} and {@link createMockSession}.
 *
 * `TErrors` is the definition's own `errors[]` contract, inferred from the
 * `errors` property. Supplying it narrows the returned context to
 * `HandlerContext<ReasonOf<TErrors>>`, which is what a definition declaring a
 * contract types its handler's `ctx` parameter as.
 */
export interface MockContextOptions<
  TErrors extends readonly ErrorContract[] | undefined = readonly ErrorContract[] | undefined,
> {
  /** Auth context. */
  auth?: AuthContext;
  /**
   * Mock elicitation handler for form-mode elicitation. When provided, the
   * mock context's `ctx.elicit` is set to this function with a default no-op
   * `.url(...)` stub attached — tests that only exercise form-mode elicitation
   * don't need to supply `.url` explicitly.
   */
  elicit?: (message: string, schema: z.ZodObject<z.ZodRawShape>) => Promise<ElicitResult>;
  /**
   * Error contract to attach a typed `ctx.fail` against. Pass the definition's
   * own `errors` array (`createMockContext({ errors: myTool.errors })`) so the
   * mock's `fail` matches what the production handler factory wires up. Tests
   * can then assert on `data.reason` without manually composing `createFail`.
   *
   * Typed to include `undefined` so a definition's `errors` — optional on the
   * definition, hence `readonly ErrorContract[] | undefined` — can be forwarded
   * directly under `exactOptionalPropertyTypes`.
   */
  errors?: TErrors | undefined;
  /** Mock prompt list changed notifier. */
  notifyPromptListChanged?: () => void;
  /** Mock resource list changed notifier. */
  notifyResourceListChanged?: () => void;
  /** Mock resource updated notifier. */
  notifyResourceUpdated?: (uri: string) => void;
  /** Mock tool list changed notifier. */
  notifyToolListChanged?: () => void;
  /** Enable task progress (creates a mock ContextProgress). */
  progress?: boolean;
  /** Request ID override. Defaults to 'test-request-id'. */
  requestId?: string;
  /**
   * HTTP session ID. Defaults to undefined. Set to exercise handlers that
   * branch on `ctx.sessionId` — mirrors what a stateful HTTP request would
   * surface, or what the opt-in `exposeStatelessSessionId` path produces.
   */
  sessionId?: string;
  /** Custom AbortSignal. Defaults to a fresh AbortController's signal. */
  signal?: AbortSignal;
  /**
   * Tenant ID for `ctx.state`. Defaults to `'default'`, matching how a stdio
   * server (and HTTP with `MCP_AUTH_MODE=none`) resolves it, so state works
   * without options. Set it to exercise tenant-scoped behavior explicitly.
   */
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

/** Tenant used when none is supplied — the value a stdio server resolves to. */
const DEFAULT_MOCK_TENANT_ID = 'default';

/**
 * Creates a mock Context for testing tool and resource handlers.
 *
 * `ctx.state` runs on a real `StorageService` over an `InMemoryProvider`, so a
 * test sees the same key validation, TTL expiry, and pagination a deployed
 * server does — an invalid key fails in the test rather than in the field.
 *
 * When `errors` is supplied, the return type narrows to
 * `HandlerContext<ReasonOf<TErrors>>`: the context carries a typed `ctx.fail`
 * and is assignable to the `ctx` parameter of the handler whose contract it was
 * given.
 *
 * @example
 * ```ts
 * // Minimal — state works out of the box on tenant 'default'
 * const ctx = createMockContext();
 *
 * // Explicit tenant
 * const ctx = createMockContext({ tenantId: 'test-tenant' });
 *
 * // Typed ctx.fail against a definition's contract
 * const ctx = createMockContext({ errors: myTool.errors });
 *
 * // With task progress
 * const ctx = createMockContext({ progress: true });
 * ```
 */
export function createMockContext<
  const TErrors extends readonly ErrorContract[] | undefined = undefined,
>(options: MockContextOptions<TErrors> = {}): HandlerContext<ReasonOf<TErrors>> {
  const log = createMockLogger();
  const requestId = options.requestId ?? 'test-request-id';
  const timestamp = new Date().toISOString();
  const tenantId = options.tenantId ?? DEFAULT_MOCK_TENANT_ID;
  const signal = options.signal ?? new AbortController().signal;
  const state = createContextState(
    createInMemoryStorage(),
    { requestId, timestamp, operation: 'createMockContext', tenantId },
    signal,
  );
  const progress = options.progress ? createMockProgress() : undefined;

  const enrichmentStore = createEnrichmentStore();
  const contentStore = createContentStore();

  // Wrap the caller's elicit mock into an ElicitFn so that tests calling
  // ctx.elicit.url(...) don't throw TypeError. The default url stub returns a
  // cancelled result and can be overridden by casting the mock to ElicitFn.
  let elicit: ElicitFn | undefined;
  if (options.elicit) {
    const base = options.elicit as ElicitFn;
    base.url = async (_message: string, _url: string): Promise<ElicitResult> =>
      ({ action: 'cancel' }) as ElicitResult;
    elicit = base;
  }

  const ctx: Context = {
    requestId,
    timestamp,
    log,
    state,
    signal,
    tenantId,
    sessionId: options.sessionId,
    auth: options.auth,
    elicit,
    notifyPromptListChanged: options.notifyPromptListChanged,
    notifyResourceListChanged: options.notifyResourceListChanged,
    notifyResourceUpdated: options.notifyResourceUpdated,
    notifyToolListChanged: options.notifyToolListChanged,
    progress,
    uri: options.uri,
    content: createContentCollect(contentStore),
    enrich: createEnrich(enrichmentStore),
    // No-op resolver for definitions without a contract. `attachTypedFail` below
    // overwrites it with a contract-aware resolver when `options.errors` is set.
    recoveryFor: () => ({}),
  };

  // Stash the enrichment store so `getEnrichment(ctx)` can read what a handler
  // (or the service layer) accumulated via `ctx.enrich(...)` during the test.
  stashEnrichmentStore(ctx, enrichmentStore);
  // Stash the content store so `getContentBlocks(ctx)` can read what a handler
  // emitted via `ctx.content(...)` during the test.
  stashContentStore(ctx, contentStore);

  // Mirror the production handler factory: when a contract is declared, attach
  // a typed `fail` and `recoveryFor` keyed by the contract's reasons. Empty
  // contracts leave the no-op resolver in place. The assertion re-states in the
  // type system what `attachTypedFail` just did at runtime.
  return attachTypedFail(ctx, options.errors) as HandlerContext<ReasonOf<TErrors>>;
}

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

/**
 * A mock HTTP session and the handler context bound to it. `R` is the reason
 * union of the contract passed as `errors`, so `session.ctx` carries the same
 * typed `fail` a contract-bearing handler expects.
 */
export interface MockSession<R extends string = never> {
  /** Context carrying this session's identity. Pass it directly to a handler. */
  ctx: HandlerContext<R>;
  /** Session identifier exposed as `ctx.sessionId`. */
  sessionId: string;
  /** Tenant identifier exposed as `ctx.tenantId`. Defaults to `'default'`. */
  tenantId: string;
}

/**
 * Creates a handler context bound to a deterministic HTTP session.
 *
 * All {@link MockContextOptions} remain available, including `errors`,
 * `signal`, and notification callbacks. The default session ID is stable so
 * assertions do not depend on generated values.
 *
 * @example
 * ```ts
 * const session = createMockSession({ tenantId: 'tenant-a' });
 * const result = await myTool.handler(input, session.ctx);
 * expect(session.ctx.sessionId).toBe('test-session-id');
 * ```
 */
export function createMockSession<
  const TErrors extends readonly ErrorContract[] | undefined = undefined,
>(options: MockContextOptions<TErrors> = {}): MockSession<ReasonOf<TErrors>> {
  const sessionId = options.sessionId ?? 'test-session-id';
  const ctx = createMockContext<TErrors>({ ...options, sessionId });
  return { ctx, sessionId, tenantId: options.tenantId ?? DEFAULT_MOCK_TENANT_ID };
}

/**
 * Reads the enrichment a handler accumulated via `ctx.enrich(...)` on a mock
 * context, for assertions. Returns the merged field values (empty object when
 * nothing was enriched).
 *
 * @example
 * ```ts
 * const ctx = createMockContext();
 * await search.handler(search.input.parse({ query: 'x' }), ctx);
 * expect(getEnrichment(ctx)).toMatchObject({ effectiveQuery: 'x', totalCount: 0 });
 * ```
 */
export function getEnrichment(ctx: Context): Record<string, unknown> {
  return readEnrichmentStore(ctx)?.values ?? {};
}

/**
 * Reads the content blocks a handler emitted via `ctx.content(...)` on a mock
 * context, for assertions. Returns them in insertion order (empty array when none
 * were emitted) — the same blocks the handler factory prepends to `content[]`,
 * never placed in `structuredContent`.
 *
 * @example
 * ```ts
 * const ctx = createMockContext();
 * await render.handler(render.input.parse({ text: 'hi' }), ctx);
 * expect(getContentBlocks(ctx)).toEqual([{ type: 'image', data: '...', mimeType: 'image/png' }]);
 * ```
 */
export function getContentBlocks(ctx: Context): ContentBlock[] {
  return readContentStore(ctx)?.blocks ?? [];
}

// ---------------------------------------------------------------------------
// Fetch / HTTP harness
// ---------------------------------------------------------------------------

/** A request matcher used by {@link createFetchMock}. */
export type FetchMockMatcher = string | RegExp | ((request: Request) => boolean);

/** A response factory used by {@link createFetchMock}. */
export type FetchMockResponder = Response | ((request: Request) => Promise<Response> | Response);

/** One upstream route handled by a {@link FetchMockHarness}. */
export interface FetchMockRoute {
  /** URL string, regular expression, or request predicate. */
  match: FetchMockMatcher;
  /** Optional HTTP method constraint. Compared case-insensitively. */
  method?: string;
  /** Remove the route after its first matching request. */
  once?: boolean;
  /** Static response (cloned per call) or response factory. */
  respond: FetchMockResponder;
}

/** A captured upstream request and the route that matched it. */
export interface FetchMockCall {
  /** Clone of the request, safe to inspect after the responder reads its body. */
  request: Request;
  /** The route selected for the request. */
  route: FetchMockRoute;
}

/** Options for {@link createFetchMock}. */
export interface FetchMockOptions {
  /** Optional fallback for unmatched requests. The default throws. */
  onUnhandled?: (request: Request) => Promise<Response> | Response;
}

/**
 * Stateful fetch fake for testing upstream HTTP boundaries without mocking
 * server-owned services. Routes are evaluated in registration order.
 */
export interface FetchMockHarness {
  /** Captured requests in call order. */
  readonly calls: readonly FetchMockCall[];
  /** Fetch-compatible function for explicit dependency injection. */
  fetch: typeof globalThis.fetch;
  /** Install the harness as `globalThis.fetch`. Idempotent until restored. */
  install(): void;
  /** Drop all captured calls and registered routes. */
  reset(): void;
  /** Restore the fetch implementation captured by {@link install}. */
  restore(): void;
  /** Add one or more routes. */
  route(...routes: FetchMockRoute[]): FetchMockHarness;
}

function matchesFetchRoute(route: FetchMockRoute, request: Request): boolean {
  if (route.method && route.method.toUpperCase() !== request.method.toUpperCase()) {
    return false;
  }
  if (typeof route.match === 'string') return request.url === route.match;
  if (route.match instanceof RegExp) {
    route.match.lastIndex = 0;
    return route.match.test(request.url);
  }
  return route.match(request);
}

/**
 * Creates a strict fetch/HTTP harness for upstream API tests.
 *
 * Unmatched requests throw by default, making accidental network access loud.
 * Use `harness.fetch` as an injected dependency or call `install()` and
 * `restore()` around code that reads `globalThis.fetch`.
 *
 * @example
 * ```ts
 * const http = createFetchMock([
 *   {
 *     method: 'GET',
 *     match: 'https://api.example.test/items/42',
 *     respond: Response.json({ id: '42', name: 'Example' }),
 *   },
 * ]);
 * http.install();
 * try {
 *   await expect(loadItem('42')).resolves.toMatchObject({ id: '42' });
 *   expect(http.calls).toHaveLength(1);
 * } finally {
 *   http.restore();
 * }
 * ```
 */
export function createFetchMock(
  initialRoutes: readonly FetchMockRoute[] = [],
  options: FetchMockOptions = {},
): FetchMockHarness {
  const routes = [...initialRoutes];
  const calls: FetchMockCall[] = [];
  let installedFetch: typeof globalThis.fetch | undefined;

  const mockFetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const route = routes.find((candidate) => matchesFetchRoute(candidate, request));
    if (!route) {
      if (options.onUnhandled) return Promise.resolve(options.onUnhandled(request));
      return Promise.reject(new Error(`Unhandled fetch request: ${request.method} ${request.url}`));
    }

    calls.push({ request: request.clone(), route });
    if (route.once) routes.splice(routes.indexOf(route), 1);
    return Promise.resolve(
      route.respond instanceof Response ? route.respond.clone() : route.respond(request),
    );
  };

  const harness: FetchMockHarness = {
    calls,
    fetch: mockFetch,
    install() {
      if (installedFetch) return;
      installedFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
    },
    reset() {
      calls.length = 0;
      routes.length = 0;
    },
    restore() {
      if (!installedFetch) return;
      globalThis.fetch = installedFetch;
      installedFetch = undefined;
    },
    route(...newRoutes) {
      routes.push(...newRoutes);
      return harness;
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Tool contract runner
// ---------------------------------------------------------------------------

/** Options for {@link runToolContract}. */
export interface RunToolContractOptions {
  /** Context capabilities and identity supplied to the handler. */
  context?: MockContextOptions;
}

/**
 * Executes a tool definition through its public contract boundary.
 *
 * The runner validates input and output schemas, invokes the real handler,
 * applies `format()`, enrichment, and collected content, and converts thrown
 * values to the same dual-surface error envelope used by the production tool
 * pipeline. It intentionally skips transport auth and telemetry.
 */
export async function runToolContract<TDefinition extends AnyToolDefinition>(
  definition: TDefinition,
  input: z.input<TDefinition['input']>,
  options: RunToolContractOptions = {},
): Promise<CallToolResult> {
  const ctx = createMockContext({
    ...options.context,
    ...(definition.errors && { errors: definition.errors }),
  });

  try {
    const validatedInput = definition.input.parse(input);
    const output = await definition.handler(validatedInput, ctx);
    const validatedOutput = definition.output.parse(output) as Record<string, unknown>;

    let content: ContentBlock[];
    try {
      content = definition.format
        ? definition.format(validatedOutput)
        : [{ type: 'text', text: JSON.stringify(validatedOutput, null, 2) }];
    } catch (error) {
      throw new Error(
        `Output formatting failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const collected = getContentBlocks(ctx);
    if (collected.length > 0) content = [...collected, ...content];
    return buildToolSuccessResult(definition, ctx, validatedOutput, content);
  } catch (error) {
    return classifyAndBuildToolErrorResult(error);
  }
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
