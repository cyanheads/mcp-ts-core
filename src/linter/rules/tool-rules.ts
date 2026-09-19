/**
 * @fileoverview Tool-specific lint rules.
 * Validates tool definitions against MCP spec and framework conventions.
 * @module src/linter/rules/tool-rules
 */

import { foldArgumentKey } from '@/mcp-server/tools/utils/inputPrevalidation.js';
import { inputVariants } from '@/mcp-server/tools/utils/schemaShape.js';
import type { LintDiagnostic } from '../types.js';
import { invalidDefinitionEntry, isDefinitionObject } from './definition-rules.js';
import { lintEnrichmentContract } from './enrichment-rules.js';
import {
  lintErrorContract,
  lintErrorContractConformance,
  lintErrorContractRecoveryUnforwarded,
  lintErrorContractUnthrown,
} from './error-contract-rules.js';
import { lintFormatParity } from './format-parity-rules.js';
import { lintHandlerBody } from './handler-body-rules.js';
import { checkNameRequired, checkToolNameFormat } from './name-rules.js';
import type { PortabilityOptions } from './portability-rules.js';
import {
  checkHeaderDesignations,
  checkStrictenedRootMeta,
  lintSchemaRoot,
  objectShapeKeys,
} from './schema-rules.js';

/**
 * Runs all lint rules against a single tool definition.
 * Accepts `unknown` to catch structural issues before type narrowing.
 */
export function lintToolDefinition(
  def: unknown,
  portability?: PortabilityOptions,
): LintDiagnostic[] {
  if (!isDefinitionObject(def)) return [invalidDefinitionEntry(def, 'tool')];
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

  // Input schema: a ZodObject, or a discriminated union of them for a
  // multi-mode tool; serializable to JSON Schema either way.
  const inputRoot = lintSchemaRoot(d?.input, 'input', 'tool', displayName, {
    allowDiscriminatedUnion: true,
    portability,
  });
  diagnostics.push(...inputRoot.diagnostics);
  if (inputRoot.serializable) {
    const designations = checkHeaderDesignations(d?.input, 'input', 'tool', displayName);
    if (designations) diagnostics.push(designations);
  }

  // Root `.describe()` / `.meta()` that strictening discarded — read off the
  // record `tool()` left, since the stored schema no longer carries it.
  diagnostics.push(...checkStrictenedRootMeta(def, displayName));

  // Declared argument aliases must resolve to exactly one declared key.
  if (d?.inputAliases !== undefined) {
    diagnostics.push(...lintInputAliases(d.inputAliases, d?.input, displayName));
  }

  // Output schema: must be ZodObject, serializable to JSON Schema
  const outputRoot = lintSchemaRoot(d?.output, 'output', 'tool', displayName, { portability });
  diagnostics.push(...outputRoot.diagnostics);
  // Format parity: skip when output isn't serializable (synthetic sample may misbehave).
  if (outputRoot.serializable && typeof d?.format === 'function') {
    diagnostics.push(...lintFormatParity(d, displayName));
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
    const contractDef = d as { handler?: unknown; errors?: unknown };
    diagnostics.push(...lintErrorContract(d.errors, 'tool', displayName));
    diagnostics.push(...lintErrorContractConformance(contractDef, 'tool', displayName));
    diagnostics.push(...lintErrorContractUnthrown(contractDef, 'tool', displayName));
    diagnostics.push(...lintErrorContractRecoveryUnforwarded(contractDef, 'tool', displayName));
  }

  return diagnostics;
}

/**
 * Validates a tool's `inputAliases` against the declared input keys.
 *
 * An alias is a one-to-one mapping fixed ahead of time — the whole reason it is
 * accepted where nearest-key matching is not — so an alias that resolves to
 * more than one key, or to none, is a definition error rather than a runtime
 * one. The runtime declines an ambiguous rewrite silently and the caller sees
 * the ordinary strict rejection, which reads as the alias simply not working;
 * every condition below is decidable from the definition, so it is decided
 * here instead.
 *
 * Case-folding uses {@link foldArgumentKey}, the same fold the rewrite applies.
 * On a discriminated-union root, every variant's keys count as declared: a
 * rewrite resolves against the selected variant, so an alias naming a key no
 * variant declares can never fire.
 */
