/**
 * @fileoverview Unified Context interface for tool and resource handlers.
 * Replaces the split `appContext` (RequestContext) + `sdkContext` (RequestHandlerExtra)
 * pattern with a single object that provides logging, storage, protocol capabilities,
 * and cancellation.
 * @module src/core/context
 */

import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CreateMessageResult,
  ElicitResult,
  ModelPreferences,
  SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape, ZodType, z } from 'zod';

import type { StorageService } from '@/storage/core/StorageService.js';
import {
  type ErrorContract,
  invalidRequest,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';
import type { Logger } from '@/utils/internal/logger.js';
import type { AuthContext, RequestContext } from '@/utils/internal/requestContext.js';

// Re-export AuthContext so consumers can type against it from ./context
export type { AuthContext };

// ---------------------------------------------------------------------------
// Sub-interfaces
// ---------------------------------------------------------------------------

/**
 * Structured logger scoped to the current request.
 * Auto-includes requestId, traceId, tenantId in every log entry.
 */
export interface ContextLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, error?: Error, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  notice(msg: string, data?: Record<string, unknown>): void;
  warning(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Tenant-scoped key-value storage.
 * Delegates to StorageService with the request's tenantId.
 */
export interface ContextState {
  /** Delete a key. */
  delete(key: string): Promise<void>;
  /** Delete multiple keys. Returns the number of keys deleted. */
  deleteMany(keys: string[]): Promise<number>;
  /** Get a value by key. Returns null if not found. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Get a value by key with runtime Zod validation. Returns null if not found. */
  get<T>(key: string, schema: ZodType<T>): Promise<T | null>;
  /** Get multiple values by key. Missing keys are omitted from the result. */
  getMany<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  /** List keys by prefix with pagination. */
  list(
    prefix?: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{
    items: Array<{ key: string; value: unknown }>;
    cursor?: string;
  }>;
  /** Store a value. Accepts any serializable value. */
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  /** Store multiple values. */
  setMany(entries: Map<string, unknown>, opts?: { ttl?: number }): Promise<void>;
}

/**
 * Progress reporting for background tasks.
 * Present only when the tool has `task: true`.
 */
export interface ContextProgress {
  /** Increment completed work by amount (default: 1). */
  increment(amount?: number): Promise<void>;
  /** Set the total expected units of work. */
  setTotal(total: number): Promise<void>;
  /** Set a custom status message. */
  update(message: string): Promise<void>;
}

/** Options for sampling requests. */
export interface SamplingOpts {
  includeContext?: 'none' | 'thisServer' | 'allServers';
  maxTokens?: number;
  modelPreferences?: ModelPreferences;
  stopSequences?: string[];
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The unified object every tool and resource handler receives.
 * Replaces the split `appContext` + `sdkContext` pattern.
 */
export interface Context {
  /** Auth data when request is authenticated. */
  readonly auth?: AuthContext | undefined;

  // --- Protocol capabilities (optional — not all clients support these) ---
  /** Ask the human user a question. Present when client supports elicitation. */
  readonly elicit?:
    | ((message: string, schema: z.ZodObject<z.ZodRawShape>) => Promise<ElicitResult>)
    | undefined;

  // --- Contract-bound resolvers (always present; no-op when no contract) ---
  /**
   * Accumulates agent-facing enrichment fields onto this request — empty-result
   * notices, query/filter echo, pagination totals. Values reach `structuredContent`
   * (merged into the validated output) and `content[]` (a trailer), exactly as the
   * error path surfaces `recovery.hint` across both surfaces. Always present and
   * callable from the handler and the service layer (mirrors `ctx.log`/`ctx.state`);
   * when the tool declares no `enrichment` block the merge is a no-op (values are
   * stripped by the effective-output parse). The strict, typed variant — keyed to
   * the declared fields — lives on `HandlerContext<R, E>`. Field-helpers
   * (`enrich.notice` / `enrich.total` / `enrich.echo`) kind-tag the content[] trailer.
   */
  readonly enrich: Enrich;

  // --- Structured logging ---
  /** Logger scoped to this request. Auto-includes requestId, traceId, tenantId. */
  readonly log: ContextLogger;

  // --- List-changed notifications (capability-gated; present iff advertised) ---
  /** Notify clients that the prompt list has changed (prompts added/removed). */
  readonly notifyPromptListChanged?: (() => void) | undefined;
  /** Notify clients that the resource list has changed (resources added/removed). */
  readonly notifyResourceListChanged?: (() => void) | undefined;
  /** Send a resource-updated notification to subscribed clients. */
  readonly notifyResourceUpdated?: ((uri: string) => void) | undefined;
  /** Notify clients that the tool list has changed (tools added/removed). */
  readonly notifyToolListChanged?: (() => void) | undefined;

  // --- Task progress (present when task: true) ---
  /** Progress reporting for background tasks. Undefined for non-task tools. */
  readonly progress?: ContextProgress | undefined;
  /**
   * Resolves a contract-bound recovery hint by reason and returns it in the
   * canonical wire shape `{ recovery: { hint } }` — safe to spread directly into
   * factory `data` or `ctx.fail`'s data argument:
   *
   * ```ts
   * throw ctx.fail('parse_failed', `Parse error: ${err.message}`, ctx.recoveryFor('parse_failed'));
   * throw validationError('Parse failed', { reason: 'parse_failed', ...ctx.recoveryFor('parse_failed') });
   * ```
   *
   * Returns `{}` when the calling definition has no `errors[]` contract, or the
   * reason isn't declared in it. Always safe to spread — no optional chaining
   * needed at call sites. The strict, typed variant (which guarantees the
   * non-empty return) lives on `HandlerContext<R>` when a contract is declared.
   *
   * Single source of truth pattern: write the recovery once in the contract entry
   * (lint-validated for ≥5 words), reference it everywhere via this resolver.
   * Authors who want runtime-context recovery (interpolating input values, IDs,
   * queue state) override at the throw site as today.
   */
  recoveryFor(reason: string): { recovery: { hint: string } } | Record<string, never>;
  // --- Identity & tracing ---
  /** Unique request ID for log correlation. */
  readonly requestId: string;
  /** Request LLM completion from the client. Present when client supports sampling. */
  readonly sample?:
    | ((messages: SamplingMessage[], opts?: SamplingOpts) => Promise<CreateMessageResult>)
    | undefined;
  /**
   * HTTP session ID — the value of the `Mcp-Session-Id` header (or a
   * server-minted ID for new sessions) when the request carries a durable
   * session. Defined for HTTP in stateful / `auto` session mode; `undefined`
   * for stdio and for stateless HTTP unless the server opts in via
   * `createApp({ context: { exposeStatelessSessionId: true } })`.
   *
   * Use as a discovery / scoping key on top of tenant-keyed `ctx.state` —
   * not as an authorization principal. In `MCP_AUTH_MODE=jwt|oauth`, hijack
   * mismatches are rejected by the SessionStore before the handler runs, so
   * possession here implies the calling identity passed identity binding.
   * Under `MCP_AUTH_MODE=none`, sessions are not identity-bound — possession
   * of the header value is the only authorization, matching the framework's
   * capability-token model.
   */
  readonly sessionId?: string | undefined;

  // --- Cancellation ---
  /** AbortSignal for request cancellation. */
  readonly signal: AbortSignal;
  /** OpenTelemetry span ID (auto-injected). */
  readonly spanId?: string | undefined;

  // --- Tenant-scoped storage ---
  /** Key-value state scoped to the current tenant. Throws if tenantId is missing. */
  readonly state: ContextState;
  /**
   * Tenant ID. Sources, in order:
   *   - JWT `tid` claim — HTTP with `MCP_AUTH_MODE=jwt`/`oauth`
   *   - `'default'` — stdio (any auth mode) or HTTP with `MCP_AUTH_MODE=none`
   *   - `undefined` — HTTP with `jwt`/`oauth` when the token lacks `tid`
   *     (fail-closed: `ctx.state` will throw rather than silently share state)
   */
  readonly tenantId?: string | undefined;
  /** ISO 8601 creation time. */
  readonly timestamp: string;
  /** OpenTelemetry trace ID (auto-injected). */
  readonly traceId?: string | undefined;

  // --- Raw URI (present for resource handlers) ---
  /** The parsed resource URI. Only set in resource handler context. */
  readonly uri?: URL | undefined;
}

// ---------------------------------------------------------------------------
// Typed fail — drives the type-driven error contract
// ---------------------------------------------------------------------------

/**
 * Builds an `McpError` keyed by a contract reason. The reason → code mapping
 * comes from the definition's `errors[]` contract, so the resulting error
 * always carries a code consistent with what was declared.
 *
 * `R` is the union of valid reason strings extracted from the contract.
 * Tools/resources without a contract receive a context that does not include
 * `fail` at all — direct `throw new McpError(...)` is still available.
 *
 * The thrown error's `data.reason` is auto-populated, so observability and the
 * auto-classifier can branch on a stable identifier without parsing message text.
 */
export type TypedFail<R extends string> = (
  reason: R,
  message?: string,
  data?: Record<string, unknown>,
  options?: { cause?: unknown },
) => McpError;

/**
 * Extracts the union of `reason` literal strings from a const tuple of
 * `ErrorContract` entries. Returns `never` when the input is undefined, isn't
 * shaped like a contract, or is the wide `ErrorContract[]` type without literal
 * narrowing (the latter case represents the type-erased `AnyToolDefinition` —
 * collapsing it to `never` keeps factory call sites assignable).
 *
 * Used by `tool()` / `resource()` builders to derive the typed-fail signature
 * from the user's `errors: [...]` declaration. The `const` modifier on the
 * builder's type parameter preserves literal types without requiring `as const`
 * at the call site.
 */
export type ReasonOf<E> = E extends readonly { reason: infer R extends string }[]
  ? string extends R
    ? never
    : R
  : never;

/**
 * Strict, typed contract-resolver signature attached to `HandlerContext<R>`
 * when a definition declares `errors[]`. Tightens the loose `Context.recoveryFor`
 * to:
 *   - `reason` is constrained to the declared union (TS catches typos)
 *   - return is the non-empty wire shape (no fallback `{}` branch)
 *
 * Family of opt-in resolution helpers — future contract-bound fields
 * (`troubleshootingFor`, `userMessageFor`, …) follow the same shape.
 */
export type TypedRecoveryFor<R extends string> = (reason: R) => { recovery: { hint: string } };

// ---------------------------------------------------------------------------
// Enrichment — typed agent-facing context on the success path
// ---------------------------------------------------------------------------

/**
 * Render kind recorded by an `enrich` field-helper, used only to format the
 * `content[]` trailer at hand-written quality:
 *   - `notice` → markdown blockquote
 *   - `total`  → "N total"
 *   - `echo`   → "Query: …"
 *   - `delta`  → "field: before → after" (raw mutation before/after state)
 * Fields populated via the bare `enrich({...})` call carry no kind and render
 * generically (`**key:** value`), optionally customized per-field by the
 * definition's `enrichmentTrailer` (`render`/`label`).
 */
export type EnrichKind = 'notice' | 'total' | 'echo' | 'delta';

/**
 * Per-request enrichment accumulator. Created in `createContext`, populated by
 * `ctx.enrich(...)` during handler/service execution, and read by the tool
 * handler factory after the handler returns to merge into `structuredContent`
 * and render the `content[]` trailer.
 *
 * @internal
 */
export interface EnrichmentStore {
  /** Per-key render kind set by the field-helpers. Absent keys render generically. */
  kinds: Map<string, EnrichKind>;
  /** Accumulated field values, insertion-ordered. Merged into the effective output. */
  values: Record<string, unknown>;
}

/**
 * Convenience field-helpers hanging off `ctx.enrich`. Each writes a
 * conventionally-named field and tags its trailer rendering; use the bare
 * `enrich({...})` call for any other field names.
 */
export interface EnrichHelpers {
  /**
   * Raw before/after observable state for a mutation. Writes `{ before, after }`
   * under `field` (→ `structuredContent`) and renders as "field: before → after"
   * in the `content[]` trailer. Surface raw state and let the agent judge the
   * change against intent — never synthesize a verdict (a shrink may be intended
   * truncation or a bug; only the agent knows). Declare `field` in the
   * `enrichment` block as `z.object({ before, after })` — the linter recognizes
   * the shape, so it needs no custom trailer renderer.
   */
  delta(args: { field: string; before: unknown; after: unknown }): void;
  /** The query as the server actually parsed it. Writes `effectiveQuery`; renders as "Query: …". */
  echo(query: string): void;
  /** Guidance when a result set is empty (or otherwise needs a caveat). Writes `notice`; renders as a blockquote. */
  notice(text: string): void;
  /** Total matches before a limit/pagination was applied. Writes `totalCount`; renders as "N total". */
  total(count: number): void;
}

/**
 * The `ctx.enrich` callable: merge a partial of the declared enrichment fields
 * onto the request (accumulating across calls), plus the kind-tagging
 * {@link EnrichHelpers}. The loose form (`T = Record<string, unknown>`) sits on
 * the base {@link Context} so service-layer code can call it without the tool's
 * type; the strict {@link TypedEnrich} form is attached to `HandlerContext<R, E>`.
 */
export type Enrich<T = Record<string, unknown>> = ((fields: T) => void) & EnrichHelpers;

/**
 * Strict, typed `enrich` attached to `HandlerContext<R, E>` when a tool declares
 * an `enrichment` block. `E` is the declared `ZodRawShape`; `enrich` accepts a
 * `Partial` of the inferred fields so it can be called incrementally — the
 * effective-output parse enforces that required fields end up populated.
 */
export type TypedEnrich<E extends ZodRawShape> = Enrich<Partial<z.infer<ZodObject<E>>>>;

/**
 * Handler context. Two independent contract dimensions narrow the base
 * {@link Context}:
 *   - **Errors.** When `errors[]` is declared, `R` is the reason union and the
 *     handler gains `fail: TypedFail<R>` plus a strict `recoveryFor`. Without a
 *     contract (`R = never`), `recoveryFor` stays the loose always-`{}` resolver
 *     and the handler throws `McpError` directly.
 *   - **Enrichment.** When an `enrichment` block is declared, `E` is its
 *     `ZodRawShape` and `enrich` is typed to a `Partial` of the inferred fields.
 *     Without one (`E = undefined`), `enrich` stays the loose base form.
 *
 * Both dimensions use `Omit`-and-replace rather than intersection: intersecting
 * the loose `Context.recoveryFor(string)` / `enrich(Record)` with their strict
 * variants would create overloads that widen the parameters back, losing the
 * typo-catching and field-typing benefits. Omit-and-replace narrows cleanly.
 */
export type HandlerContext<
  R extends string = never,
  E extends ZodRawShape | undefined = undefined,
> = Omit<Context, 'recoveryFor' | 'enrich'> &
  ([R] extends [never]
    ? { recoveryFor: Context['recoveryFor'] }
    : { fail: TypedFail<R>; recoveryFor: TypedRecoveryFor<R> }) &
  (E extends ZodRawShape ? { enrich: TypedEnrich<E> } : { enrich: Context['enrich'] });

/**
 * @internal
 *
 * Builds a runtime `fail` function for a given contract. Looks up the entry
 * by `reason` and constructs an `McpError` with the declared code, the
 * caller's message (or the contract's `when` text as a fallback), and
 * `data.reason` auto-populated from the contract — *not* from caller-supplied
 * data, which is spread first and then overwritten so the contract reason
 * wins. This keeps `data.reason` a stable observability identifier.
 *
 * **`data.retryable` precedence.** When the contract entry declares `retryable`,
 * it is used as the base default. Caller-supplied `data.retryable` (per-occurrence
 * override) is then spread on top, so a throw site can still override the
 * contract default for that one occurrence. `reason` is always forced last.
 * Only the `retryable` key is injected when the entry actually declares it —
 * entries without the field produce no `retryable` key on `data`.
 *
 * Net effect: `withRetry`'s default predicate receives `data.retryable === false`
 * automatically for any contract entry that declares `retryable: false`, so
 * deterministic failures fail fast without a per-throw-site flag.
 *
 * If the reason isn't in the contract — a JS caller or stale contract slipping
 * past the `TypedFail` type-system guard — `createFail` returns an
 * `McpError(InternalError)` with diagnostic data (`{ reason, declaredReasons }`)
 * rather than throwing, so the call site can `throw` it like any other error.
 */
export function createFail(errors: readonly ErrorContract[]): TypedFail<string> {
  const byReason = new Map<string, ErrorContract>();
  for (const entry of errors) byReason.set(entry.reason, entry);

  return (reason, message, data, options) => {
    const entry = byReason.get(reason);
    if (!entry) {
      // Reason isn't in the contract. The TypedFail type prevents this at
      // compile time, but a JS caller (or a stale contract) can still hit it.
      // Surface the bug clearly rather than silently picking a code.
      return new McpError(
        JsonRpcErrorCode.InternalError,
        `ctx.fail() called with unknown reason '${reason}' — not declared in errors[].`,
        { reason, declaredReasons: [...byReason.keys()] },
        options,
      );
    }
    // Precedence (last write wins):
    //   1. contract `retryable` as base default (only when the entry declares it)
    //   2. caller-supplied `data` (per-occurrence override, spread over the default)
    //   3. contract `reason` forced last (never overridable — observability invariant)
    const retryableBase =
      entry.retryable !== undefined ? { retryable: entry.retryable } : undefined;
    return new McpError(
      entry.code,
      message ?? entry.when,
      { ...retryableBase, ...data, reason },
      options,
    );
  };
}

/**
 * Builds a runtime `recoveryFor` resolver for a given contract. Looks up the
 * entry by `reason` and returns the canonical wire shape `{ recovery: { hint } }`,
 * safe to spread into factory `data` or `ctx.fail`'s data argument.
 *
 * Returns `{}` when the reason isn't declared — at runtime this protects JS
 * callers and stale contracts; at compile time `TypedRecoveryFor<R>` constrains
 * the reason to declared values. The `{}` fallback also keeps the bare-Context
 * resolver (no contract attached) safe to spread without optional chaining.
 *
 * @internal
 */
export function createRecoveryFor(
  errors: readonly ErrorContract[],
): (reason: string) => { recovery: { hint: string } } | Record<string, never> {
  const byReason = new Map<string, ErrorContract>();
  for (const entry of errors) byReason.set(entry.reason, entry);

  return (reason) => {
    const entry = byReason.get(reason);
    if (!entry) return {};
    return { recovery: { hint: entry.recovery } };
  };
}

/**
 * Attaches a typed `fail` and `recoveryFor` helper to `ctx` when the definition
 * declares an error contract. The bare `Context.recoveryFor` (always present
 * via `createContext`) is overwritten with a contract-aware resolver. Used by
 * the tool and resource handler factories so all call sites stay identical.
 *
 * @internal
 */
export function attachTypedFail(
  ctx: Context,
  errors: readonly ErrorContract[] | undefined,
): Context {
  if (!errors || errors.length === 0) return ctx;
  return Object.assign(ctx, {
    fail: createFail(errors),
    recoveryFor: createRecoveryFor(errors),
  });
}

// ---------------------------------------------------------------------------
// Enrichment runtime — accumulator wiring (internal)
// ---------------------------------------------------------------------------

/**
 * Symbol stashing the per-request {@link EnrichmentStore} on a Context. A symbol
 * key keeps it invisible to `JSON.stringify`, `Object.keys`, and consumers — the
 * store is framework plumbing the handler factory reads, never wire data.
 * @internal
 */
const ENRICHMENT_STORE: unique symbol = Symbol('mcp.enrichmentStore');

/** Fresh, empty enrichment accumulator. @internal */
export function createEnrichmentStore(): EnrichmentStore {
  return { values: {}, kinds: new Map() };
}

/**
 * Builds the always-present `ctx.enrich` callable bound to a store. The bare
 * call merges arbitrary fields; the field-helpers write conventional keys and
 * tag their trailer render kind.
 * @internal
 */
export function createEnrich(store: EnrichmentStore): Enrich {
  const enrich = ((fields: Record<string, unknown>): void => {
    Object.assign(store.values, fields);
  }) as Enrich;
  enrich.notice = (text: string): void => {
    store.values.notice = text;
    store.kinds.set('notice', 'notice');
  };
  enrich.total = (count: number): void => {
    store.values.totalCount = count;
    store.kinds.set('totalCount', 'total');
  };
  enrich.echo = (query: string): void => {
    store.values.effectiveQuery = query;
    store.kinds.set('effectiveQuery', 'echo');
  };
  enrich.delta = ({ field, before, after }): void => {
    store.values[field] = { before, after };
    store.kinds.set(field, 'delta');
  };
  return enrich;
}

/** Stashes the store on a Context under the private symbol (non-enumerable). @internal */
export function stashEnrichmentStore(ctx: Context, store: EnrichmentStore): void {
  Object.defineProperty(ctx, ENRICHMENT_STORE, {
    value: store,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * Reads the enrichment store wired by `createContext` (or a test mock). Returns
 * `undefined` when none was stashed — defensive, though every factory-built
 * Context has one.
 * @internal
 */
export function readEnrichmentStore(ctx: Context): EnrichmentStore | undefined {
  return (ctx as { [ENRICHMENT_STORE]?: EnrichmentStore })[ENRICHMENT_STORE];
}

// ---------------------------------------------------------------------------
// Context construction (internal — not part of the public consumer API)
// ---------------------------------------------------------------------------

/** @internal */
export interface ContextDeps {
  appContext: RequestContext;
  elicit?: Context['elicit'];
  logger: Logger;
  notifyPromptListChanged?: Context['notifyPromptListChanged'];
  notifyResourceListChanged?: Context['notifyResourceListChanged'];
  notifyResourceUpdated?: Context['notifyResourceUpdated'];
  notifyToolListChanged?: Context['notifyToolListChanged'];
  sample?: Context['sample'];
  /**
   * HTTP session ID. Forwarded onto `Context.sessionId` as-is. Caller is
   * responsible for the durability gate (stateful mode / opt-in) — by the
   * time it reaches this dep, the decision has been made.
   */
  sessionId?: string | undefined;
  signal: AbortSignal;
  storage: StorageService;
  taskCtx?: { store: RequestTaskStore; taskId: string } | undefined;
  uri?: URL | undefined;
}

/**
 * Constructs a Context from internal dependencies.
 * Called by handler factories — not exposed to consumers.
 * @internal
 */
export function createContext(deps: ContextDeps): Context {
  const { appContext, logger: pinoLogger, storage, signal } = deps;

  // Default tenantId to 'default' when no auth pipeline is expected to populate it:
  //   - stdio: single-client by nature, no auth middleware runs
  //   - HTTP + MCP_AUTH_MODE=none: single-tenant by design (auth=none means
  //     "no identity check, sharing is intentional")
  // Preserves fail-closed for HTTP + jwt/oauth: a token missing the `tid` claim
  // must NOT silently share state across distinct authenticated callers.
  const isStdio = process.env.MCP_TRANSPORT_TYPE?.toLowerCase() !== 'http';
  const isAuthDisabled = (process.env.MCP_AUTH_MODE ?? 'none').toLowerCase() === 'none';
  const effectiveContext = appContext.tenantId
    ? appContext
    : isStdio || isAuthDisabled
      ? { ...appContext, tenantId: 'default' }
      : appContext;

  const log = createContextLogger(pinoLogger, effectiveContext);
  const state = createContextState(storage, effectiveContext, signal);
  const progress = deps.taskCtx
    ? createContextProgress(deps.taskCtx.store, deps.taskCtx.taskId)
    : undefined;

  // Per-request enrichment accumulator + always-present `enrich` (mirrors
  // ctx.log/ctx.state — created here, callable from handler and service layer).
  // Stashed on ctx under a private symbol for the handler factory to read after
  // the handler returns; tools with no `enrichment` block accumulate harmlessly
  // (values are stripped by the effective-output parse).
  const enrichmentStore = createEnrichmentStore();

  const ctx: Context = {
    requestId: effectiveContext.requestId,
    timestamp: effectiveContext.timestamp,
    log,
    state,
    signal,
    tenantId: effectiveContext.tenantId,
    sessionId: deps.sessionId,
    traceId: appContext.traceId as string | undefined,
    spanId: appContext.spanId as string | undefined,
    auth: appContext.auth,
    elicit: deps.elicit,
    sample: deps.sample,
    notifyPromptListChanged: deps.notifyPromptListChanged,
    notifyResourceListChanged: deps.notifyResourceListChanged,
    notifyResourceUpdated: deps.notifyResourceUpdated,
    notifyToolListChanged: deps.notifyToolListChanged,
    progress,
    uri: deps.uri,
    enrich: createEnrich(enrichmentStore),
    // No-op resolver for definitions without a contract. `attachTypedFail`
    // overwrites with a contract-aware resolver when `errors[]` is declared.
    // Always-present so service code can spread `...ctx.recoveryFor('x')`
    // without optional chaining, regardless of whether the calling tool
    // declared a contract.
    recoveryFor: () => ({}),
  };

  stashEnrichmentStore(ctx, enrichmentStore);
  return ctx;
}

// ---------------------------------------------------------------------------
// ContextLogger implementation
// ---------------------------------------------------------------------------

function createContextLogger(appLogger: Logger, appContext: RequestContext): ContextLogger {
  // Build a RequestContext enriched with extra data for each log call.
  // Our Logger accepts (msg, RequestContext?) — the extra data fields are
  // spread into the context's index signature.
  const enriched = (data?: Record<string, unknown>): RequestContext =>
    data ? { ...appContext, ...data } : appContext;

  return {
    debug(msg, data) {
      appLogger.debug(msg, enriched(data));
    },
    info(msg, data) {
      appLogger.info(msg, enriched(data));
    },
    notice(msg, data) {
      appLogger.notice(msg, enriched(data));
    },
    warning(msg, data) {
      appLogger.warning(msg, enriched(data));
    },
    error(msg, error, data) {
      if (error) {
        appLogger.error(msg, error, enriched(data));
      } else {
        appLogger.error(msg, enriched(data));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ContextState implementation
// ---------------------------------------------------------------------------

function createContextState(
  storage: StorageService,
  appContext: RequestContext,
  signal: AbortSignal,
): ContextState {
  const requireContext = (): RequestContext => {
    if (!appContext.tenantId) {
      throw invalidRequest(
        'tenantId required for state operations. With MCP_AUTH_MODE=jwt|oauth, the token must include a "tid" claim. Stdio and HTTP+MCP_AUTH_MODE=none default tenantId to "default" automatically.',
      );
    }
    return appContext;
  };

  return {
    async get(key: string, schema?: ZodType) {
      signal.throwIfAborted();
      const result = await storage.get<unknown>(key, requireContext());
      if (result === null || result === undefined) return null;
      return schema ? schema.parse(result) : result;
    },
    async set(key, value, opts) {
      signal.throwIfAborted();
      await storage.set(
        key,
        value,
        requireContext(),
        opts?.ttl !== undefined ? { ttl: opts.ttl } : undefined,
      );
    },
    async delete(key) {
      signal.throwIfAborted();
      await storage.delete(key, requireContext());
    },
    deleteMany(keys) {
      signal.throwIfAborted();
      return storage.deleteMany(keys, requireContext());
    },
    getMany(keys) {
      signal.throwIfAborted();
      return storage.getMany(keys, requireContext());
    },
    async setMany(entries, opts) {
      signal.throwIfAborted();
      await storage.setMany(
        entries,
        requireContext(),
        opts?.ttl !== undefined ? { ttl: opts.ttl } : undefined,
      );
    },
    async list(prefix, opts) {
      signal.throwIfAborted();
      const ctx = requireContext();
      const listOpts: { cursor?: string; limit?: number } = {};
      if (opts?.cursor) listOpts.cursor = opts.cursor;
      if (opts?.limit !== undefined) listOpts.limit = opts.limit;
      const result = await storage.list(prefix ?? '', ctx, listOpts);

      const keys = result.keys;
      const items: Array<{ key: string; value: unknown }> = [];

      if (keys.length > 0) {
        // Use pre-fetched values when the provider supplies them, otherwise fetch.
        let values: Map<string, unknown>;
        if (result.values) {
          values = result.values;
        } else {
          signal.throwIfAborted();
          values = await storage.getMany<unknown>(keys, ctx);
        }
        for (const key of keys) {
          const value = values.get(key);
          if (value !== undefined) {
            items.push({ key, value });
          }
        }
      }

      const out: { items: Array<{ key: string; value: unknown }>; cursor?: string } = { items };
      if (result.nextCursor) out.cursor = result.nextCursor;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// ContextProgress implementation
// ---------------------------------------------------------------------------

function createContextProgress(store: RequestTaskStore, taskId: string): ContextProgress {
  let total = 0;
  let completed = 0;

  return {
    setTotal(n) {
      total = n;
      completed = 0;
      return Promise.resolve();
    },
    async increment(amount = 1) {
      completed = Math.min(completed + amount, total || completed + amount);
      const percentage = total > 0 ? Math.round((completed / total) * 100) : undefined;
      await store.updateTaskStatus(
        taskId,
        'working',
        percentage !== undefined ? `${percentage}% complete` : undefined,
      );
    },
    async update(message) {
      await store.updateTaskStatus(taskId, 'working', message);
    },
  };
}
