/**
 * @fileoverview Types for the MCP definition linter.
 * Defines the diagnostic structure, severity levels, and validation report
 * used by all lint rules and the `validateDefinitions` entry point.
 * @module src/linter/types
 */

/** Severity of a lint diagnostic. */
export type LintSeverity = 'error' | 'warning';

/** Definition type that produced a lint diagnostic. */
export type LintDefinitionType = 'tool' | 'resource' | 'prompt' | 'server-json' | 'landing';

/**
 * A single lint diagnostic produced by a validation rule.
 * Errors represent spec violations that will cause runtime failures.
 * Warnings represent SHOULD-level or quality issues.
 */
export interface LintDiagnostic {
  /** Name of the specific definition (tool/resource/prompt name, or 'server.json'). */
  definitionName: string;
  /** Which definition type produced this diagnostic. */
  definitionType: LintDefinitionType;
  /** Human-readable message describing the issue. */
  message: string;
  /** Rule identifier (e.g., 'name-format', 'describe-on-fields'). */
  rule: string;
  /** Severity: 'error' for MUST violations, 'warning' for SHOULD/quality. */
  severity: LintSeverity;
}

/**
 * Result of running `validateDefinitions()`.
 */
export interface LintReport {
  /** All diagnostics with severity 'error'. */
  errors: LintDiagnostic[];
  /** True when zero errors (warnings are acceptable). */
  passed: boolean;
  /** All diagnostics with severity 'warning'. */
  warnings: LintDiagnostic[];
}

/**
 * Input to `validateDefinitions()`.
 * Mirrors the definition arrays from `CreateAppOptions`, plus optional server.json
 * and landing configuration.
 */
export interface LintInput {
  /**
   * Canvas consumer rule (`canvas-consumer-missing`).
   * Additional tool names accepted as canvas consumers — for servers that name their
   * query tool something other than the `*_dataframe_query` default predicate.
   * `false` disables the rule entirely.
   * When omitted, the env var `MCP_LINT_CANVAS_CONSUMERS` is consulted (CSV of tool
   * names; the literal `false` disables). A programmatic value takes precedence.
   */
  canvasConsumers?: ReadonlyArray<string> | false;
  /**
   * Allowlist of JSON Schema `format` values used by the
   * `schema-format-portability` rule. When omitted, the default is OpenAI's
   * nine recognized values (`date-time`, `time`, `date`, `duration`, `email`,
   * `hostname`, `ipv4`, `ipv6`, `uuid`) — the strictest commonly-used target.
   * Pass a different set to widen or narrow the accepted formats.
   */
  formatAllowlist?: ReadonlyArray<string> | ReadonlySet<string>;
  /** Landing page configuration (from `CreateAppOptions.landing`). */
  landing?: unknown;
  /** Parsed package.json — used for cross-validation (version sync). */
  packageJson?: { version?: string };
  /**
   * Cross-vendor portability mode. When set to `'strict'`, opt-in rules
   * (`schema-no-defs`, `schema-dialect-tag`) emit as warnings.
   * Otherwise they don't fire. When omitted, the value defaults to
   * `'strict'` if `MCP_LINT_PORTABILITY=strict` is set in the environment.
   */
  portability?: 'strict';
  prompts?: unknown[];
  resources?: unknown[];
  /** Parsed server.json content. When provided, validated against the MCP server manifest spec. */
  serverJson?: unknown;
  tools?: unknown[];
  /**
   * Truncation-disclosure rule (`capped-list-no-truncation`).
   * Tool names to exempt from the rule.
   * `false` disables the rule entirely.
   * When omitted, the env var `MCP_LINT_TRUNCATION_ALLOWLIST` is consulted (CSV of
   * tool names; the literal `false` disables). A programmatic value takes precedence.
   */
  truncationAllowlist?: ReadonlyArray<string> | false;
}
