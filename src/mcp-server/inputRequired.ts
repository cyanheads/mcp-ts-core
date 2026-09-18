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
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr | MCP Multi-Round-Trip Requests}
 * @module src/mcp-server/inputRequired
 */

import {
  acceptedContent,
  type ClientCapabilities,
  type InputRequiredResult,
  type InputRequiredSpec,
  type InputResponseView,
  inputRequired,
  inputResponse,
  type ServerContext,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server';

import type { ContextInputs } from '@/core/context.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

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

/** Narrows an unknown thrown value to the input-required control-flow signal. */
export function isInputRequiredSignal(error: unknown): error is InputRequiredSignal {
  return (
    error instanceof InputRequiredSignal ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { isInputRequiredSignal?: unknown }).isInputRequiredSignal === true)
  );
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
const CLIENT_CAPABILITY_MISSING_REASON = 'client_capability_missing';

/** The client capability one embedded input request needs, as a capability and an optional member. */
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
 * let the return through.
 */
export type InputRequiredGate = (result: InputRequiredResult) => McpError | undefined;

/**
 * Builds the gate for one connection from its declared client capabilities.
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
 * `clientCapabilities()` returning `undefined` is the per-request legacy case:
 * an instance that never saw an `initialize` holds no capability view, so every
 * embedded request is refused, and the message and hint say so.
 */
export function createInputRequiredGate(
  clientCapabilities: () => ClientCapabilities | undefined,
): InputRequiredGate {
  return (result) => {
    const requests = result.inputRequests;
    if (requests === undefined) return;
    const declared = clientCapabilities();
    for (const [key, entry] of Object.entries(requests)) {
      const requirement = capabilityRequirement(entry);
      if (requirement === undefined || isDeclared(requirement, declared)) continue;

      const path = capabilityPath(requirement);
      const method = (entry as { method: string }).method;
      const blind = declared === undefined;
      return new McpError(
        JsonRpcErrorCode.InvalidRequest,
        `Cannot request input '${key}' (${method}): the client on this 2025-era connection did not declare the \`${path}\` capability${
          blind
            ? ' (this request is served per-request, so no client capabilities are available and no server-to-client round trip can be made)'
            : ''
        }`,
        {
          reason: CLIENT_CAPABILITY_MISSING_REASON,
          recovery: {
            hint: blind
              ? `No client capabilities are visible on a per-request connection, so \`${path}\` cannot be requested here. Reconnect over a stateful session whose client declares it, or call again supplying the value this request would have asked for.`
              : `Reconnect with a client that declares the \`${path}\` capability, or call again supplying the value this request would have asked for.`,
          },
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
 */
export function createRequestInput(gate?: InputRequiredGate): (spec: InputRequiredSpec) => never {
  return (spec: InputRequiredSpec): never => {
    const result = inputRequired(spec);
    const refusal = gate?.(result);
    if (refusal !== undefined) throw refusal;
    throw new InputRequiredSignal(result);
  };
}

/**
 * Builds the `ctx.inputs` reader over a retried request's `inputResponses`.
 *
 * Values arrive from the client and are never re-validated by the SDK — pass a
 * schema to `accepted()` wherever the content matters.
 */
export function createContextInputs(mcpReq: ServerContext['mcpReq'] | undefined): ContextInputs {
  return contextInputsFrom(
    mcpReq?.inputResponses,
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
