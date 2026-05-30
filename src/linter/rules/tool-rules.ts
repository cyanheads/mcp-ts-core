/**
 * @fileoverview Tool-specific lint rules.
 * Validates tool definitions against MCP spec and framework conventions.
 * @module src/linter/rules/tool-rules
 */

import type { LintDiagnostic } from '../types.js';
import { lintEnrichmentContract } from './enrichment-rules.js';
import { lintErrorContract, lintErrorContractConformance } from './error-contract-rules.js';
import { lintFormatParity } from './format-parity-rules.js';
import { lintHandlerBody } from './handler-body-rules.js';
import { checkNameRequired, checkToolNameFormat } from './name-rules.js';
import { lintSchemaPortability, type PortabilityOptions } from './portability-rules.js';
import {
  checkFieldDescriptions,
  checkIsZodObject,
  checkSchemaSerializable,
} from './schema-rules.js';

/**
 * Runs all lint rules against a single tool definition.
 * Accepts `unknown` to catch structural issues before type narrowing.
 */
export function lintToolDefinition(
  def: unknown,
  portability?: PortabilityOptions,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const d = def as Record<string, unknown>;
  const name = typeof d?.name === 'string' ? d.name : '';
  const displayName = name || '<unnamed>';

  // Name validation
  const nameReq = checkNameRequired(d?.name, 'tool', name);
  if (nameReq) diagnostics.push(nameReq);

  if (name) {
    const nameFmt = checkToolNameFormat(name);
    if (nameFmt) diagnostics.push(nameFmt);
  }

  // Description
  if (typeof d?.description !== 'string' || d.description.length === 0) {
    diagnostics.push({
      rule: 'description-required',
      severity: 'warning',
      message: `Tool '${displayName}' has no description. Tools without descriptions degrade LLM tool selection.`,
      definitionType: 'tool',
      definitionName: displayName,
    });
  }

  // Handler
  if (typeof d?.handler !== 'function') {
    diagnostics.push({
      rule: 'handler-required',
      severity: 'error',
      message: `Tool '${displayName}' is missing a handler function.`,
      definitionType: 'tool',
      definitionName: displayName,
    });
  }

  // Input schema: must be ZodObject, serializable to JSON Schema
  const inputCheck = checkIsZodObject(d?.input, 'input', 'tool', displayName);
  if (inputCheck) {
    diagnostics.push(inputCheck);
  } else {
    diagnostics.push(...checkFieldDescriptions(d?.input, 'input', 'tool', displayName));
    const inputSerial = checkSchemaSerializable(d?.input, 'input', 'tool', displayName);
    if (inputSerial) {
      diagnostics.push(inputSerial);
    } else if (portability) {
      diagnostics.push(
        ...lintSchemaPortability(d?.input, 'input', 'tool', displayName, portability),
      );
    }
  }

  // Output schema: must be ZodObject, serializable to JSON Schema
  const outputCheck = checkIsZodObject(d?.output, 'output', 'tool', displayName);
  if (outputCheck) {
    diagnostics.push(outputCheck);
  } else {
    diagnostics.push(...checkFieldDescriptions(d?.output, 'output', 'tool', displayName));
    const outputSerial = checkSchemaSerializable(d?.output, 'output', 'tool', displayName);
    if (outputSerial) {
      diagnostics.push(outputSerial);
    } else if (portability) {
      diagnostics.push(
        ...lintSchemaPortability(d?.output, 'output', 'tool', displayName, portability),
      );
    }
    // Format parity: skip when output isn't serializable (synthetic sample may misbehave).
    if (!outputSerial && typeof d?.format === 'function') {
      diagnostics.push(...lintFormatParity(d, displayName));
    }
  }

  // Enrichment block: shape, output-key collisions, and the advisory nudge for
  // agent-facing context that should move out of `output`.
  diagnostics.push(
    ...lintEnrichmentContract(
      d as { enrichment?: unknown; output?: unknown; enrichmentTrailer?: unknown },
      'tool',
      displayName,
    ),
  );

  // Auth scopes validation
  if (d?.auth !== undefined) {
    diagnostics.push(...lintAuthScopes(d.auth, 'tool', displayName));
  }

  // Annotations validation
  if (d?.annotations && typeof d.annotations === 'object') {
    diagnostics.push(...lintToolAnnotations(d.annotations as Record<string, unknown>, name));
  }

  // _meta.ui validation (MCP Apps)
  if (d?._meta && typeof d._meta === 'object') {
    diagnostics.push(...lintToolMeta(d._meta as Record<string, unknown>, displayName));
  }

  // Handler body heuristic checks (error-handling anti-patterns)
  diagnostics.push(...lintHandlerBody(d as { handler?: unknown; name?: string }, 'tool'));

  // Declarative error contract validation
  if (d?.errors !== undefined) {
    diagnostics.push(...lintErrorContract(d.errors, 'tool', displayName));
    diagnostics.push(
      ...lintErrorContractConformance(
        d as { handler?: unknown; errors?: unknown },
        'tool',
        displayName,
      ),
    );
  }

  return diagnostics;
}

/** Validates that auth scopes are well-formed (array of non-empty strings). */
export function lintAuthScopes(
  auth: unknown,
  definitionType: LintDiagnostic['definitionType'],
  definitionName: string,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  if (!Array.isArray(auth)) {
    diagnostics.push({
      rule: 'auth-type',
      severity: 'error',
      message: `${definitionType} '${definitionName}' auth must be an array of scope strings.`,
      definitionType,
      definitionName,
    });
    return diagnostics;
  }

  for (let i = 0; i < auth.length; i++) {
    const scope = auth[i];
    if (typeof scope !== 'string' || scope.trim().length === 0) {
      diagnostics.push({
        rule: 'auth-scope-format',
        severity: 'error',
        message:
          `${definitionType} '${definitionName}' auth[${i}] must be a non-empty string, ` +
          `got ${typeof scope === 'string' ? 'empty string' : typeof scope}.`,
        definitionType,
        definitionName,
      });
    }
  }

  return diagnostics;
}

