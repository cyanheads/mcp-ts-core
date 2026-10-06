/**
 * @fileoverview Tests for scripts/check-framework-antipatterns.ts — the `git grep`
 * rules devcheck runs over `src/`: a downgraded tool `inputSchema`, a
 * post-register `inputSchema` mutation, SDK error-text matching in the transport
 * layer, and `z.coerce.boolean()` (the consumer-facing env-flag footgun). Each rule
 * is scoped by pathspec, and a matched line that is itself a comment is a
 * mention, not a use. Spawns the real script in a temp git repository, since the
 * rules scan tracked files from the cwd. The not-a-repository skip is covered in
 * devcheck-git-guard.test.ts.
 * @module tests/unit/scripts/check-framework-antipatterns.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check-framework-antipatterns.ts',
);

let dir: string;

/** Writes each file and stages it — `git grep` scans tracked files only. */
function track(files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, relPath)), { recursive: true });
    writeFileSync(resolve(dir, relPath), content);
  }
  const added = spawnSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir });
  if (added.status !== 0) throw new Error(`git add failed: ${added.stderr}`);
}

function runCheck(): { code: number; out: string } {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd: dir, encoding: 'utf-8' });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describe('check-framework-antipatterns rules', () => {
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'fw-antipatterns-'));
    const init = spawnSync('git', ['init', '-q'], { cwd: dir });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags each rule on a real use, naming the file, line, and rule', () => {
    track({
      'src/mcp-server/tools/register.ts': [
        'export function register(server, def) {',
        '  server.registerTool(def.name, { inputSchema: z.unknown() });',
        '  server.registerTool(def.name, { inputSchema: def.input.passthrough() });',
        '}',
      ].join('\n'),
      'src/mcp-server/registry.ts':
        'export const patch = (tool, s) => {\n  tool.inputSchema = s;\n};\n',
      'src/mcp-server/transports/http.ts':
        "export const isSdkError = (m: string) => m.startsWith('Input validation error');\n",
      'src/config/server-config.ts': 'export const Debug = z.coerce.boolean();\n',
    });

    const { code, out } = runCheck();

    expect(code).toBe(1);
    expect(out).toContain('Found 5 framework antipattern violation(s):');
    expect(out).toContain('src/mcp-server/tools/register.ts:2 [inputSchema-downgrade]');
    expect(out).toContain('src/mcp-server/tools/register.ts:3 [inputSchema-downgrade]');
    expect(out).toContain('src/mcp-server/registry.ts:2 [inputSchema-mutation]');
    expect(out).toContain('src/mcp-server/transports/http.ts:1 [transport-text-match]');
    expect(out).toContain('src/config/server-config.ts:1 [coerce-boolean-env-flag]');
  });

  it('passes comment mentions, test files, and matches outside each rule’s scope', () => {
    track({
      // Comment lines name the antipatterns to document them.
      'src/config/server-config.ts': [
        '// Never z.coerce.boolean() for an env flag.',
        '/** z.coerce.boolean() reads "false" as true. */',
        ' * inputSchema: z.any() would break tools/list.',
        'export const Debug = z.stringbool();',
      ].join('\n'),
      // Test files are excluded from every rule that scans them.
      'src/config/server-config.test.ts': 'const Debug = z.coerce.boolean();\n',
      // Rule 1 is scoped to src/mcp-server/tools/, rule 2 skips src/linter/, rule 3
      // is scoped to the transports, and a comparison is not an assignment.
      'src/services/adapter.ts': [
        'export const shape = { inputSchema: z.any() };',
        "export const matches = (m: string) => m === 'Input validation error';",
        'export const same = (a, b) => a.inputSchema === b.inputSchema;',
      ].join('\n'),
      'src/linter/fixture.ts': 'export const reset = (t, s) => {\n  t.inputSchema = s;\n};\n',
    });

    const { code, out } = runCheck();

    expect(code).toBe(0);
    expect(out).toContain('No framework antipatterns found (4 rule(s) scanned).');
  });
});
