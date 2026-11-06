/**
 * @fileoverview The level a failed call's `Error in <family>:<name>` record is
 * emitted at, shared by the tool and resource handler factories.
 * @module src/mcp-server/failureSeverity
 */

import { CLIENT_CAPABILITY_MISSING_REASON } from '@/mcp-server/inputRequired.js';
import { INVALID_ARGUMENTS_REASON } from '@/mcp-server/tools/utils/arguments/rejection.js';
import { isScopeRefusal } from '@/mcp-server/transports/auth/lib/authUtils.js';
import type { ErrorContract, ErrorContractSeverity } from '@/types-global/errors.js';

/**
 * The two reasons the framework raises itself, both a refusal of the call
 * rather than a fault in this server: `invalid_arguments`, only from the tool
 * schema gate in `parseToolArguments`, and `client_capability_missing`, only
 * from `ctx.requestInput`'s capability gate.
 */
const FRAMEWORK_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  INVALID_ARGUMENTS_REASON,
  CLIENT_CAPABILITY_MISSING_REASON,
]);

/**
 * The level the failure record is emitted at, or `undefined` to keep `error`.
 *
 * A severity the matched `errors[]` entry declares wins (#380). Otherwise one
 * of the framework's own refusals logs at `notice`: a reason in
 * {@link FRAMEWORK_REFUSAL_REASONS} (#567) — a caller's arguments failing the
 * tool's schema, or a client connection that cannot serve an input request —
 * and a scope check's missing-scope refusal (#585), from the inline `auth`
 * check or a handler's `checkScopes`, recognized by the mark those utilities
 * put on it rather than by its `Forbidden` code. Each is routine traffic, and a
 * schema that wrongly rejects valid calls still shows per tool on
 * `mcp.tool.rejections`. Everything else — a plain `Error`, an undeclared
 * reason, an entry with no severity, a missing auth context, a handler's own
 * `forbidden()`, an upstream 403, an output-contract failure — keeps `error`.
 * A cancellation takes `handleError`'s own `info` path whatever this returns.
 * The three framework refusals also log without a stack, whatever level this
 * resolves for them (#651).
 *
 * Resolved here rather than in `ErrorHandler`, which also serves services,
 * prompts, and transports and knows neither the definition nor the schema gate.
 * `reason` is the failure's `data.reason`, as `readErrorData` reads it. The
 * resource factory adds its own `notice` cases where this returns `undefined`.
 */
export function failureSeverity(
  entry: ErrorContract | undefined,
  failure: unknown,
  reason: unknown,
): ErrorContractSeverity | undefined {
  if (entry?.severity !== undefined) return entry.severity;
  if (isScopeRefusal(failure)) return 'notice';
  return typeof reason === 'string' && FRAMEWORK_REFUSAL_REASONS.has(reason) ? 'notice' : undefined;
}
