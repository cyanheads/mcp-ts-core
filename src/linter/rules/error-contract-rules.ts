/**
 * @fileoverview Lint rules for the declarative `errors[]` contract on tool and
 * resource definitions. Validates structure (codes, reasons), uniqueness,
 * and (when a contract is present) cross-checks handler bodies for thrown
 * codes that aren't declared.
 * @module src/linter/rules/error-contract-rules
 */

import { type ErrorContract, JsonRpcErrorCode } from '@/types-global/errors.js';

import type { LintDefinitionType, LintDiagnostic } from '../types.js';
import { stripCommentsAndStrings } from './source-text.js';

/**
 * Set of valid `JsonRpcErrorCode` numeric values, computed once at module load.
 * Used to validate the `code` field on each contract entry.
 */
const VALID_CODES: ReadonlySet<number> = new Set(
  Object.values(JsonRpcErrorCode).filter((v): v is number => typeof v === 'number'),
);

const REASON_RE = /^[a-z][a-z0-9_]*$/;

const RECOVERY_MIN_WORDS = 5;

/**
 * Validates the `errors[]` contract on a tool/resource definition.
 * Checks:
 *   - `errors` is an array
 *   - each entry is an object with required `code`, `reason`, `when`, `recovery`
 *   - `code` is a real `JsonRpcErrorCode` value
 *   - `reason` is snake_case and unique within the contract
 *   - `recovery` is non-empty and ≥ 5 words (forcing function for thoughtful
 *     agent guidance — placeholders like "Try again." get flagged)
 *   - `retryable` (when present) is a boolean
 */
export function lintErrorContract(
  errors: unknown,
  definitionType: LintDefinitionType,
  definitionName: string,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  if (errors === undefined) return diagnostics;

  if (!Array.isArray(errors)) {
    diagnostics.push({
      rule: 'error-contract-type',
      severity: 'error',
      message: `${definitionType} '${definitionName}' has 'errors' but it is not an array.`,
      definitionType,
      definitionName,
    });
    return diagnostics;
  }

  if (errors.length === 0) {
    diagnostics.push({
      rule: 'error-contract-empty',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' declares an empty 'errors: []' contract. ` +
        'An empty contract is a no-op — drop the field entirely, or declare the actual ' +
        'failure modes. Empty contracts give clients no useful failure-surface preview.',
      definitionType,
      definitionName,
    });
    return diagnostics;
  }

  const seenReasons = new Set<string>();

  for (let i = 0; i < errors.length; i++) {
    const entry = errors[i];
    const path = `errors[${i}]`;

    if (typeof entry !== 'object' || entry === null) {
      diagnostics.push({
        rule: 'error-contract-entry-type',
        severity: 'error',
        message: `${definitionType} '${definitionName}' ${path} must be an object with { code, reason, when, recovery }.`,
        definitionType,
        definitionName,
      });
      continue;
    }

    const e = entry as Record<string, unknown>;

    // code
    if (typeof e.code !== 'number') {
      diagnostics.push({
        rule: 'error-contract-code-type',
        severity: 'error',
        message: `${definitionType} '${definitionName}' ${path}.code must be a JsonRpcErrorCode value (number).`,
        definitionType,
        definitionName,
      });
    } else if (!VALID_CODES.has(e.code)) {
      diagnostics.push({
        rule: 'error-contract-code-unknown',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' ${path}.code is ${e.code}, ` +
          'which is not a valid JsonRpcErrorCode. Use the enum import.',
        definitionType,
        definitionName,
      });
    } else if (e.code === JsonRpcErrorCode.UnknownError) {
      // `UnknownError` is the auto-classifier's giveup fallback — it tells
      // clients literally nothing. Declaring it in a contract is meaningless;
      // pick a more specific code (or omit the entry entirely).
      diagnostics.push({
        rule: 'error-contract-code-unknown-error',
        severity: 'warning',
        message:
          `${definitionType} '${definitionName}' ${path}.code is JsonRpcErrorCode.UnknownError. ` +
          "This is the framework's giveup-fallback code — it conveys no useful information " +
          'to clients. Pick a more specific code (e.g. InternalError, ServiceUnavailable) or ' +
          'remove the entry.',
        definitionType,
        definitionName,
      });
    }

    // reason
    if (typeof e.reason !== 'string' || e.reason.length === 0) {
      diagnostics.push({
        rule: 'error-contract-reason-required',
        severity: 'error',
        message: `${definitionType} '${definitionName}' ${path}.reason must be a non-empty string.`,
        definitionType,
        definitionName,
      });
    } else {
      if (!REASON_RE.test(e.reason)) {
        diagnostics.push({
          rule: 'error-contract-reason-format',
          severity: 'warning',
          message:
            `${definitionType} '${definitionName}' ${path}.reason '${e.reason}' should be snake_case ` +
            '(start with a lowercase letter, then lowercase letters/digits/underscores). Treat reasons like API constants.',
          definitionType,
          definitionName,
        });
      }
      if (seenReasons.has(e.reason)) {
        diagnostics.push({
          rule: 'error-contract-reason-unique',
          severity: 'error',
          message: `${definitionType} '${definitionName}' has duplicate reason '${e.reason}' in errors[]. Reasons must be unique within a contract.`,
          definitionType,
          definitionName,
        });
      }
      seenReasons.add(e.reason);
    }

    // when
    if (typeof e.when !== 'string' || e.when.length === 0) {
      diagnostics.push({
        rule: 'error-contract-when-required',
        severity: 'error',
        message: `${definitionType} '${definitionName}' ${path}.when must be a non-empty human-readable description.`,
        definitionType,
        definitionName,
      });
    }

    // recovery
    if (typeof e.recovery !== 'string') {
      diagnostics.push({
        rule: 'error-contract-recovery-required',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' ${path}.recovery must be a non-empty string ` +
          'describing what the agent should do when this failure occurs.',
        definitionType,
        definitionName,
      });
    } else if (e.recovery.trim().length === 0) {
      diagnostics.push({
        rule: 'error-contract-recovery-empty',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' ${path}.recovery is empty. ` +
          'Provide actionable guidance for the agent.',
        definitionType,
        definitionName,
      });
    } else {
      const wordCount = e.recovery.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount < RECOVERY_MIN_WORDS) {
        diagnostics.push({
          rule: 'error-contract-recovery-min-words',
          severity: 'warning',
          message:
            `${definitionType} '${definitionName}' ${path}.recovery has ${wordCount} word(s); ` +
            `minimum is ${RECOVERY_MIN_WORDS}. Specific guidance ("Try X with Y") beats ` +
            'placeholders ("Try again.", "Check input.").',
          definitionType,
          definitionName,
        });
      }
    }

    // retryable (optional)
    if (e.retryable !== undefined && typeof e.retryable !== 'boolean') {
      diagnostics.push({
        rule: 'error-contract-retryable-type',
        severity: 'warning',
        message: `${definitionType} '${definitionName}' ${path}.retryable should be a boolean when present.`,
        definitionType,
        definitionName,
      });
    }
  }

  return diagnostics;
}

