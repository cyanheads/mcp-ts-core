/**
 * @fileoverview Integration test for when framework config is parsed (#746).
 * Importing any package subpath with an invalid framework variable succeeds
 * under Bun and Node, because nothing parses config at import; `createApp()`
 * then fails startup with the configuration banner naming the variable.
 * @module tests/integration/bad-env-import.int.test
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();
const DIST_INDEX = resolve(REPO_ROOT, 'dist/index.js');
const RUNTIMES = ['bun', 'node'] as const;

type ExportTarget = string | { import?: string; default?: string };

/**
 * Every subpath's built module, as a file URL, keyed by subpath. `/testing/vitest`
 * is left out: it registers fixtures with `test.extend` at load, so it imports
 * only inside a running Vitest, whatever the environment holds.
 */
async function subpathModules(): Promise<Record<string, string>> {
  const pkg = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, ExportTarget>;
  };
  const modules: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const file = typeof target === 'string' ? target : (target.import ?? target.default);
    if (subpath !== './testing/vitest' && file?.endsWith('.js')) {
      modules[subpath] = pathToFileURL(resolve(REPO_ROOT, file)).href;
    }
  }
  return modules;
}

/** Runs `args` under `runtime` with `env` added; resolves with the exit code and output. */
async function run(
  runtime: (typeof RUNTIMES)[number],
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(runtime, args, {
      cwd,
      env: { ...process.env, DEBUG: '', ...env },
      timeout: 30_000,
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string; stdout?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : -1,
      stderr: failed.stderr ?? '',
      stdout: failed.stdout ?? '',
    };
  }
}

describe('framework config is parsed at startup, never at import (#746)', () => {
  let cwd: string;
  let modules: Record<string, string>;

  beforeAll(async () => {
    // An empty working directory, so no .env can contribute a value.
    cwd = await mkdtemp(join(tmpdir(), 'mcp-bad-env-'));
    modules = await subpathModules();
  });

  afterAll(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it.each(RUNTIMES)('imports every subpath under %s with MCP_LOG_LEVEL=abc', async (runtime) => {
    const script = `const failures = []; for (const [subpath, url] of Object.entries(${JSON.stringify(modules)})) { try { await import(url); } catch (error) { failures.push(subpath + ': ' + (error?.message ?? String(error))); } } console.log(JSON.stringify(failures));`;
    const args = runtime === 'node' ? ['--input-type=module', '-e', script] : ['-e', script];

    const result = await run(runtime, args, { MCP_LOG_LEVEL: 'abc' }, cwd);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null')).toEqual([]);
    expect(Object.keys(modules)).toEqual(expect.arrayContaining(['.', './worker', './testing']));
  });

  it.each(
    RUNTIMES.flatMap((runtime) => [
      [runtime, 'MCP_LOG_LEVEL', 'abc', 'logLevel'],
      [runtime, 'CANVAS_DEFAULT_ROW_LIMIT', '-1', 'canvas.defaultRowLimit'],
    ]),
  )('fails createApp() under %s with a banner naming %s', async (runtime, name, value, path) => {
    const result = await run(runtime, [DIST_INDEX], { [name]: value }, cwd);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Configuration error — server failed to start');
    expect(result.stderr).toContain(`  - ${name} (${path}): `);
  });
});
