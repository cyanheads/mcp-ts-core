/**
 * @fileoverview Multi-round-trip input plumbing shared by the tool, resource,
 * and prompt handler factories (MCP protocol revision 2026-07-28).
 *
 * The 2025 push model — `await ctx.elicit(...)` mid-handler over a
 * server-to-client request — has no channel on the 2026-07-28 wire. A handler
 * now *returns* `inputRequired(...)` and is re-entered with the collected
 * `inputResponses`. Framework handlers are pure functions returning a domain
 * output, so the return path is expressed as a thrown {@link InputRequiredSignal}
 * that each handler factory catches and converts back into the SDK's
 * `input_required` result.
 *
 * One surface serves both eras: the SDK's legacy shim
 * (`ServerOptions.inputRequired.legacyShim`, on by default) fulfils the same
 * returns against 2025-era clients by issuing real `elicitation/create` /
 * `sampling/createMessage` / `roots/list` requests and re-entering the handler.
 *
 * What a handler reads back is bounded by what its client declared: the
 * per-request capability view (#580) decides which responses reach
 * `ctx.inputs` (#496), and an opt-in key seals the `requestState` a handler
 * returns so a retry can only echo what this server minted.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr | MCP Multi-Round-Trip Requests}
 * @module src/mcp-server/inputRequired
 */

import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  createRequestStateCodec,
  type InputRequiredResult,
  type InputResponses,
  type InputResponseView,
  inputRequired,
  inputResponse,
  type McpServer,
  type ServerContext,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server';

import type { ContextInputs, RequestInputFn } from '@/core/context.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import {
  configurationError,
  internalError,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';

/**
 * Thrown by `ctx.requestInput(...)` and caught by the handler factories, which
 * return the carried `input_required` result to the SDK instead of a normal
 * tool/resource/prompt result.
 *
 * Not an {@link McpError}: it is protocol control flow, not a failure, and must
 * bypass the error classifier entirely.
 */
export class InputRequiredSignal extends Error {
  /** Brand for `instanceof`-free detection across bundling boundaries. */
  readonly isInputRequiredSignal = true as const;

  constructor(readonly result: InputRequiredResult) {
    super('Handler requires additional input before it can complete.');
    this.name = 'InputRequiredSignal';
  }
}

/**
 * Narrows an unknown thrown value to the input-required control-flow signal.
 * Never throws: a value it cannot inspect — a revoked `Proxy`, a brand getter
 * that throws — is no signal, so it fails as what it is (#697).
 */
