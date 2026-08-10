/**
 * @fileoverview Resource-specific lint rules.
 * Validates resource definitions against MCP spec and framework conventions.
 * @module src/linter/rules/resource-rules
 */

import type { ZodObject, ZodRawShape } from 'zod';

import type { LintDiagnostic } from '../types.js';
import { invalidDefinitionEntry, isDefinitionObject } from './definition-rules.js';
import { lintErrorContract, lintErrorContractConformance } from './error-contract-rules.js';
import { lintHandlerBody } from './handler-body-rules.js';
import { checkNameRequired } from './name-rules.js';
import { lintSchemaPortability, type PortabilityOptions } from './portability-rules.js';
import {
  checkFieldDescriptions,
  checkIsZodObject,
  checkSchemaSatisfiable,
  checkSchemaSerializable,
} from './schema-rules.js';
import { lintAuthScopes } from './tool-rules.js';

/**
 * Runs all lint rules against a single resource definition.
 */
export function lintResourceDefinition(
  def: unknown,
  portability?: PortabilityOptions,
): LintDiagnostic[] {
  if (!isDefinitionObject(def)) return [invalidDefinitionEntry(def, 'resource')];
  const diagnostics: LintDiagnostic[] = [];
  const d = def as Record<string, unknown>;
  const uriTemplate = typeof d?.uriTemplate === 'string' ? d.uriTemplate : '';
  const name = typeof d?.name === 'string' ? d.name : uriTemplate;
  const displayName = name || '<unnamed>';

  // URI template is required
  if (!uriTemplate) {
    diagnostics.push({
      rule: 'uri-template-required',
      severity: 'error',
      message: `Resource '${displayName}' is missing a uriTemplate.`,
      definitionType: 'resource',
      definitionName: displayName,
    });
  } else {
    // Validate URI template format (basic RFC 6570 check)
    const templateCheck = checkUriTemplate(uriTemplate, name);
    if (templateCheck) diagnostics.push(templateCheck);
  }

  // Name fallback warning
  if (!d?.name && uriTemplate) {
    diagnostics.push({
      rule: 'resource-name-not-uri',
      severity: 'warning',
      message:
        `Resource '${uriTemplate}' has no explicit name and will use the URI template as its display name. ` +
        'Consider adding a name for cleaner resources/list output.',
      definitionType: 'resource',
      definitionName: uriTemplate,
    });
  }

  // Name validation (when explicitly provided)
  if (d?.name !== undefined) {
    const nameReq = checkNameRequired(d.name, 'resource', name);
    if (nameReq) diagnostics.push(nameReq);
  }

  // Description
  if (typeof d?.description !== 'string' || d.description.length === 0) {
    diagnostics.push({
      rule: 'description-required',
      severity: 'warning',
      message: `Resource '${displayName}' has no description.`,
      definitionType: 'resource',
      definitionName: displayName,
    });
  }

  // Handler
  if (typeof d?.handler !== 'function') {
    diagnostics.push({
      rule: 'handler-required',
      severity: 'error',
      message: `Resource '${displayName}' is missing a handler function.`,
      definitionType: 'resource',
      definitionName: displayName,
    });
  }

  // Params schema (optional, but must be ZodObject when present)
  if (d?.params !== undefined) {
    const paramsCheck = checkIsZodObject(d.params, 'params', 'resource', displayName);
    if (paramsCheck) {
      diagnostics.push(paramsCheck);
    } else {
      diagnostics.push(...checkFieldDescriptions(d.params, 'params', 'resource', displayName));
      const paramsSerial = checkSchemaSerializable(d.params, 'params', 'resource', displayName);
      if (paramsSerial) {
        diagnostics.push(paramsSerial);
      } else {
        diagnostics.push(...checkSchemaSatisfiable(d.params, 'params', 'resource', displayName));
        if (portability) {
          diagnostics.push(
            ...lintSchemaPortability(d.params, 'params', 'resource', displayName, portability),
          );
        }
      }

      // Cross-reference: template variables must match params schema keys
      if (uriTemplate) {
        diagnostics.push(...checkTemplateParamsAlignment(uriTemplate, d.params, displayName));
      }
    }
  }

  // Auth scopes validation
  if (d?.auth !== undefined) {
    diagnostics.push(...lintAuthScopes(d.auth, 'resource', displayName));
  }

  // Output schema (optional, but must be ZodObject when present)
  if (d?.output !== undefined) {
    const outputCheck = checkIsZodObject(d.output, 'output', 'resource', displayName);
    if (outputCheck) {
      diagnostics.push(outputCheck);
    } else {
      diagnostics.push(...checkFieldDescriptions(d.output, 'output', 'resource', displayName));
      const outputSerial = checkSchemaSerializable(d.output, 'output', 'resource', displayName);
      if (outputSerial) {
        diagnostics.push(outputSerial);
      } else {
        diagnostics.push(...checkSchemaSatisfiable(d.output, 'output', 'resource', displayName));
        if (portability) {
          diagnostics.push(
            ...lintSchemaPortability(d.output, 'output', 'resource', displayName, portability),
          );
        }
      }
    }
  }

  // Handler body heuristic checks (error-handling anti-patterns)
  diagnostics.push(...lintHandlerBody(d as { handler?: unknown; name?: string }, 'resource'));

  // Declarative error contract validation
  if (d?.errors !== undefined) {
    diagnostics.push(...lintErrorContract(d.errors, 'resource', displayName));
    diagnostics.push(
      ...lintErrorContractConformance(
        d as { handler?: unknown; errors?: unknown },
        'resource',
        displayName,
      ),
    );
  }

  return diagnostics;
}

