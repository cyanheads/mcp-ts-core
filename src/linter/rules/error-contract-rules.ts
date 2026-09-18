/**
 * @fileoverview Lint rules for the declarative `errors[]` contract on tool and
 * resource definitions. Validates structure (codes, reasons, severity),
 * uniqueness, and — when a contract is present — cross-checks the handler body
 * in both directions: codes thrown but not declared, and reasons declared but
 * never thrown.
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
 * Levels a contract entry's `severity` may declare, mirroring the
 * `ErrorContractSeverity` union. `error` is the default and is expressed by
 * omitting the field, so declaring it is a no-op the author probably did not
 * mean.
 */
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['debug', 'info', 'notice', 'warning']);

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
 *   - `severity` (when present) is one of the four levels below `error`
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

    // severity (optional) — selects a logger method at runtime, so an
    // unrecognized value is a hard failure rather than inert metadata.
    if (e.severity !== undefined && !VALID_SEVERITIES.has(e.severity as string)) {
      diagnostics.push({
        rule: 'error-contract-severity-unknown',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' ${path}.severity is ${JSON.stringify(e.severity)}. ` +
          `Use one of: ${[...VALID_SEVERITIES].join(', ')}. ` +
          'Omit the field for the default `error` level.',
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
  requestCancelled: JsonRpcErrorCode.RequestCancelled,
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
  JsonRpcErrorCode.RequestCancelled,
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
 * `ValidationError`, `SerializationError`, `RequestCancelled`) are skipped —
 * they bubble from anywhere and don't need to be enumerated per-tool.
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
        'SerializationError, RequestCancelled) are auto-allowed — only domain-specific ' +
        'codes need declaring.',
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

// ---------------------------------------------------------------------------
// Literal reason call sites
// ---------------------------------------------------------------------------

/** One literal `ctx.fail('<reason>', …)` (or `ctx.recoveryFor`) call site. */
export interface ReasonCallSite {
  /** Source offset just past the site's closing `)`. */
  end: number;
  /** The reason named by the site's first argument, read from the raw source. */
  reason: string;
  /** Source offset of the site's opening `(`. */
  start: number;
}

/** What {@link scanReasonCalls} found for one callee in a handler's source. */
export interface ReasonCallScan {
  /**
   * True when some call site took a non-literal first argument — a variable, a
   * template literal, a map lookup. The set of reasons in play is then unknown.
   */
  indeterminate: boolean;
  /** Every literal call site found, in source order. */
  sites: ReasonCallSite[];
}

/**
 * Finds every `<callee>('<literal>', …)` site in a handler's source, one record
 * per site.
 *
 * Matching runs over the comment- and string-stripped text, which already
 * excludes a call written inside a comment or nested in another literal. That
 * transform blanks literal *contents* and keeps the quotes, so the reason
 * survives only in the raw source — and it is length-preserving, so the same
 * offsets address both. `tests/unit/linter/source-text.test.ts` asserts that
 * alignment directly, since this rule depends on it.
 *
 * The span is carried so a rule that needs a site's arguments — not just which
 * reason it names — can read them without rescanning.
 */
export function scanReasonCalls(source: string, callee: string): ReasonCallScan {
  const cleaned = stripCommentsAndStrings(source);
  const calleeRe = new RegExp(String.raw`\b${callee.replaceAll('.', '\\.')}\s*\(`, 'g');
  const sites: ReasonCallSite[] = [];
  let indeterminate = false;

  for (const match of cleaned.matchAll(calleeRe)) {
    const open = match.index + match[0].length - 1;
    let cursor = open + 1;
    while (cursor < cleaned.length && /\s/.test(cleaned[cursor] as string)) cursor += 1;

    const quote = cleaned[cursor];
    if (quote !== "'" && quote !== '"') {
      indeterminate = true;
      continue;
    }
    const closingQuote = cleaned.indexOf(quote, cursor + 1);
    const end = matchingParen(cleaned, open);
    if (closingQuote < 0 || end < 0) {
      indeterminate = true;
      continue;
    }
    sites.push({ reason: source.slice(cursor + 1, closingQuote), start: open, end });
  }

  return { indeterminate, sites };
}

/** Offset just past the `)` matching the `(` at `open`, or `-1` when unbalanced. */
function matchingParen(cleaned: string, open: number): number {
  let depth = 0;
  for (let i = open; i < cleaned.length; i += 1) {
    if (cleaned[i] === '(') depth += 1;
    else if (cleaned[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Flags a declared `errors[]` reason that no code path in the handler can
 * produce — the inverse of {@link lintErrorContractConformance}, which only
 * catches codes thrown but not declared.
 *
 * A dead entry compiles, lints clean, and stays in the contract indefinitely;
 * the typed `ctx.fail` union accepts the reason, so nothing downstream objects.
 * The cost lands on the client, which plans for a failure mode the tool cannot
 * produce while the mode it does produce goes undocumented.
 *
 * **Trigger.** Only when the handler holds at least one literal `ctx.fail(`. A
 * handler with none produces its reasons somewhere the scan cannot reach, and
 * firing there would warn on every service-layer definition. A `ctx.fail(` whose
 * first argument is not a string literal makes the thrown set unknowable, so the
 * whole definition is skipped rather than guessed at.
 *
 * **Warning, never error.** A reason produced outside the handler closure is
 * invisible to any `toString()` scan, so the rule can never prove absence.
 * Silent blind spots under the trigger above: a service that throws a factory
 * error carrying `data: { reason }`, a `createFail(errors)` resolver built
 * outside the handler, and an aliased `const fail = ctx.fail`.
 */
export function lintErrorContractUnthrown(
  def: { handler?: unknown; errors?: unknown },
  definitionType: LintDefinitionType,
  definitionName: string,
): LintDiagnostic[] {
  if (!Array.isArray(def.errors) || def.errors.length === 0) return [];
  if (typeof def.handler !== 'function') return [];

  let source: string;
  try {
    source = def.handler.toString();
  } catch {
    return [];
  }

  const failScan = scanReasonCalls(source, 'ctx.fail');
  if (failScan.indeterminate || failScan.sites.length === 0) return [];

  // `ctx.recoveryFor('<reason>')` counts too: it is how a handler opts a
  // service-thrown reason onto the wire, and naming it there is all the scan
  // can ask for.
  const named = new Set(failScan.sites.map((site) => site.reason));
  for (const site of scanReasonCalls(source, 'ctx.recoveryFor').sites) named.add(site.reason);

  const diagnostics: LintDiagnostic[] = [];
  for (const entry of def.errors as ErrorContract[]) {
    const reason = entry?.reason;
    if (typeof reason !== 'string' || reason.length === 0 || named.has(reason)) continue;
    diagnostics.push({
      rule: 'error-contract-unthrown',
      severity: 'warning',
      message:
        `${definitionType} '${definitionName}' declares reason '${reason}' in errors[], but no ` +
        `ctx.fail('${reason}', …) appears in the handler. Wire the throw, or drop the entry — ` +
        'clients plan around the advertised failure surface.',
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
