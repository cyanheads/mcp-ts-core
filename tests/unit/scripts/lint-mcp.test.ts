/**
 * @fileoverview Tests for scripts/lint-mcp.ts. Two layers:
 *
 * - The `lint.truncationAllowlist` read from `devcheck.config.json` (issue #388).
 *   Imports the real implementation and feeds the resolved options straight into
 *   `validateDefinitions`, so the precedence rungs are exercised through the same
 *   path the CLI takes rather than through a copy of its logic.
 * - The CLI over a project tree (issue #516). Spawns the real script against a
 *   temp project root — discovery, the `import()` of each definition file, the
 *   `server.json` read, the printed report, and the exit code are the surface,
 *   so nothing is mocked. A definition file that fails to import, or a
 *   `server.json` that fails to parse, must fail the run rather than drop out
 *   of it.
 * @module tests/unit/scripts/lint-mcp.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { validateDefinitions } from '@/linter/validate.js';
import { type LintOptions, readLintOptions } from '../../../scripts/lint-mcp.js';

const ENV = 'MCP_LINT_TRUNCATION_ALLOWLIST';

let dir: string;

/** Writes `devcheck.config.json` into the temp project root and returns its path. */
function writeConfig(contents: string): string {
  const path = join(dir, 'devcheck.config.json');
  writeFileSync(path, contents);
  return path;
}

/** The silent-cap shape `capped-list-no-truncation` fires on. */
function cappedTool() {
  return {
    name: 'search_results',
    description: 'A capped search',
    input: z.object({ limit: z.number().describe('Max results') }),
    output: z.object({ items: z.array(z.string()).describe('Items') }),
    handler: async () => ({ items: [] }),
  };
}

function truncationWarnings(options: LintOptions): number {
  const report = validateDefinitions({ tools: [cappedTool()], ...options });
  return report.warnings.filter((w) => w.rule === 'capped-list-no-truncation').length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lint-mcp-config-'));
  delete process.env[ENV];
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
  delete process.env[ENV];
  vi.restoreAllMocks();
});

