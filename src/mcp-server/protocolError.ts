/**
 * @fileoverview The SDK `ProtocolError` a tool, prompt, or resource handler
 * throws, as the handler factories answer it: converted to the `McpError` it
 * stands for, or, for a URL elicitation, handed back to the SDK.
 * @module src/mcp-server/protocolError
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { type JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import {
  copyFields,
  errorText,
  isInstance,
  readField,
  readWireErrorData,
  UNREADABLE,
} from '@/utils/internal/error-handler/helpers.js';

/**
 * The thrown URL-elicitation errors {@link fromProtocolError} converted: the
 * `cause` of every failure {@link urlElicitationHandback} hands back. Held by
 * identity, so an `McpError` a handler builds with `-32042` itself stays an
 * ordinary failure.
 */
const urlElicitations = new WeakSet<object>();

/**
 * An SDK `ProtocolError` (`ResourceNotFoundError`, `UrlElicitationRequiredError`,
 * …) as an `McpError` with its `code`, `message`, and object `data`, so a call
 * answers with the error the handler stated, as it does for an `McpError`: a
 * `ResourceNotFoundError` from a resource read reaches the client exactly as
 * the SDK's own miss does. `data` that is not a plain object is left off, since
 * an `McpError` carries a record. Matched with the SDK's brand-checked
 * `instanceof`, so a copy built by `@modelcontextprotocol/client` counts. The
 * result keeps the thrown error's stack — or none when it cannot be read, so a
 * record written from it never starts in a factory — and takes the thrown
 * error as its `cause`.
 *
 * Applied inside each factory's measured region, ahead of the cancellation
 * check, so the completion record and the span carry the converted code.
 * Every other value is returned as is — an `SdkError` included, which the
 * classifier maps — and so is a `ProtocolError` whose `code` cannot be read or
 * is not an integer the SDK would write. Never throws on the thrown error (#697).
 */
export function fromProtocolError(error: unknown): unknown {
  if (!isInstance(error, ProtocolError)) return error;
  const code = readField(error, 'code');
  if (!Number.isSafeInteger(code)) return error;
  const data = readField(error, 'data');
  const converted = new McpError(
    code as JsonRpcErrorCode,
    errorText(readField(error, 'message')),
    typeof data === 'object' && data !== null && !isInstance(data, Array)
      ? copyFields(data as Record<string, unknown>)
      : undefined,
    { cause: error },
  );
  const stack = readField(error, 'stack');
  if (typeof stack === 'string' && stack !== UNREADABLE) converted.stack = stack;
  else delete converted.stack;
  if (code === ProtocolErrorCode.UrlElicitationRequired) urlElicitations.add(error);
  return converted;
}

/**
 * The `ProtocolError` a factory hands the SDK in place of its own error when
 * `failure` stands for a thrown URL elicitation (`-32042`, converted by
 * {@link fromProtocolError}): its code, message, and `data`, every field one
 * the wire carries, plus `requestId` when given. The SDK applies its era rule
 * only to a `ProtocolError`: a 2025-era client receives the `-32042` and its
 * `elicitations`, and a 2026-07-28 client the SDK's `-32603` naming
 * `inputRequired.elicitUrl`, a tool call included, rather than an `isError`
 * result no client decodes. Without `requestId` a thrown `data.requestId` is
 * left off, as `runToolContract`'s results leave it.
 *
 * `undefined` for every other failure — a cancellation that outranked the
 * elicitation, and an `McpError` built with `-32042`, included.
 */
export function urlElicitationHandback(
  failure: unknown,
  requestId?: string,
): ProtocolError | undefined {
  if (
    !isInstance(failure, McpError) ||
    !urlElicitations.has(readField(failure, 'cause') as object)
  ) {
    return;
  }
  const { requestId: _thrown, ...data } = readWireErrorData(failure) ?? {};
  const wireData = requestId === undefined ? data : { ...data, requestId };
  return new ProtocolError(
    failure.code,
    failure.message,
    Object.keys(wireData).length > 0 ? wireData : undefined,
  );
}