/** Validates `_meta.ui` fields for MCP Apps tools. */
function lintToolMeta(meta: Record<string, unknown>, toolName: string): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const ui = meta.ui;

  if (ui === undefined) return diagnostics;

  if (typeof ui !== 'object' || ui === null) {
    diagnostics.push({
      rule: 'meta-ui-type',
      severity: 'error',
      message: `Tool '${toolName}' _meta.ui must be an object.`,
      definitionType: 'tool',
      definitionName: toolName,
    });
    return diagnostics;
  }

  const uiObj = ui as Record<string, unknown>;

  // resourceUri is required when _meta.ui is present
  if (typeof uiObj.resourceUri !== 'string' || uiObj.resourceUri.length === 0) {
    diagnostics.push({
      rule: 'meta-ui-resource-uri-required',
      severity: 'error',
      message:
        `Tool '${toolName}' _meta.ui is present but missing a valid resourceUri string. ` +
        'MCP Apps tools must declare _meta.ui.resourceUri pointing to a ui:// resource.',
      definitionType: 'tool',
      definitionName: toolName,
    });
  } else if (!uiObj.resourceUri.startsWith('ui://')) {
    diagnostics.push({
      rule: 'meta-ui-resource-uri-scheme',
      severity: 'warning',
      message:
        `Tool '${toolName}' _meta.ui.resourceUri '${uiObj.resourceUri}' does not use the ui:// scheme. ` +
        'MCP Apps resources conventionally use the ui:// scheme.',
      definitionType: 'tool',
      definitionName: toolName,
    });
  }

  return diagnostics;
}

/**
 * Cross-definition check: verifies that every tool declaring `_meta.ui.resourceUri`
 * has a matching resource registered with that URI template.
 */
export function lintAppToolResourcePairing(
  tools: unknown[],
  resources: unknown[],
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];

  // Collect registered resource URI templates and compile matchers.
  // Templates may contain RFC 6570 variables (e.g. ui://app/{page}) that need
  // to match concrete URIs from tool _meta.ui.resourceUri (e.g. ui://app/dashboard).
  const resourceTemplates: string[] = [];
  const resourceMatchers: RegExp[] = [];
  for (const r of resources) {
    const rd = r as Record<string, unknown>;
    if (typeof rd?.uriTemplate === 'string') {
      resourceTemplates.push(rd.uriTemplate);
      resourceMatchers.push(uriTemplateToRegex(rd.uriTemplate));
    }
  }

  // Check each app tool's resourceUri against registered resources
  for (const t of tools) {
    const td = t as Record<string, unknown>;
    const meta = td?._meta as Record<string, unknown> | undefined;
    const ui = meta?.ui as Record<string, unknown> | undefined;
    const resourceUri = ui?.resourceUri;
    if (typeof resourceUri !== 'string') continue;

    const toolName = typeof td.name === 'string' ? td.name : '<unnamed>';
    const matched = resourceMatchers.some((re) => re.test(resourceUri));

    if (!matched) {
      const registered =
        resourceTemplates.length > 0
          ? ` Registered resource templates: ${resourceTemplates.join(', ')}`
          : ' No resources are registered.';
      diagnostics.push({
        rule: 'app-tool-resource-pairing',
        severity: 'warning',
        message:
          `Tool '${toolName}' declares _meta.ui.resourceUri '${resourceUri}' but no resource ` +
          `with a matching URI template is registered. The host will fail to fetch the app UI at runtime.${registered}`,
        definitionType: 'tool',
        definitionName: toolName,
      });
    }
  }

  return diagnostics;
}

/**
 * Converts an RFC 6570 URI template to a regex that matches concrete URIs.
 * Respects operators: `{+var}` (reserved) and `{/var}` (path segments) can
 * expand to values containing `/`, so they match `.+`. All other expressions
 * match `[^/]+`. Intentionally permissive — lint-time, not runtime routing.
 */
function uriTemplateToRegex(template: string): RegExp {
  // Split on template expressions first, then escape only the literal parts.
  // This avoids escaping operator characters (e.g. +) inside expressions.
  const parts = template.split(/(\{[^}]+\})/);
  let pattern = '';
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const expr = part.slice(1, -1);
      const op = expr.charAt(0);
      // {+var} (reserved) and {/var} (path segments) can expand to values with slashes
      pattern += op === '+' || op === '/' ? '.+' : '[^/]+';
    } else {
      pattern += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Validates that annotation hint values are booleans where expected. */
function lintToolAnnotations(
  annotations: Record<string, unknown>,
  toolName: string,
): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const booleanHints = [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const;

  for (const hint of booleanHints) {
    if (hint in annotations && typeof annotations[hint] !== 'boolean') {
      diagnostics.push({
        rule: 'annotation-type',
        severity: 'warning',
        message: `Tool '${toolName}' annotation '${hint}' should be a boolean, got ${typeof annotations[hint]}.`,
        definitionType: 'tool',
        definitionName: toolName,
      });
    }
  }

  // Semantic coherence: destructiveHint is meaningless when readOnlyHint is true
  if (annotations.readOnlyHint === true && 'destructiveHint' in annotations) {
    diagnostics.push({
      rule: 'annotation-coherence',
      severity: 'warning',
      message:
        `Tool '${toolName}' sets destructiveHint while readOnlyHint is true. ` +
        'destructiveHint is meaningless for read-only tools.',
      definitionType: 'tool',
      definitionName: toolName,
    });
  }

  return diagnostics;
}
