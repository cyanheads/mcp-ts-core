/**
 * @fileoverview Core validation engine for MCP definitions.
 * Runs all lint rules against tool, resource, and prompt definitions
 * and produces a structured `LintReport`.
 * @module src/linter/validate
 */

import { lintCappedListTruncation, type TruncationOptions } from './rules/enrichment-rules.js';
import { lintLandingConfig } from './rules/landing-rules.js';
import { checkDuplicateNames } from './rules/name-rules.js';
import { DEFAULT_FORMAT_ALLOWLIST, type PortabilityOptions } from './rules/portability-rules.js';
import { lintPromptDefinition } from './rules/prompt-rules.js';
import { lintResourceDefinition } from './rules/resource-rules.js';
import { lintServerJson } from './rules/server-json-rules.js';
import {
  type CanvasOptions,
  lintAppToolResourcePairing,
  lintCanvasConsumerPairing,
  lintToolDefinition,
} from './rules/tool-rules.js';
import type { LintDiagnostic, LintInput, LintReport } from './types.js';

/** Where the rule reference lives. Appended to every diagnostic message. */
const SKILL_REFERENCE_PATH = 'skills/api-linter/SKILL.md';

/**
 * Maps a rule ID to its anchor in the api-linter skill doc. Most rules have
 * a per-rule sub-header whose auto-generated anchor matches the rule ID. The
 * server.json family (~40 rules) is documented in a single tabular section,
 * so every `server-json-*` rule points to that section.
 */
function ruleAnchor(rule: string): string {
  return rule.startsWith('server-json-') ? 'server-json-rules' : rule;
}

/**
 * Resolves portability options: explicit `input.portability` wins, otherwise
 * the `MCP_LINT_PORTABILITY=strict` env var promotes opt-in rules. The format
 * allowlist falls back to the default (OpenAI's nine) when not provided.
 */
function resolvePortabilityOptions(input: LintInput): PortabilityOptions {
  const portability: 'strict' | undefined =
    input.portability ??
    (typeof process !== 'undefined' && process.env?.MCP_LINT_PORTABILITY === 'strict'
      ? 'strict'
      : undefined);
  const formatAllowlist =
    input.formatAllowlist === undefined
      ? DEFAULT_FORMAT_ALLOWLIST
      : input.formatAllowlist instanceof Set
        ? input.formatAllowlist
        : new Set(input.formatAllowlist);
  return portability ? { portability, formatAllowlist } : { formatAllowlist };
}

/**
 * Resolves the `canvas-consumer-missing` rule options. Programmatic
 * `input.canvasConsumers` takes precedence over `MCP_LINT_CANVAS_CONSUMERS`.
 * CSV env value; the literal `false` disables the rule.
 */
function resolveCanvasOptions(input: LintInput): CanvasOptions {
  if (input.canvasConsumers !== undefined) {
    return { canvasConsumers: input.canvasConsumers };
  }
  if (typeof process !== 'undefined') {
    const raw = process.env?.MCP_LINT_CANVAS_CONSUMERS;
    if (raw === 'false') return { canvasConsumers: false };
    if (raw && raw.length > 0) {
      return {
        canvasConsumers: raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
  }
  return {};
}

/**
 * Resolves the `capped-list-no-truncation` rule options. Programmatic
 * `input.truncationAllowlist` takes precedence over `MCP_LINT_TRUNCATION_ALLOWLIST`.
 * CSV env value; the literal `false` disables the rule.
 */
function resolveTruncationOptions(input: LintInput): TruncationOptions {
  if (input.truncationAllowlist !== undefined) {
    return { truncationAllowlist: input.truncationAllowlist };
  }
  if (typeof process !== 'undefined') {
    const raw = process.env?.MCP_LINT_TRUNCATION_ALLOWLIST;
    if (raw === 'false') return { truncationAllowlist: false };
    if (raw && raw.length > 0) {
      return {
        truncationAllowlist: raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
  }
  return {};
}

/** Appends a "See: skills/api-linter/SKILL.md#<rule>" breadcrumb to the message. */
function withBreadcrumb(diagnostic: LintDiagnostic): LintDiagnostic {
  return {
    ...diagnostic,
    message: `${diagnostic.message}\nSee: ${SKILL_REFERENCE_PATH}#${ruleAnchor(diagnostic.rule)}`,
  };
}

/**
 * Validates MCP tool, resource, and prompt definitions against the MCP spec
 * and framework conventions. Returns a structured report with errors and warnings.
 *
 * Errors represent MUST-level spec violations that will cause runtime failures.
 * Warnings represent SHOULD-level or quality issues that degrade behavior.
 *
 * @example
 * ```ts
 * import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
 *
 * const report = validateDefinitions({
 *   tools: allToolDefinitions,
 *   resources: allResourceDefinitions,
 *   prompts: allPromptDefinitions,
 * });
 *
 * if (!report.passed) {
 *   console.error('MCP lint errors:', report.errors);
 *   process.exit(1);
 * }
 * ```
 */
export function validateDefinitions(input: LintInput): LintReport {
  const diagnostics: LintDiagnostic[] = [];
  const tools = input.tools ?? [];
  const resources = input.resources ?? [];
  const prompts = input.prompts ?? [];
  const portabilityOptions = resolvePortabilityOptions(input);
  const canvasOptions = resolveCanvasOptions(input);
  const truncationOptions = resolveTruncationOptions(input);

  // Per-definition validation
  for (const def of tools) {
    diagnostics.push(...lintToolDefinition(def, portabilityOptions));
    diagnostics.push(
      ...lintCappedListTruncation(
        def as { name?: unknown; input?: unknown; output?: unknown; enrichment?: unknown },
        truncationOptions,
      ),
    );
  }
  for (const def of resources) {
    diagnostics.push(...lintResourceDefinition(def, portabilityOptions));
  }
  for (const def of prompts) {
    diagnostics.push(...lintPromptDefinition(def, portabilityOptions));
  }

  // server.json manifest validation
  if (input.serverJson != null) {
    const pkgVersion = input.packageJson?.version;
    diagnostics.push(
      ...lintServerJson(
        input.serverJson,
        pkgVersion ? { packageJsonVersion: pkgVersion } : undefined,
      ),
    );
  }

  // Cross-definition duplicate checks
  const extractNames = (defs: unknown[]) =>
    defs
      .map((d) => (d as Record<string, unknown>)?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

  diagnostics.push(...checkDuplicateNames(extractNames(tools), 'tool'));

  const resourceNames = resources
    .map((d) => {
      const r = d as Record<string, unknown>;
      return typeof r?.name === 'string'
        ? r.name
        : typeof r?.uriTemplate === 'string'
          ? r.uriTemplate
          : '';
    })
    .filter((n) => n.length > 0);
  diagnostics.push(...checkDuplicateNames(resourceNames, 'resource'));

  diagnostics.push(...checkDuplicateNames(extractNames(prompts), 'prompt'));

  // Cross-definition: app tool ↔ app resource pairing
  diagnostics.push(...lintAppToolResourcePairing(tools, resources));

  // Cross-definition: canvas token must have a consumer tool
  diagnostics.push(...lintCanvasConsumerPairing(tools, canvasOptions));

  // Landing page configuration
  if (input.landing != null) {
    diagnostics.push(...lintLandingConfig(input.landing));
  }

  const annotated = diagnostics.map(withBreadcrumb);
  const errors = annotated.filter((d) => d.severity === 'error');
  const warnings = annotated.filter((d) => d.severity === 'warning');

  return {
    errors,
    warnings,
    passed: errors.length === 0,
  };
}
