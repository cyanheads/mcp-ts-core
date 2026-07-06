/**
 * @fileoverview Guard for malformed entries in a definitions array.
 * Every per-definition lint rule dereferences fields off the definition object,
 * so a `null`/`undefined` (or otherwise non-object) entry — a stray bad import,
 * or a conditional that yields `undefined` in a `tools`/`resources`/`prompts`
 * array — would throw a `TypeError` and abort the whole lint run. These helpers
 * let the iteration site (and each entry rule) surface such an entry as a
 * diagnostic, or skip it, instead of crashing.
 * @module src/linter/rules/definition-rules
 */

import type { LintDefinitionType, LintDiagnostic } from '../types.js';

/**
 * True when `def` is a non-null object — the minimum shape every per-definition
 * rule assumes before reading a field. Rejects `null`/`undefined`/primitives;
 * arrays pass (they lint as empty definitions rather than crashing).
 */
export function isDefinitionObject(def: unknown): def is object {
  return def !== null && typeof def === 'object';
}

/**
 * Builds the `definition-invalid` diagnostic for a `null`/`undefined`/non-object
 * entry in a definitions array.
 */
export function invalidDefinitionEntry(
  def: unknown,
  definitionType: LintDefinitionType,
): LintDiagnostic {
  return {
    rule: 'definition-invalid',
    severity: 'error',
    message:
      `${definitionType} definitions array contains an entry of type ` +
      `'${def === null ? 'null' : typeof def}' where a ${definitionType} definition object was ` +
      `expected. A null or undefined entry is usually a stray import or a conditional that yields ` +
      `undefined — remove it from the array or guard its source.`,
    definitionType,
    definitionName: '<invalid>',
  };
}
