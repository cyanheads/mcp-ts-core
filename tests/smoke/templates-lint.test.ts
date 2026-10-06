/**
 * @fileoverview Lints every definition the `init` scaffold ships (#466). A server
 * scaffolded from `templates/` runs `bun run lint:mcp` as part of `devcheck`, so
 * each template definition must pass `validateDefinitions()` with zero errors and
 * zero warnings, or a fresh project starts with a red or noisy gate. Definitions
 * are discovered by walking `templates/src/mcp-server/**\/definitions/` and
 * classified the way `scripts/lint-mcp.ts` does, so a new template definition is
 * covered without editing this file.
 *
 * `templates/` carries its own package.json, so the definitions' bare
 * `@cyanheads/mcp-ts-core` imports cannot self-reference the root package; they
 * resolve through the smoke project's alias onto `src/`, which also means they
 * are linted against the code under test rather than the last build.
 * @module tests/smoke/templates-lint.test
 */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const TEMPLATE_SERVER = join(REPO_ROOT, 'templates/src/mcp-server');

/** The definition file suffixes `scripts/lint-mcp.ts` discovers. */
const DEFINITION_SUFFIXES = [
  '.tool.ts',
  '.app-tool.ts',
  '.resource.ts',
  '.app-resource.ts',
  '.prompt.ts',
];

/** Every definition file under a `definitions/` directory of the template server. */
function discoverDefinitionFiles(): string[] {
  return readdirSync(TEMPLATE_SERVER, { recursive: true, encoding: 'utf-8' })
    .map((entry) => entry.split('\\').join('/'))
    .filter((entry) => entry.split('/').slice(0, -1).includes('definitions'))
    .filter((entry) => DEFINITION_SUFFIXES.some((suffix) => entry.endsWith(suffix)))
    .sort()
    .map((entry) => join(TEMPLATE_SERVER, entry));
}

type Kind = 'prompt' | 'resource' | 'tool';

/** Duck-types an export the way `scripts/lint-mcp.ts` does. */
function kindOf(value: unknown): Kind | undefined {
  if (!value || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  if (typeof o.handler === 'function' && o.input != null && o.output != null) return 'tool';
  if (typeof o.uriTemplate === 'string' && typeof o.handler === 'function') return 'resource';
  if (typeof o.generate === 'function' && typeof o.name === 'string' && !('handler' in o)) {
    return 'prompt';
  }
  return;
}

describe('template definitions', () => {
  it('lint clean with zero errors and zero warnings', async () => {
    const files = discoverDefinitionFiles();
    expect(files.length).toBeGreaterThan(0);

    const found: Record<Kind, unknown[]> = { prompt: [], resource: [], tool: [] };
    const exportsPerFile: Record<string, number> = {};
    for (const file of files) {
      const definitions = Object.values(await import(file)).flatMap((value) => {
        const kind = kindOf(value);
        if (kind) found[kind].push(value);
        return kind ? [value] : [];
      });
      exportsPerFile[relative(REPO_ROOT, file)] = definitions.length;
    }
    // Every discovered file contributes, so none drops out of the lint unnoticed.
    for (const [file, count] of Object.entries(exportsPerFile)) {
      expect(count, `${file} exports no definition`).toBeGreaterThan(0);
    }

    const report = validateDefinitions({
      tools: found.tool,
      resources: found.resource,
      prompts: found.prompt,
    });
    const describeDiagnostic = (d: { rule: string; definitionName: string; message: string }) =>
      `${d.rule} (${d.definitionName}): ${d.message}`;

    expect(report.errors.map(describeDiagnostic)).toEqual([]);
    expect(report.warnings.map(describeDiagnostic)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
