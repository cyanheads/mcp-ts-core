/**
 * @fileoverview Shared elicitation plumbing for the tool and resource handler
 * factories.
 * @module src/mcp-server/elicitation
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  ElicitResultSchema,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { toJSONSchema, type ZodObject, type ZodRawShape } from 'zod';

import type { ElicitFn } from '@/core/context.js';
import { invalidParams } from '@/types-global/errors.js';

type SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * The elicitation slice of the tool and resource notifier bundles.
 *
 * `elicitInput` and `getClientCapabilities` are bound at registration time to
 * the per-server `Server` instance so `wrapElicit` can gate `ctx.elicit` on the
 * client's advertised capability and forward elicitation requests on the wire.
 * Both are undefined where no connected client is available (the auto-task
 * background path).
 */
export interface ElicitationNotifiers {
  /** Bound to `server.server.elicitInput.bind(server.server)`. */
  elicitInput?: (params: ElicitRequestFormParams | ElicitRequestURLParams) => Promise<ElicitResult>;
  /** Bound to `server.server.getClientCapabilities.bind(server.server)`. */
  getClientCapabilities?: () => { elicitation?: unknown } | undefined;
  /** Route elicitation through RequestHandlerExtra.sendRequest on per-request servers. */
  requestScopedElicitation?: boolean;
}

/**
 * Validate an accepted elicitation payload against the schema its request
 * advertised.
 *
 * `Server.elicitInput` runs this check itself, but a per-request HTTP server
 * reaches the client through `RequestHandlerExtra.sendRequest` instead and so
 * bypasses it. Raising the SDK's own `InvalidParams` shape here keeps
 * `ctx.elicit`'s failure contract identical on both transports.
 *
 * @param schema - The Zod object the elicitation request was built from.
 * @param content - The `content` of an `accept` response.
 * @throws {McpError} `InvalidParams` when the payload does not satisfy `schema`.
 */
export function assertElicitedContent(schema: ZodObject<ZodRawShape>, content: unknown): void {
  const parsed = schema.safeParse(content);
  if (parsed.success) return;
  throw invalidParams('Elicitation response content does not match the requested schema.', {
    reason: 'elicitation_response_invalid',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
    })),
  });
}

/**
 * Builds `ctx.elicit` from the notifiers bound at registration time.
 *
 * Returns `undefined` when:
 * - `elicitInput` was not bound (auto-task background path, or no server),
 * - the client did not advertise the elicitation capability (checked at
 *   request time, after the initialize handshake populates capabilities).
 *
 * When defined, the returned function is an `ElicitFn`: directly callable for
 * form-mode elicitation (schema converted from ZodObject to the restricted
 * flat JSON Schema the MCP spec requires), plus a `.url(message, url)` helper
 * for URL-mode elicitation (elicitationId generated internally).
 *
 * CRITICAL: `requestedSchema` must be a plain JSON Schema object in the spec's
 * restricted flat form — passing a raw ZodObject causes AJV validation to
 * reject the request on the SDK side. `z.toJSONSchema(schema)` produces the
 * correct shape.
 */
export function wrapElicit(
  notifiers: ElicitationNotifiers,
  sdkContext: SdkExtra,
): ElicitFn | undefined {
  const { elicitInput, getClientCapabilities } = notifiers;
  if (typeof elicitInput !== 'function') return;

  // Capability check runs at request time (not registration time) so that
  // capabilities populated during the initialize handshake are visible.
  if (!getClientCapabilities?.()?.elicitation) return;

  const send = (
    params: ElicitRequestFormParams | ElicitRequestURLParams,
  ): Promise<ElicitResult> => {
    if (!notifiers.requestScopedElicitation) return elicitInput(params);
    return sdkContext.sendRequest({ method: 'elicitation/create', params }, ElicitResultSchema);
  };

  const formFn = async (msg: string, schema: ZodObject<ZodRawShape>): Promise<ElicitResult> => {
    const requestedSchema = toJSONSchema(schema) as ElicitRequestFormParams['requestedSchema'];
    const result = await send({ mode: 'form', message: msg, requestedSchema });
    if (notifiers.requestScopedElicitation && result.action === 'accept' && result.content) {
      assertElicitedContent(schema, result.content);
    }
    return result;
  };

  const urlFn = (msg: string, url: string): Promise<ElicitResult> => {
    const elicitationId = crypto.randomUUID();
    return send({ mode: 'url', message: msg, elicitationId, url });
  };

  const elicitFn = formFn as ElicitFn;
  elicitFn.url = urlFn;
  return elicitFn;
}