/**
 * Map from `JsonRpcErrorCode` enum names → numeric values, computed once.
 * Used by the conformance check to recognize `JsonRpcErrorCode.X` references in
 * handler source.
 */
const CODE_NAME_TO_VALUE: Readonly<Record<string, JsonRpcErrorCode>> = (() => {
  const out: Record<string, JsonRpcErrorCode> = {};
  for (const [name, value] of Object.entries(JsonRpcErrorCode)) {
    if (typeof value === 'number') {
      out[name] = value;
    }
  }
  return out;
})();

/**
 * Map from factory function names → the codes they produce. Used by the
 * conformance check to recognize `notFound(...)` style throws.
 */
const FACTORY_TO_CODE: Readonly<Record<string, JsonRpcErrorCode>> = {
  invalidParams: JsonRpcErrorCode.InvalidParams,
  invalidRequest: JsonRpcErrorCode.InvalidRequest,
  notFound: JsonRpcErrorCode.NotFound,
  forbidden: JsonRpcErrorCode.Forbidden,
  unauthorized: JsonRpcErrorCode.Unauthorized,
  validationError: JsonRpcErrorCode.ValidationError,
  conflict: JsonRpcErrorCode.Conflict,
  rateLimited: JsonRpcErrorCode.RateLimited,
  timeout: JsonRpcErrorCode.Timeout,
  serviceUnavailable: JsonRpcErrorCode.ServiceUnavailable,
  configurationError: JsonRpcErrorCode.ConfigurationError,
  internalError: JsonRpcErrorCode.InternalError,
  serializationError: JsonRpcErrorCode.SerializationError,
  databaseError: JsonRpcErrorCode.DatabaseError,
};

/**
 * Codes that bubble up from anywhere — services, framework utilities,
 * the auto-classifier — and are implicitly always-possible on any tool.
 * The conformance check skips them so the contract can stay focused on
 * the tool's *intentional* failure surface, not exhaustive infrastructure.
 *
 * Modeled after how OpenAPI-driven frameworks treat 5xx: implicit, not
 * required to be enumerated per-endpoint.
 */
const BASELINE_CONFORMANCE_CODES: ReadonlySet<JsonRpcErrorCode> = new Set([
  JsonRpcErrorCode.InternalError,
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.ValidationError,
  JsonRpcErrorCode.SerializationError,
]);

