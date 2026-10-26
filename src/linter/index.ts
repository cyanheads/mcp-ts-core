/**
 * @fileoverview Public barrel for the build-time linters: `validateDefinitions()`
 * for tool, resource, and prompt definitions with the types its reports use,
 * and `validateSkillTree()` for a published skill tree.
 * @module src/linter/index
 */

export { type SkillProblem, validateSkillTree } from '@/mcp-server/skills.js';
export type {
  LintDefinitionType,
  LintDiagnostic,
  LintInput,
  LintReport,
  LintSeverity,
} from './types.js';
export { validateDefinitions } from './validate.js';