/** Extracts variable names from an RFC 6570 URI template (strips operators like +, #, ?, &, etc.). */
function extractTemplateVariables(template: string): string[] {
  const vars: string[] = [];
  for (const match of template.matchAll(/\{(?:[+#./;?&]?)([^}]+)\}/g)) {
    // match[1] contains comma-separated variable names, each optionally with :maxLength or *
    const varList = match[1] ?? '';
    for (const part of varList.split(',')) {
      const name = part.replace(/:[0-9]+$|\*$/g, '').trim();
      if (name) vars.push(name);
    }
  }
  return vars;
}

/**
 * Checks that URI template variables align with params schema keys.
 * A mismatch causes hard failures: the SDK extracts variables from the URI
 * and passes them to the params schema for validation.
 */
function checkTemplateParamsAlignment(
  template: string,
  params: unknown,
  resourceName: string,
): LintDiagnostic[] {
  const templateVars = extractTemplateVariables(template);
  if (templateVars.length === 0) return [];

  const shape = (params as ZodObject<ZodRawShape>).shape;
  const schemaKeys = new Set(Object.keys(shape));

  const diagnostics: LintDiagnostic[] = [];
  for (const varName of templateVars) {
    if (!schemaKeys.has(varName)) {
      diagnostics.push({
        rule: 'template-params-align',
        severity: 'error',
        message:
          `Resource '${resourceName}' URI template variable '{${varName}}' has no matching key in params schema. ` +
          `Params schema has: [${[...schemaKeys].join(', ')}]. This will cause every resource read to fail.`,
        definitionType: 'resource',
        definitionName: resourceName,
      });
    }
  }

  return diagnostics;
}

/**
 * Basic URI template validation.
 * Checks for balanced braces and non-empty variable names (RFC 6570 subset).
 */
function checkUriTemplate(template: string, name: string): LintDiagnostic | null {
  // Check for unbalanced braces
  let depth = 0;
  for (const char of template) {
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth < 0) {
      return {
        rule: 'uri-template-valid',
        severity: 'error',
        message: `Resource '${name}' has an invalid URI template: unbalanced braces in '${template}'.`,
        definitionType: 'resource',
        definitionName: name,
      };
    }
  }
  if (depth !== 0) {
    return {
      rule: 'uri-template-valid',
      severity: 'error',
      message: `Resource '${name}' has an invalid URI template: unclosed brace in '${template}'.`,
      definitionType: 'resource',
      definitionName: name,
    };
  }

  // Check for empty variable names like {}
  if (/\{\s*\}/.test(template)) {
    return {
      rule: 'uri-template-valid',
      severity: 'error',
      message: `Resource '${name}' has an invalid URI template: empty variable name in '${template}'.`,
      definitionType: 'resource',
      definitionName: name,
    };
  }

  return null;
}
