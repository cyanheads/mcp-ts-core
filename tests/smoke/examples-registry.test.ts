/**
 * @fileoverview Registry check for the example server: the definition barrels
 * register the full surface, it lints clean with zero warnings, and the server
 * instructions name only registered tools. Imports the barrels rather than
 * `examples/index.ts`, which starts a server at import.
 * @module tests/smoke/examples-registry.test
 */
import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import { describe, expect, it } from 'vitest';
import { allPromptDefinitions } from '../../examples/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '../../examples/mcp-server/resources/definitions/index.js';
import { serverInstructions } from '../../examples/mcp-server/server-instructions.js';
import { allToolDefinitions } from '../../examples/mcp-server/tools/definitions/index.js';

const toolNames = allToolDefinitions.map((t) => t.name);

describe('example server registry', () => {
  it('registers 5 tools, 2 resources, and 1 prompt with unique names', () => {
    const resourceNames = allResourceDefinitions.map((r) => r.name);
    const promptNames = allPromptDefinitions.map((p) => p.name);

    expect(toolNames).toHaveLength(5);
    expect(resourceNames).toHaveLength(2);
    expect(promptNames).toHaveLength(1);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(new Set(resourceNames).size).toBe(resourceNames.length);
  });

  it('lints clean with zero warnings', () => {
    const report = validateDefinitions({
      tools: allToolDefinitions,
      resources: allResourceDefinitions,
      prompts: allPromptDefinitions,
    });
    const describeDiagnostic = (d: { rule: string; definitionName: string; message: string }) =>
      `${d.rule} (${d.definitionName}): ${d.message}`;

    expect(report.errors.map(describeDiagnostic)).toEqual([]);
    expect(report.warnings.map(describeDiagnostic)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('keeps the server instructions to one line naming only registered tools', () => {
    expect(serverInstructions.trim()).not.toBe('');
    expect(serverInstructions).not.toContain('\n');

    const named = [...serverInstructions.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(toolNames).toContain(name);
  });
});