describe('lint-mcp · readLintOptions', () => {
  it('forwards an array under lint.truncationAllowlist', () => {
    const path = writeConfig('{ "lint": { "truncationAllowlist": ["search_results"] } }');
    expect(readLintOptions(path)).toEqual({ truncationAllowlist: ['search_results'] });
  });

  it('forwards the false form that disables the rule', () => {
    const path = writeConfig('{ "lint": { "truncationAllowlist": false } }');
    expect(readLintOptions(path)).toEqual({ truncationAllowlist: false });
  });

  it('passes nothing when the lint namespace exists but the key does not', () => {
    const path = writeConfig('{ "lint": {} }');
    expect(readLintOptions(path)).toEqual({});
  });

  it('passes nothing when the config carries no lint namespace', () => {
    const path = writeConfig('{ "outdated": { "allowlist": [] } }');
    expect(readLintOptions(path)).toEqual({});
  });

  it('passes nothing when the config file is absent', () => {
    expect(readLintOptions(join(dir, 'devcheck.config.json'))).toEqual({});
  });

  it('warns and passes nothing on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const path = writeConfig('{ "lint": ');
    expect(readLintOptions(path)).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it('warns and passes nothing on a value that is neither false nor a string array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of ['"search_results"', 'true', '42', '[1, 2]', '{}']) {
      const path = writeConfig(`{ "lint": { "truncationAllowlist": ${value} } }`);
      expect(readLintOptions(path), value).toEqual({});
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });
});

describe('lint-mcp · truncationAllowlist precedence', () => {
  it('config beats the env var', () => {
    process.env[ENV] = 'unrelated_tool';
    const path = writeConfig('{ "lint": { "truncationAllowlist": ["search_results"] } }');
    expect(truncationWarnings(readLintOptions(path))).toBe(0);
  });

  it('a config that declares nothing leaves the env-var fallback intact', () => {
    process.env[ENV] = 'search_results';
    const path = writeConfig('{ "lint": {} }');
    expect(truncationWarnings(readLintOptions(path))).toBe(0);
  });

  it('config wins when it declares a different tool than the env var', () => {
    process.env[ENV] = 'search_results';
    const path = writeConfig('{ "lint": { "truncationAllowlist": ["unrelated_tool"] } }');
    expect(truncationWarnings(readLintOptions(path))).toBe(1);
  });

  it('warns with neither the config nor the env var set', () => {
    const path = writeConfig('{}');
    expect(truncationWarnings(readLintOptions(path))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI over a project tree
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-mcp.ts');

const TOOLS = 'src/mcp-server/tools/definitions';
const PROMPTS = 'src/mcp-server/prompts/definitions';
const EXAMPLE_PROMPTS = 'examples/mcp-server/prompts/definitions';

/** A tool definition that passes every rule. */
const CLEAN_TOOL = `import { z } from 'zod';

export const echoTool = {
  name: 'fixture_echo',
  description: 'Echo a message back to the caller.',
  input: z.object({ message: z.string().describe('Message to echo') }),
  output: z.object({ echoed: z.string().describe('The echoed message') }),
  handler: async (input: { message: string }) => ({ echoed: input.message }),
  format: (result: { echoed: string }) => [{ type: 'text', text: result.echoed }],
};
`;

/** A prompt definition that passes every rule. */
const CLEAN_PROMPT = `export const greetPrompt = {
  name: 'fixture_greet',
  description: 'Greet the user.',
  generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello.' } }],
};
`;

/** Fails `name-format` (error). */
const BAD_NAME_TOOL = CLEAN_TOOL.replace("'fixture_echo'", "'Bad Name'");

/** Fails `describe-on-fields` (warning). */
const UNDESCRIBED_TOOL = CLEAN_TOOL.replace(
  "z.string().describe('Message to echo')",
  'z.string()',
).replace("'fixture_echo'", "'fixture_undescribed'");

/** A server.json that passes every rule. */
const CLEAN_SERVER_JSON =
  '{ "name": "io.github.fixture/fixture-server", "description": "A fixture server.", "version": "1.0.0" }\n';

/** An import of a package the project never installed — the optional-peer case. */
const MISSING_PEER = `import 'mcp-lint-probe-missing-peer';

export const unreachable = 1;
`;

/** Work done at module load that throws — a config read, an eager client. */
const THROWS_AT_LOAD = `throw new Error('fixture: API key read at module load');
`;

/** Rejected by the transpiler, which Bun reports as an AggregateError of build messages. */
const SYNTAX_ERROR = `export const broken = {;
`;

/** An AggregateError two levels deep, so the innermost cause is only reachable by recursion. */
const NESTED_AGGREGATE = `throw new AggregateError(
  [new AggregateError([new Error('innermost cause')], 'middle layer')],
  'outer layer',
);
`;

const IMPORT_FAILED_SEE = 'See: framework-skills/api-linter/SKILL.md#definition-import-failed';

/** The start of the `definition-import-failed` line for a file, path relative to the project root. */
function importFailure(file: string): string {
  return `  ✗ [definition-import-failed] ${file}: `;
}

/** Strings a run with any load failure must never end on. */
const PASSING_ENDINGS = ['All definitions valid.', 'Passed with', 'Skipping lint.'] as const;

interface LintRun {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** Spawns the real script under Bun with `cwd` as the project root. */
function runLint(cwd: string): LintRun {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf-8' });
  return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

function expectNoPassingEnding(run: LintRun): void {
  for (const ending of PASSING_ENDINGS) {
    expect(`${run.stdout}${run.stderr}`).not.toContain(ending);
  }
}

describe('lint-mcp · CLI over a project tree', () => {
  let root: string;

  /**
   * Writes `files` (project-relative path → contents) under `root`. The project
   * links this repo's `node_modules` so fixture definitions resolve `zod`.
   */
  function project(files: Record<string, string>): string {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    return root;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lint-mcp-cli-'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  });

  afterEach(() => {
    // Drop the link first so the recursive remove can never reach the repo's node_modules.
    unlinkSync(join(root, 'node_modules'));
    rmSync(root, { force: true, recursive: true });
  });

  describe('unchanged paths', () => {
    it('skips a project with no definition files and no server.json', () => {
      const run = runLint(root);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('No MCP definition files or server.json found. Skipping lint.\n');
      expect(run.stderr).toBe('');
    });

    it('keeps the all-clean output without server.json', () => {
      const run = runLint(
        project({
          [`${TOOLS}/echo.tool.ts`]: CLEAN_TOOL,
          [`${PROMPTS}/greet.prompt.ts`]: CLEAN_PROMPT,
        }),
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(
        'Linting 1 tool(s), 0 resource(s), 1 prompt(s) from 2 file(s)...\n\nAll definitions valid.\n',
      );
      expect(run.stderr).toBe('');
    });

    it('keeps the all-clean output with server.json', () => {
      const run = runLint(
        project({
          [`${TOOLS}/echo.tool.ts`]: CLEAN_TOOL,
          [`${EXAMPLE_PROMPTS}/greet.prompt.ts`]: CLEAN_PROMPT,
          'server.json': CLEAN_SERVER_JSON,
        }),
      );
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(
        'Linting 1 tool(s), 0 resource(s), 1 prompt(s) from 2 file(s) + server.json...\n\nAll definitions valid.\n',
      );
      expect(run.stderr).toBe('');
    });

    it('lints a lone server.json', () => {
      const run = runLint(project({ 'server.json': CLEAN_SERVER_JSON }));
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('Linting server.json...\n\nAll definitions valid.\n');
    });

    it('skips definition files that import cleanly but export no definitions', () => {
      const run = runLint(project({ [`${TOOLS}/helper.tool.ts`]: 'export const helper = 1;\n' }));
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('Scanned 1 files but found no definitions. Skipping lint.\n');
    });

    it('passes with a warning-only tree', () => {
      const run = runLint(project({ [`${TOOLS}/undescribed.tool.ts`]: UNDESCRIBED_TOOL }));
      expect(run.code).toBe(0);
      expect(run.stderr).toContain('  ⚠ [describe-on-fields] ');
      expect(run.stdout).toContain('\nPassed with 1 warning(s).\n');
    });

    it('fails on a rule error', () => {
      const run = runLint(project({ [`${TOOLS}/bad-name.tool.ts`]: BAD_NAME_TOOL }));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('  ✗ [name-format] ');
      expect(run.stderr).toContain('\nFailed: 1 error(s), 0 warning(s).\n');
    });
  });

  describe('definition-import-failed', () => {
    it('fails one file of several and still lints the rest, nested and across search dirs', () => {
      const run = runLint(
        project({
          [`${TOOLS}/echo.tool.ts`]: CLEAN_TOOL,
          [`${EXAMPLE_PROMPTS}/greet.prompt.ts`]: CLEAN_PROMPT,
          [`${TOOLS}/nested/deeper/peer.tool.ts`]: MISSING_PEER,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(
        'Linting 1 tool(s), 0 resource(s), 1 prompt(s) from 2 of 3 file(s)...',
      );
      expect(run.stderr).toContain(
        `${importFailure(`${TOOLS}/nested/deeper/peer.tool.ts`)}Cannot find package 'mcp-lint-probe-missing-peer'`,
      );
      expect(run.stderr).toContain(`\n${IMPORT_FAILED_SEE}\n`);
      expect(run.stderr).toContain('\nFailed: 1 error(s), 0 warning(s).\n');
      expect(run.stderr).not.toContain('Warning: Failed to import');
      expectNoPassingEnding(run);
    });

    it('fails when every file fails and there is no server.json', () => {
      const run = runLint(
        project({
          [`${TOOLS}/peer.tool.ts`]: MISSING_PEER,
          [`${PROMPTS}/config.prompt.ts`]: THROWS_AT_LOAD,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(
        'Linting 0 tool(s), 0 resource(s), 0 prompt(s) from 0 of 2 file(s)...',
      );
      expect(run.stderr).toContain(importFailure(`${TOOLS}/peer.tool.ts`));
      expect(run.stderr).toContain(importFailure(`${PROMPTS}/config.prompt.ts`));
      expect(run.stderr).toContain('\nFailed: 2 error(s), 0 warning(s).\n');
      expectNoPassingEnding(run);
    });

    it('fails when every file fails alongside a clean server.json', () => {
      const run = runLint(
        project({
          [`${TOOLS}/peer.tool.ts`]: MISSING_PEER,
          [`${PROMPTS}/config.prompt.ts`]: THROWS_AT_LOAD,
          'server.json': CLEAN_SERVER_JSON,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(
        'Linting 0 tool(s), 0 resource(s), 0 prompt(s) from 0 of 2 file(s) + server.json...',
      );
      expect(run.stderr).toContain('\nFailed: 2 error(s), 0 warning(s).\n');
      expectNoPassingEnding(run);
    });

    it('reports a throw at module load with its message', () => {
      const run = runLint(
        project({
          [`${TOOLS}/echo.tool.ts`]: CLEAN_TOOL,
          [`${TOOLS}/config.tool.ts`]: THROWS_AT_LOAD,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `${importFailure(`${TOOLS}/config.tool.ts`)}fixture: API key read at module load\n${IMPORT_FAILED_SEE}\n`,
      );
      expect(run.stderr).toContain('\nFailed: 1 error(s), 0 warning(s).\n');
    });

    it('reports a syntax error with the transpiler causes, not just their count', () => {
      const run = runLint(
        project({
          [`${TOOLS}/echo.tool.ts`]: CLEAN_TOOL,
          [`${TOOLS}/broken.tool.ts`]: SYNTAX_ERROR,
        }),
      );
      const line = run.stderr
        .split('\n')
        .find((text) => text.startsWith(importFailure(`${TOOLS}/broken.tool.ts`)));

      expect(run.code).toBe(1);
      // Bun rejects with an AggregateError whose own message ends at the file
      // name (`N errors building "…/broken.tool.ts"`); the causes follow it.
      expect(line).toMatch(/broken\.tool\.ts" \(\S.*\)$/);
      expect(run.stderr).toContain('\nFailed: 1 error(s), 0 warning(s).\n');
    });

    it('surfaces every level of a nested AggregateError', () => {
      const run = runLint(project({ [`${TOOLS}/aggregate.tool.ts`]: NESTED_AGGREGATE }));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `${importFailure(`${TOOLS}/aggregate.tool.ts`)}outer layer (middle layer (innermost cause))\n`,
      );
    });

    it('reports a thrown non-Error and an Error with no message', () => {
      const run = runLint(
        project({
          [`${TOOLS}/string.tool.ts`]: "throw 'fixture string thrown';\n",
          [`${TOOLS}/empty.tool.ts`]: 'throw new Error();\n',
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `${importFailure(`${TOOLS}/string.tool.ts`)}fixture string thrown\n`,
      );
      expect(run.stderr).toContain(`${importFailure(`${TOOLS}/empty.tool.ts`)}Error\n`);
      expect(run.stderr).toContain('\nFailed: 2 error(s), 0 warning(s).\n');
    });

    it('reports an import failure together with rule errors and warnings', () => {
      const run = runLint(
        project({
          [`${TOOLS}/bad-name.tool.ts`]: BAD_NAME_TOOL,
          [`${TOOLS}/undescribed.tool.ts`]: UNDESCRIBED_TOOL,
          [`${TOOLS}/peer.tool.ts`]: MISSING_PEER,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(importFailure(`${TOOLS}/peer.tool.ts`));
      expect(run.stderr).toContain('  ✗ [name-format] ');
      expect(run.stderr).toContain('  ⚠ [describe-on-fields] ');
      expect(run.stderr).toContain('\nFailed: 2 error(s), 1 warning(s).\n');
      expectNoPassingEnding(run);
    });

    it('fails a run whose only other diagnostics are warnings', () => {
      const run = runLint(
        project({
          [`${TOOLS}/undescribed.tool.ts`]: UNDESCRIBED_TOOL,
          [`${TOOLS}/peer.tool.ts`]: MISSING_PEER,
        }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('\nFailed: 1 error(s), 1 warning(s).\n');
      expectNoPassingEnding(run);
    });
  });

  describe('server-json-parse', () => {
    const SERVER_JSON_FAILURE = '  ✗ [server-json-parse] server.json: ';
    const SERVER_JSON_SEE = 'See: framework-skills/api-linter/SKILL.md#server-json-rules';

    it('fails a malformed server.json and still lints the definitions', () => {
      const run = runLint(
        project({ [`${TOOLS}/echo.tool.ts`]: CLEAN_TOOL, 'server.json': '{ "name": \n' }),
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(
        'Linting 1 tool(s), 0 resource(s), 0 prompt(s) from 1 file(s)...',
      );
      expect(run.stderr).toMatch(/ {2}✗ \[server-json-parse\] server\.json: \S.*\n/);
      expect(run.stderr).toContain(`\n${SERVER_JSON_SEE}\n`);
      expect(run.stderr).toContain('\nFailed: 1 error(s), 0 warning(s).\n');
      expect(run.stderr).not.toContain('Warning: Failed to parse');
      expectNoPassingEnding(run);
    });

    it('fails a malformed server.json in a project with no definition files', () => {
      const run = runLint(project({ 'server.json': '{ "name": \n' }));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(SERVER_JSON_FAILURE);
      expect(run.stderr).toContain('\nFailed: 1 error(s), 0 warning(s).\n');
      expectNoPassingEnding(run);
    });

    it('counts a malformed server.json and an import failure together', () => {
      const run = runLint(
        project({ [`${TOOLS}/peer.tool.ts`]: MISSING_PEER, 'server.json': '[1, 2,\n' }),
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(SERVER_JSON_FAILURE);
      expect(run.stderr).toContain(importFailure(`${TOOLS}/peer.tool.ts`));
      expect(run.stderr).toContain('\nFailed: 2 error(s), 0 warning(s).\n');
    });
  });
});