export function isInputRequiredSignal(error: unknown): error is InputRequiredSignal {
  try {
    return (
      error instanceof InputRequiredSignal ||
      (typeof error === 'object' &&
        error !== null &&
        (error as { isInputRequiredSignal?: unknown }).isInputRequiredSignal === true)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Client-capability view (#580)
// ---------------------------------------------------------------------------

/**
 * What one server instance can see of its client's declared capabilities,
 * resolved per request. One view is built per instance, from the era the
 * instance serves — never from whether a request happens to carry an envelope
 * key, since the SDK lifts reserved `_meta` keys off 2025-era messages too.
 *
 * `ctx.clientCapabilities`, the 2025-era refusal `ctx.requestInput` raises
 * (#379), and the filter over `ctx.inputs` (#496) all read the one value this
 * resolves for a request, so the three can never disagree.
 */
export interface ClientCapabilityView {
  /**
   * The capabilities the request's client declared: `{}` when it declared
   * none, `undefined` when the instance holds no view at all — a 2025-era
   * request served per-request, whose instance never processed `initialize`.
   */
  capabilities(mcpReq: ServerContext['mcpReq'] | undefined): ClientCapabilities | undefined;
  /**
   * The era the instance serves. Only a `legacy` instance gates
   * `ctx.requestInput` in the framework; a `modern` one is gated by the SDK
   * after the handler returns (`-32021`).
   */
  readonly era: 'legacy' | 'modern';
}

/**
 * The view for one instance: on a 2025-era instance the `initialize`-declared
 * value, read through the instance on every call so an `initialize` that lands
 * after registration is seen; on a 2026-07-28 instance the request's own
 * `io.modelcontextprotocol/clientCapabilities` envelope key, which the SDK has
 * validated before dispatch. `getClientCapabilities()` is not used there — a
 * 2026-07-28 stdio instance never has it backfilled.
 */
export function clientCapabilityView(
  era: 'legacy' | 'modern',
  server: McpServer,
): ClientCapabilityView {
  if (era === 'modern') {
    return {
      era,
      capabilities: (mcpReq) =>
        (mcpReq?.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as
          | ClientCapabilities
          | undefined,
    };
  }
  return { era, capabilities: () => server.server.getClientCapabilities() };
}

// ---------------------------------------------------------------------------
// Client-capability gate (#379)
// ---------------------------------------------------------------------------

/**
 * The framework-owned `data.reason` on an input request this connection cannot
 * serve. It joins `invalid_arguments` as a reserved reason: a definition cannot
 * declare it in `errors[]`, because it names a property of the connection
 * rather than a domain outcome.
 */
export const CLIENT_CAPABILITY_MISSING_REASON = 'client_capability_missing';

/**
 * The client capability one embedded input request — or the response that
 * answers one — needs, as a capability and an optional member.
 */
interface CapabilityRequirement {
  capability: 'elicitation' | 'roots' | 'sampling';
  member?: 'form' | 'tools' | 'url';
}

/**
 * What an embedded request kind requires, mode-aware where the capability is:
 * URL-mode elicitation needs `elicitation.url`, form-mode (or mode-omitted)
 * needs `elicitation.form`, and a sampling request carrying `tools` /
 * `toolChoice` needs `sampling.tools`.
 *
 * `undefined` for an entry that is not an embedded input-request kind at all —
 * a server bug the SDK raises its own error for, not a capability question.
 */
function capabilityRequirement(entry: unknown): CapabilityRequirement | undefined {
  const request = entry as { method?: unknown; params?: Record<string, unknown> } | null;
  const params = request?.params;
  switch (request?.method) {
    case 'elicitation/create':
      return { capability: 'elicitation', member: params?.mode === 'url' ? 'url' : 'form' };
    case 'sampling/createMessage':
      return params?.tools !== undefined || params?.toolChoice !== undefined
        ? { capability: 'sampling', member: 'tools' }
        : { capability: 'sampling' };
    case 'roots/list':
      return { capability: 'roots' };
    default:
      return undefined;
  }
}

/**
 * Whether the connection's declared capabilities cover `requirement`. A bare
 * `elicitation: {}` — the pre-mode (2025) declaration — counts as declaring
 * `elicitation.form`, matching how the SDK reads it.
 */
function isDeclared(
  requirement: CapabilityRequirement,
  declared: ClientCapabilities | undefined,
): boolean {
  const value = declared?.[requirement.capability] as Record<string, unknown> | undefined;
  if (value === undefined) return false;
  if (requirement.member === undefined) return true;
  if (value[requirement.member] !== undefined) return true;
  return (
    requirement.capability === 'elicitation' &&
    requirement.member === 'form' &&
    value.form === undefined &&
    value.url === undefined
  );
}

/** `elicitation.form`, `sampling.tools`, `roots`. */
function capabilityPath({ capability, member }: CapabilityRequirement): string {
  return member === undefined ? capability : `${capability}.${member}`;
}

/**
 * Decides whether a handler's `input_required` return can be served on this
 * connection: the `McpError` the caller receives instead, or `undefined` to
 * let the return through. `fallbackHint` is the handler's per-call
 * `RequestInputOptions.fallbackHint`, appended to the refusal's hint.
 */
export type InputRequiredGate = (
  result: InputRequiredResult,
  fallbackHint?: string,
) => McpError | undefined;

/**
 * Builds the gate for one request from the capabilities its client declared —
 * the value the instance's {@link ClientCapabilityView} resolved, which
 * `ctx.clientCapabilities` carries too.
 *
 * Only the 2025-era arm needs it. There the refusal is produced by the SDK's
 * legacy shim, which runs *above* the handler callback on the result that
 * callback already returned — the handler factories' catch is off the stack by
 * then, so the failure cannot be shaped where it is produced and arrives as a
 * bare `isError` text block with no error envelope at all. Checking before the
 * signal is returned is the reachable seam, and it keeps the timing: the
 * refusal still precedes any wire traffic. A 2026-07-28 instance is gated by
 * the SDK itself, which raises `MissingRequiredClientCapabilityError`
 * (`-32021`) — that arm takes no gate.
 *
 * `declared` being `undefined` is the per-request legacy case: an instance that
 * never saw an `initialize` holds no capability view, so every embedded
 * request is refused, and the message and hint say so.
 *
 * The hint ends at reconnecting (#495). Whether the caller could instead
 * supply the answer as an argument is the handler's knowledge, not the gate's:
 * a consent gate deliberately has no such field, so the gate appends a
 * fallback only when the handler passed one.
 */
export function createInputRequiredGate(
  declared: ClientCapabilities | undefined,
): InputRequiredGate {
  return (result, fallbackHint) => {
    const requests = result.inputRequests;
    if (requests === undefined) return;
    for (const [key, entry] of Object.entries(requests)) {
      const requirement = capabilityRequirement(entry);
      if (requirement === undefined || isDeclared(requirement, declared)) continue;

      const path = capabilityPath(requirement);
      const method = (entry as { method: string }).method;
      const blind = declared === undefined;
      const reconnect = blind
        ? `No client capabilities are visible on a per-request connection, so \`${path}\` cannot be requested here. Reconnect over a stateful session whose client declares it.`
        : `Reconnect with a client that declares the \`${path}\` capability.`;
      return new McpError(
        JsonRpcErrorCode.InvalidRequest,
        `Cannot request input '${key}' (${method}): the client on this 2025-era connection did not declare the \`${path}\` capability${
          blind
            ? ' (this request is served per-request, so no client capabilities are available and no server-to-client round trip can be made)'
            : ''
        }`,
        {
          reason: CLIENT_CAPABILITY_MISSING_REASON,
          recovery: { hint: fallbackHint ? `${reconnect} ${fallbackHint}` : reconnect },
        },
      );
    }
    return;
  };
}

/**
 * Builds `ctx.requestInput`. Always present — a handler may request input on
 * any transport and either era; whether the round trip is served by the client
 * (2026) or by the SDK's legacy shim (2025) is not the handler's concern.
 *
 * `gate` is the connection's capability check (#379). It runs here, at the
 * point the signal is created and while the handler is still on the stack, so
 * a refusal leaves the handler as an ordinary thrown `McpError`: the execution
 * measurement records it as the failed call it is, and each family's existing
 * error path shapes it. Resolving it any later — in a factory's catch, after
 * the measured region has closed — would record a refused call as a successful
 * input-required round while the client is told the call failed.
 *
 * `options.fallbackHint` goes to the gate alone; it never enters the
 * `input_required` result.
 */
export function createRequestInput(gate?: InputRequiredGate): RequestInputFn {
  return (spec, options) => {
    const result = inputRequired(spec);
    const refusal = gate?.(result, options?.fallbackHint);
    if (refusal !== undefined) throw refusal;
    throw new InputRequiredSignal(result);
  };
}

// ---------------------------------------------------------------------------
// ctx.inputs — responses filtered by declared capability (#496)
// ---------------------------------------------------------------------------

/** Content block types only a tool-enabled sampling result carries. */
const TOOL_BLOCK_TYPES: ReadonlySet<unknown> = new Set(['tool_use', 'tool_result']);

/** Whether sampling content — one block or an array — holds a tool block. */
function carriesToolBlock(content: unknown): boolean {
  return (Array.isArray(content) ? content : [content]).some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      TOOL_BLOCK_TYPES.has((block as { type?: unknown }).type),
  );
}

/**
 * What one response requires — the response-side twin of
 * {@link capabilityRequirement}, so an answer needs whatever the request it
 * answers would have needed. An elicit result carrying `content` is a
 * form-mode answer and needs `elicitation.form`; one without (a URL-mode
 * accept, a decline, a cancel) needs `elicitation` in any mode. A sampling
 * result holding a `tool_use` or `tool_result` block answers a tool-enabled
 * request and needs `sampling.tools`; any other needs `sampling`. A roots
 * result needs `roots`. `undefined` for an entry the SDK's classifier reads as
 * no kind.
 *
 * `content` is read off the raw `entry`, not the view: the view keeps it only
 * when it is an object, while `ctx.inputs.responses` exposes the entry as sent.
 */
function responseRequirement(
  view: InputResponseView,
  entry: unknown,
): CapabilityRequirement | undefined {
  switch (view.kind) {
    case 'elicit':
      return (entry as { content?: unknown }).content === undefined
        ? { capability: 'elicitation' }
        : { capability: 'elicitation', member: 'form' };
    case 'sampling':
      return carriesToolBlock(view.result.content)
        ? { capability: 'sampling', member: 'tools' }
        : { capability: 'sampling' };
    case 'roots':
      return { capability: 'roots' };
    default:
      return;
  }
}

/**
 * The entries of `responses` the client's declared capabilities cover, at the
 * same mode level the gate applies to requests ({@link responseRequirement},
 * {@link isDeclared}), or `undefined` when none survives.
 *
 * The SDK lifts `inputResponses` off every client request, a first call and a
 * 2025-era request included, so a client can arrive pre-answered with no
 * `input_required` result ever sent. An answer the client's modes do not cover
 * cannot have come from a round this server asked for: on the 2025 arm the
 * legacy shim only issues requests the connection declared, and on 2026-07-28
 * the SDK refuses an embedded request the envelope does not cover. Dropping
 * those closes the pre-answered consent-gate bypass — a URL-only client's form
 * answer included — without touching a legitimate round. With no view
 * (`declared` undefined) nothing survives, and an entry the SDK's classifier
 * cannot read as any kind has no capability to justify it either.
 */
export function declaredResponses(
  responses: InputResponses | Record<string, unknown> | undefined,
  declared: ClientCapabilities | undefined,
): Record<string, unknown> | undefined {
  if (responses === undefined || declared === undefined) return;
  const kept = Object.entries(responses).filter(([key, entry]) => {
    const requirement = responseRequirement(inputResponse(responses, key), entry);
    return requirement !== undefined && isDeclared(requirement, declared);
  });
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Builds the `ctx.inputs` reader over a retried request's `inputResponses`,
 * keeping only the answers `declared` covers ({@link declaredResponses}).
 *
 * Values arrive from the client and are never re-validated by the SDK — pass a
 * schema to `accepted()` wherever the content matters.
 */
export function createContextInputs(
  mcpReq: ServerContext['mcpReq'] | undefined,
  declared: ClientCapabilities | undefined,
): ContextInputs {
  return contextInputsFrom(
    declaredResponses(mcpReq?.inputResponses, declared),
    mcpReq?.droppedInputResponseKeys ?? [],
    <T = string>(): T | undefined => mcpReq?.requestState<T>(),
  );
}

/**
 * The `ctx.inputs` reader over an explicit set of responses — what
 * {@link createContextInputs} builds from the SDK request, and what the test
 * kit builds from seeded `inputResponses` / `requestState`.
 */
export function contextInputsFrom(
  responses: Parameters<typeof acceptedContent>[0],
  dropped: string[],
  state: ContextInputs['state'],
): ContextInputs {
  const accepted = ((key: string, schema?: StandardSchemaV1) =>
    schema === undefined
      ? acceptedContent(responses, key)
      : acceptedContent(responses, key, schema)) as ContextInputs['accepted'];

  return {
    accepted,
    dropped,
    responses,
    state,
    view: (key: string): InputResponseView => inputResponse(responses, key),
  };
}

// ---------------------------------------------------------------------------
// requestState sealing (MCP_REQUEST_STATE_KEY)
// ---------------------------------------------------------------------------

/**
 * How long a sealed `requestState` verifies, in seconds. Longer than the SDK
 * legacy shim's 600 s per-round timeout, so a 2025-era round the shim holds
 * open never outlives its own state; the codec's 600 s default leaves no
 * margin.
 */
const REQUEST_STATE_TTL_SECONDS = 900;

/** The shortest key the SDK codec accepts, in UTF-8 bytes. */
const REQUEST_STATE_KEY_MIN_BYTES = 32;

/**
 * Seals the `requestState` handlers return and verifies it when a retry
 * echoes it back. Built once per process from `MCP_REQUEST_STATE_KEY`; the
 * handler factories seal each input-required signal through
 * {@link sealSignal}, and every `McpServer` gets
 * {@link RequestStateSealer.verify} as `ServerOptions.requestState.verify`.
 */
export interface RequestStateSealer {
  /**
   * The `input_required` result a factory returns, its string `requestState`
   * minted into the codec's signed envelope, bound to the request's
   * authenticated principal. A result carrying no state is returned as is.
   */
  seal(result: InputRequiredResult, ctx: ServerContext): Promise<InputRequiredResult>;
  /**
   * Resolves with the handler's original string, or throws — a forged,
   * tampered, expired, other-principal, or other-key state. The SDK answers a
   * throw as `-32602` with `data.reason: 'invalid_request_state'` before the
   * handler runs, and reports only the codec's opaque reason to `onerror`.
   */
  verify(state: string, ctx: ServerContext): Promise<unknown>;
}

/**
 * The principal a sealed state is bound to: the request's authenticated
 * `clientId`, `subject`, and `tenantId`, each empty when absent — as they all
 * are on stdio and under `MCP_AUTH_MODE=none`. The codec stores an HMAC tag of
 * it, never the value.
 */
function principalOf(ctx: ServerContext): string {
  const auth = ctx.http?.authInfo as AuthInfo | undefined;
  return JSON.stringify([auth?.clientId ?? '', auth?.subject ?? '', auth?.tenantId ?? '']);
}

/**
 * The process's sealer, or `undefined` when no key is configured — in which
 * case nothing reaches the SDK and handlers read the raw wire string, exactly
 * as before the option existed. There is deliberately no per-process random
 * key: a 2026-07-28 retry can land on another instance or outlive a restart,
 * and every instance that may receive an echoed state needs the same key.
 *
 * @throws {McpError} `ConfigurationError` naming `MCP_REQUEST_STATE_KEY` when
 *   the key is shorter than 32 UTF-8 bytes. The key itself is never included.
 */
export function createRequestStateSealer(key: string | undefined): RequestStateSealer | undefined {
  if (key === undefined) return;
  if (new TextEncoder().encode(key).byteLength < REQUEST_STATE_KEY_MIN_BYTES) {
    throw configurationError(
      `MCP_REQUEST_STATE_KEY must be at least ${REQUEST_STATE_KEY_MIN_BYTES} bytes. Set a longer random secret, shared by every instance that serves this server, or unset it.`,
      { variable: 'MCP_REQUEST_STATE_KEY', minimumBytes: REQUEST_STATE_KEY_MIN_BYTES },
    );
  }
  const codec = createRequestStateCodec<string>({
    key,
    ttlSeconds: REQUEST_STATE_TTL_SECONDS,
    bind: principalOf,
  });
  return {
    async seal(result, ctx) {
      if (typeof result.requestState !== 'string') return result;
      return { ...result, requestState: await codec.mint(result.requestState, ctx) };
    },
    verify: (state, ctx) => codec.verify(state, ctx),
  };
}

/**
 * What a handler factory rethrows for the input-required signal its handler
 * threw: the signal carrying its `requestState` sealed when `sealer` is
 * configured, else the signal unchanged.
 *
 * The factories call it inside the measured region, where the signal is
 * rethrown, and only for a value {@link isInputRequiredSignal} accepts: any
 * other thrown value is rethrown as is, never resolved through an `await`,
 * which would read its `then` — and a revoked `Proxy`, or a `then` getter that
 * throws, would then replace it with that read's own error (#697).
 *
 * Minting can reject — WebCrypto failing, or no request context for the
 * principal binding — and a rejection there would escape the factory with no
 * error envelope, no failure record, and no request id. It resolves to an
 * `InternalError` instead, so the call fails through the family's ordinary
 * error path; the codec's error rides as `cause` into the server log only, and
 * no part of the key reaches it.
 */
export async function sealSignal(
  signal: InputRequiredSignal,
  sealer: RequestStateSealer | undefined,
  ctx: ServerContext,
): Promise<InputRequiredSignal | McpError> {
  if (sealer === undefined) return signal;
  try {
    return new InputRequiredSignal(await sealer.seal(signal.result, ctx));
  } catch (error) {
    return internalError(
      'Could not seal the requestState of an input_required result.',
      undefined,
      { cause: error },
    );
  }
}