/**
 * Cross-checks a definition's declared `errors[]` contract against the codes
 * that appear textually in its `handler` body. Fires only when a contract is
 * present — definitions without an `errors[]` field are silently skipped.
 *
 * **Two distinct findings:**
 *
 * - `error-contract-conformance` — handler throws a non-baseline code that
 *   isn't in the contract. Suggests adding it to `errors[]`.
 * - `error-contract-prefer-fail` — handler throws a code that IS in the
 *   contract directly (via factory or `new McpError`) instead of via
 *   `ctx.fail(reason, …)`. Encourages routing through the typed helper so
 *   observers see consistent `data.reason` values.
 *
 * **Baseline codes** (`InternalError`, `ServiceUnavailable`, `Timeout`,
 * `ValidationError`, `SerializationError`) are skipped — they bubble from
 * anywhere and don't need to be enumerated per-tool.
 *
 * Heuristic only: scans handler source text for `new McpError(JsonRpcErrorCode.X)`
 * constructions and `throw factory()` calls — comparisons (`=== JsonRpcErrorCode.X`)
 * and `case JsonRpcErrorCode.X:` labels that merely reference a code are not counted.
 * Codes thrown from called services are invisible — so this is always a warning,
 * never an error.
 */
export function lintErrorContractConformance(
  def: { handler?: unknown; errors?: unknown },
  definitionType: LintDefinitionType,
  definitionName: string,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  if (!Array.isArray(def.errors) || def.errors.length === 0) return diagnostics;
  if (typeof def.handler !== 'function') return diagnostics;

  let source: string;
  try {
    source = def.handler.toString();
  } catch {
    return diagnostics;
  }

  // Strip strings/comments so a comment like `// throws NotFound` doesn't pollute.
  const cleaned = stripCommentsAndStrings(source);

  const observed = new Set<JsonRpcErrorCode>();

  // Direct construction: `new McpError(JsonRpcErrorCode.NotFound, …)`. Scoped to
  // the construction site — like the factory scan below, and mirroring the
  // `prefer-error-factory` rule in handler-body-rules.ts — so a `JsonRpcErrorCode.X`
  // reference in a comparison (`err.code === JsonRpcErrorCode.X`) or a `case
  // JsonRpcErrorCode.X:` label is NOT counted as a thrown code.
  for (const m of cleaned.matchAll(/new\s+McpError\s*\(\s*JsonRpcErrorCode\.(\w+)/g)) {
    const value = m[1] ? CODE_NAME_TO_VALUE[m[1]] : undefined;
    if (value !== undefined) observed.add(value);
  }

  // Factory calls: `throw notFound(...)`, `throw serviceUnavailable(...)`
  const factoryRe = new RegExp(
    String.raw`\bthrow\s+(${Object.keys(FACTORY_TO_CODE).join('|')})\s*\(`,
    'g',
  );
  for (const m of cleaned.matchAll(factoryRe)) {
    const code = m[1] ? FACTORY_TO_CODE[m[1]] : undefined;
    if (code !== undefined) observed.add(code);
  }

  // Build code → reason map from the contract so we can suggest the right
  // ctx.fail('reason') call when a declared code is thrown directly.
  const codeToReasons = new Map<JsonRpcErrorCode, string[]>();
  for (const entry of def.errors as ErrorContract[]) {
    if (entry && typeof entry.code === 'number' && typeof entry.reason === 'string') {
      const reasons = codeToReasons.get(entry.code) ?? [];
      reasons.push(entry.reason);
      codeToReasons.set(entry.code, reasons);
    }
  }

  const undeclared: string[] = [];
  const declaredButDirect: { codeName: string; reasons: string[] }[] = [];

  for (const code of observed) {
    if (BASELINE_CONFORMANCE_CODES.has(code)) continue;
    const reasons = codeToReasons.get(code);
    if (reasons && reasons.length > 0) {
      declaredButDirect.push({ codeName: jsonRpcErrorCodeName(code), reasons });
    } else {
      undeclared.push(jsonRpcErrorCodeName(code));
    }
  }

  if (undeclared.length > 0) {
    diagnostics.push({
      rule: 'error-contract-conformance',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' handler throws codes not in errors[]: ` +
        `${undeclared.join(', ')}. Add them to the contract (with a stable reason) so ` +
        '`tools/list` accurately advertises this failure mode. ' +
        'Baseline codes (InternalError, ServiceUnavailable, Timeout, ValidationError, ' +
        'SerializationError) are auto-allowed — only domain-specific codes need declaring.',
      definitionType,
      definitionName,
    });
  }

  for (const entry of declaredButDirect) {
    const reasonHint =
      entry.reasons.length === 1
        ? `'${entry.reasons[0]}'`
        : `one of ${entry.reasons.map((r) => `'${r}'`).join(' / ')}`;
    diagnostics.push({
      rule: 'error-contract-prefer-fail',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' throws ${entry.codeName} directly, but the ` +
        `contract declares this code as reason ${reasonHint}. Consider routing through ` +
        `\`ctx.fail(${reasonHint}, …)\` so observers see consistent \`data.reason\` values ` +
        'and the failure is correlated with the contract entry.',
      definitionType,
      definitionName,
    });
  }

  return diagnostics;
}

/**
 * Returns the enum name for a `JsonRpcErrorCode` value, or `String(code)` when
 * the value is not a known member.
 */
function jsonRpcErrorCodeName(code: JsonRpcErrorCode): string {
  for (const [name, value] of Object.entries(JsonRpcErrorCode)) {
    if (value === code) return name;
  }
  return String(code);
}