export function lintInputAliases(
  aliases: unknown,
  input: unknown,
  definitionName: string,
): LintDiagnostic[] {
  const diagnostic = (message: string): LintDiagnostic => ({
    rule: 'input-alias-conflict',
    severity: 'error',
    message,
    definitionType: 'tool',
    definitionName,
  });

  if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) {
    return [
      diagnostic(
        `Tool '${definitionName}' inputAliases must be an object mapping each alias to the ` +
          `declared input key it stands for, e.g. { drug_name: 'drug' }.`,
      ),
    ];
  }

  const declared = new Set<string>();
  for (const variant of inputVariants(input)) {
    for (const key of Object.keys(variant.shape)) declared.add(key);
  }

  const diagnostics: LintDiagnostic[] = [];

  // A declared key that case-folds onto another leaves the case-style half with
  // no single target, so it rewrites nothing and the alias silently never fires.
  const declaredByFold = new Map<string, string[]>();
  for (const key of declared) {
    const fold = foldArgumentKey(key);
    declaredByFold.set(fold, [...(declaredByFold.get(fold) ?? []), key]);
  }
  for (const keys of declaredByFold.values()) {
    if (keys.length > 1) {
      diagnostics.push(
        diagnostic(
          `Tool '${definitionName}' declares ${keys.join(' and ')}, which differ only in case ` +
            `style. No alias can resolve between them — rename one, or drop the other and ` +
            `declare it as an alias of the one you keep.`,
        ),
      );
    }
  }

  const aliasesByFold = new Map<string, Array<{ alias: string; target: string }>>();
  for (const [alias, target] of Object.entries(aliases as Record<string, unknown>)) {
    if (typeof target !== 'string' || target.length === 0) {
      diagnostics.push(
        diagnostic(
          `Tool '${definitionName}' inputAliases['${alias}'] must name a declared input key as ` +
            `a non-empty string.`,
        ),
      );
      continue;
    }

    if (declared.has(alias)) {
      diagnostics.push(
        diagnostic(
          `Tool '${definitionName}' declares '${alias}' as both an input key and an alias for ` +
            `'${target}'. A declared key is never rewritten, so the alias can never fire — ` +
            `remove it, or rename the input key.`,
        ),
      );
    }

    if (!declared.has(target)) {
      diagnostics.push(
        diagnostic(
          `Tool '${definitionName}' aliases '${alias}' to '${target}', which is not a declared ` +
            `input key${declared.size > 0 ? ` (declared: ${[...declared].join(', ')})` : ''}. ` +
            `Point the alias at an existing key.`,
        ),
      );
    }

    const fold = foldArgumentKey(alias);
    const shadowed = (declaredByFold.get(fold) ?? []).filter((key) => key !== target);
    if (shadowed.length > 0) {
      diagnostics.push(
        diagnostic(
          `Tool '${definitionName}' aliases '${alias}' to '${target}', but '${alias}' is a case-` +
            `style variant of ${shadowed.join(' and ')}. Alias it to the key it spells, or ` +
            `rename it so the two readings cannot disagree.`,
        ),
      );
    }

    aliasesByFold.set(fold, [...(aliasesByFold.get(fold) ?? []), { alias, target }]);
  }

  for (const entries of aliasesByFold.values()) {
    const targets = new Set(entries.map((entry) => entry.target));
    if (entries.length > 1 && targets.size > 1) {
      diagnostics.push(
        diagnostic(
          `Tool '${definitionName}' aliases ${entries
            .map((entry) => `'${entry.alias}' → '${entry.target}'`)
            .join(' and ')}, which differ only in case style but name different keys. Pick one ` +
            `target, or spell the aliases so they are distinguishable.`,
        ),
      );
    }
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

/** Options for the canvas-consumer-missing cross-definition rule. */
export interface CanvasOptions {
  /** Additional tool names accepted as consumers. `false` disables the rule. */
  canvasConsumers?: ReadonlyArray<string> | false;
}

/**
 * Cross-definition check: warns when a tool's output schema has a top-level
 * `canvas_id` or `canvasId` field, but no same-server consumer tool (a tool
 * whose name matches `*_dataframe_query` or the `canvasConsumers` list) is
 * registered. A canvas token with no query path is unreachable dead output.
 */
export function lintCanvasConsumerPairing(
  tools: unknown[],
  options?: CanvasOptions,
): LintDiagnostic[] {
  // Rule disabled via knob
  if (options?.canvasConsumers === false) return [];

  const extraConsumers = new Set<string>(options?.canvasConsumers ?? []);
  const toolNames: string[] = [];
  for (const t of tools) {
    const td = t as Record<string, unknown>;
    if (typeof td?.name === 'string') toolNames.push(td.name);
  }

  // Default predicate: name ends with '_dataframe_query'
  const hasDefaultConsumer = toolNames.some((n) => n.endsWith('_dataframe_query'));
  const hasExtraConsumer = toolNames.some((n) => extraConsumers.has(n));
  const hasConsumer = hasDefaultConsumer || hasExtraConsumer;

  const diagnostics: LintDiagnostic[] = [];
  for (const t of tools) {
    const td = t as Record<string, unknown>;
    const toolName = typeof td?.name === 'string' ? td.name : '<unnamed>';
    const outputKeys = objectShapeKeys(td?.output);
    const hasCanvasOutput = outputKeys.includes('canvas_id') || outputKeys.includes('canvasId');
    if (!hasCanvasOutput) continue;

    if (!hasConsumer) {
      diagnostics.push({
        rule: 'canvas-consumer-missing',
        severity: 'warning',
        message:
          `Tool '${toolName}' outputs a canvas token (\`canvas_id\`/\`canvasId\`) but no consumer ` +
          `tool is registered in this server. A canvas token with no query path is unreachable — ` +
          `the agent cannot use it. Fix in either direction: complete the integration by adding the ` +
          `standard \`<prefix>_dataframe_query\` and \`<prefix>_dataframe_describe\` consumers, or ` +
          `remove the DataCanvas staging when the data isn't row-shaped and SQL access adds nothing. ` +
          `To accept a non-standard consumer name, set \`canvasConsumers\` in \`LintInput\` or ` +
          `\`MCP_LINT_CANVAS_CONSUMERS\` in the environment.`,
        definitionType: 'tool',
        definitionName: toolName,
      });
    }
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
  // The expression body excludes `{` as well as `}`: RFC 6570 has no nested
  // expressions, and admitting `{` lets a run of them backtrack quadratically
  // (CodeQL `js/polynomial-redos`).
  const parts = template.split(/(\{[^{}]+\})/);
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
