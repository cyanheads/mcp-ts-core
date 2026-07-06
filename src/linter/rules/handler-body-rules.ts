/**
 * @fileoverview Heuristic source-text lint rules that scan the body of a
 * tool/resource handler for common error-handling anti-patterns. These rules
 * are intentionally cautious — false positives are warnings, not errors, and
 * each rule fires at most once per definition to avoid noisy reports.
 * @module src/linter/rules/handler-body-rules
 */

import type { LintDefinitionType, LintDiagnostic } from '../types.js';
import { isDefinitionObject } from './definition-rules.js';
import { stripCommentsAndStrings } from './source-text.js';

/**
 * Map from `JsonRpcErrorCode.X` enum names to their factory function names.
 * Used by `prefer-error-factory` to suggest the right replacement.
 */
const CODE_TO_FACTORY: Readonly<Record<string, string>> = {
  InvalidParams: 'invalidParams',
  InvalidRequest: 'invalidRequest',
  NotFound: 'notFound',
  Forbidden: 'forbidden',
  Unauthorized: 'unauthorized',
  ValidationError: 'validationError',
  Conflict: 'conflict',
  RateLimited: 'rateLimited',
  Timeout: 'timeout',
  ServiceUnavailable: 'serviceUnavailable',
  ConfigurationError: 'configurationError',
  InternalError: 'internalError',
  SerializationError: 'serializationError',
  DatabaseError: 'databaseError',
};

/**
 * Names of factory functions and the `McpError` constructor — used to detect
 * "is this a throw of a structured framework error?" inside a catch block.
 */
const FACTORY_NAMES = Object.values(CODE_TO_FACTORY).join('|');
const STRUCTURED_THROW_RE = new RegExp(
  String.raw`throw\s+(?:new\s+McpError\s*\(|(?:${FACTORY_NAMES})\s*\()`,
);

/**
 * Runs all handler-body lint rules against a tool or resource definition.
 * Operates on `handler.toString()` — heuristic but adequate for catching the
 * common anti-patterns documented in the framework conventions.
 */
export function lintHandlerBody(
  def: { handler?: unknown; name?: string } | null | undefined,
  definitionType: LintDefinitionType,
): LintDiagnostic[] {
  if (!isDefinitionObject(def)) return [];
  const diagnostics: LintDiagnostic[] = [];
  const definitionName = typeof def.name === 'string' && def.name ? def.name : '<unnamed>';

  if (typeof def.handler !== 'function') return diagnostics;

  let source: string;
  try {
    source = def.handler.toString();
  } catch {
    /* Some bound/native functions reject toString — nothing to lint. */
    return diagnostics;
  }

  // Strip line/block comments and string contents so we don't fire on commented-out
  // code or strings containing `throw new Error(`. Best-effort — preserves quote
  // structure but blanks the inner text.
  const cleaned = stripCommentsAndStrings(source);

  // ── Rule 1: prefer-mcp-error-in-handler ──────────────────────────────────
  // Plain `throw new Error(...)` doesn't carry a JSON-RPC code.
  if (/throw\s+new\s+Error\s*\(/.test(cleaned)) {
    diagnostics.push({
      rule: 'prefer-mcp-error-in-handler',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' throws a plain Error. ` +
        'Use McpError or a factory (e.g. notFound(), serviceUnavailable(), serializationError()) ' +
        'so the framework returns a specific JSON-RPC error code instead of the generic InternalError fallback.',
      definitionType,
      definitionName,
    });
  }

  // ── Rule 2: prefer-error-factory ─────────────────────────────────────────
  // `new McpError(JsonRpcErrorCode.X, ...)` when `xFactory(...)` exists is verbose.
  const factoryMatch = /new\s+McpError\s*\(\s*JsonRpcErrorCode\.(\w+)/.exec(cleaned);
  if (factoryMatch) {
    const codeName = factoryMatch[1];
    const factory = codeName ? CODE_TO_FACTORY[codeName] : undefined;
    if (factory) {
      diagnostics.push({
        rule: 'prefer-error-factory',
        severity: 'warning',
        message:
          `${definitionType} '${definitionName}' uses 'new McpError(JsonRpcErrorCode.${codeName}, …)'. ` +
          `Prefer the factory '${factory}(…)' from @cyanheads/mcp-ts-core/errors for consistency and readability.`,
        definitionType,
        definitionName,
      });
    }
  }

  // ── Rule 3: preserve-cause-on-rethrow ────────────────────────────────────
  // For each `catch (E)` block, if it throws a structured error without
  // `{ cause: E }`, the original error chain is lost.
  for (const catchMatch of cleaned.matchAll(/catch\s*\(\s*(\w+)/g)) {
    const errorVar = catchMatch[1];
    if (!errorVar || catchMatch.index === undefined) continue;
    // Bound the scan to the next ~800 chars — enough for a typical block,
    // bounded so a long handler with many `catch` blocks doesn't compound.
    const blockStart = catchMatch.index + catchMatch[0].length;
    const block = cleaned.slice(blockStart, blockStart + 800);
    if (!STRUCTURED_THROW_RE.test(block)) continue;
    // `cause: errorVar` or `cause: e` somewhere in the block satisfies the rule.
    const causeRe = new RegExp(String.raw`cause\s*:\s*${errorVar}\b`);
    if (causeRe.test(block)) continue;
    diagnostics.push({
      rule: 'preserve-cause-on-rethrow',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' wraps caught '${errorVar}' in McpError ` +
        `without { cause: ${errorVar} }. Pass the cause via the 4th constructor arg ` +
        '(or factory options) to preserve the error chain — observability platforms ' +
        'and pino-pretty surface causes automatically.',
      definitionType,
      definitionName,
    });
    break;
  }

  // ── Rule 4: no-stringify-upstream-error ──────────────────────────────────
  // `throw new Error(\`... ${JSON.stringify(upstreamError)} ...\`)` risks leaking
  // raw upstream blobs (stack traces, internal structure) into client-visible messages.
  // Bound the scan length so unrelated calls in long handlers don't trigger false positives.
  if (/throw\s+[^;]{0,400}?JSON\.stringify\s*\(/.test(cleaned)) {
    diagnostics.push({
      rule: 'no-stringify-upstream-error',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' throws a message containing JSON.stringify(...). ` +
        'Stringifying caught or upstream error blobs into the message risks leaking internal ' +
        'traces (e.g., NCBI C++ exceptions, AWS internal ARNs) to clients. Sanitize first, or ' +
        "attach the raw blob to the McpError's 'data' payload — never the message.",
      definitionType,
      definitionName,
    });
  }

  return diagnostics;
}
