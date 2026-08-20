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
  type InputRequiredResult,
  type InputRequiredSpec,
  type InputResponseView,
  inputRequired,
  inputResponse,
  type ServerContext,
  type StandardSchemaV1,
} from '@modelcontextprotocol/server';

import type { ContextInputs } from '@/core/context.js';

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

/**
 * Builds `ctx.requestInput`. Always present — a handler may request input on
 * any transport and either era; whether the round trip is served by the client
 * (2026) or by the SDK's legacy shim (2025) is not the handler's concern.
 */
export function createRequestInput(): (spec: InputRequiredSpec) => never {
  return (spec: InputRequiredSpec): never => {
    throw new InputRequiredSignal(inputRequired(spec));
  };
}

/**
 * Builds the `ctx.inputs` reader over a retried request's `inputResponses`.
 *
 * Values arrive from the client and are never re-validated by the SDK — pass a
 * schema to `accepted()` wherever the content matters.
 */
export function createContextInputs(mcpReq: ServerContext['mcpReq'] | undefined): ContextInputs {
  const responses = mcpReq?.inputResponses;
  const accepted = ((key: string, schema?: StandardSchemaV1) =>
    schema === undefined
      ? acceptedContent(responses, key)
      : acceptedContent(responses, key, schema)) as ContextInputs['accepted'];

  return {
    accepted,
    dropped: mcpReq?.droppedInputResponseKeys ?? [],
    responses,
    state: <T = string>(): T | undefined => mcpReq?.requestState<T>(),
    view: (key: string): InputResponseView => inputResponse(responses, key),
  };
}
