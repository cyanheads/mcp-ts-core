/**
 * @fileoverview Unit tests for the CLI scaffold entry point.
 * @module tests/unit/cli/init.test
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('CLI init command', () => {
  let originalArgv: string[];
  let originalCwd: string;
  let tempDirs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    originalArgv = [...process.argv];
    originalCwd = process.cwd();
    tempDirs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    for (const dir of tempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cli-test-'));
    tempDirs.push(dir);
    return dir;
  }

  async function runCli(args: string[]): Promise<void> {
    vi.resetModules();
    process.argv = ['node', 'mcp-ts-core', ...args];
    await import('@/cli/init.js');
  }

  function getLoggedOutput(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls
      .flat()
      .map((value: unknown) => String(value))
      .join('\n');
  }

  it('prints usage and exits successfully for --help', async () => {
    await expect(runCli(['--help'])).rejects.toThrow('EXIT:0');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('@cyanheads/mcp-ts-core');
    expect(output).toContain('Usage:');
    expect(output).toContain('mcp-ts-core init [name]');
  });

  it('prints usage and exits with failure for an unknown subcommand', async () => {
    await expect(runCli(['unknown-command'])).rejects.toThrow('EXIT:1');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Usage:');
    expect(output).toContain('mcp-ts-core --help');
  });

  it('prints usage and exits successfully for "init --help" without scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '--help'])).rejects.toThrow('EXIT:0');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Usage:');
    expect(output).toContain('mcp-ts-core init [name]');
    expect(existsSync(join(tempRoot, 'package.json'))).toBe(false);
  });

  it('prints usage and exits successfully for "init -h" without scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '-h'])).rejects.toThrow('EXIT:0');

    expect(existsSync(join(tempRoot, 'package.json'))).toBe(false);
  });

  it('rejects unknown flags on init without scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '--bogus'])).rejects.toThrow('EXIT:1');

    expect(getLoggedOutput(errorSpy)).toContain('unknown flag(s): --bogus');
    expect(existsSync(join(tempRoot, 'package.json'))).toBe(false);
  });

  it('rejects invalid project names before scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '../bad-project'])).rejects.toThrow('EXIT:1');

    expect(getLoggedOutput(errorSpy)).toContain('invalid project name "../bad-project"');
    expect(existsSync(join(tempRoot, '../bad-project'))).toBe(false);
  });

  it('scaffolds a named project with templates, scripts, and external skills', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const dest = join(tempRoot, 'demo-server');
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
    expect(existsSync(join(dest, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dest, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'build.ts'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'devcheck.ts'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'check-framework-antipatterns.ts'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'check-dependency-specifiers.ts'))).toBe(true);
    expect(existsSync(join(dest, 'skills', 'add-tool', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'skills', 'README.md'))).toBe(false);
    expect(existsSync(join(dest, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dest, 'tsconfig.build.json'))).toBe(true);
    expect(existsSync(join(dest, 'biome.json'))).toBe(true);
    expect(existsSync(join(dest, '.gitignore'))).toBe(true);
    expect(existsSync(join(dest, '.dockerignore'))).toBe(true);

    const packageJson = readFileSync(join(dest, 'package.json'), 'utf-8');
    const claude = readFileSync(join(dest, 'CLAUDE.md'), 'utf-8');

    expect(packageJson).toContain('"name": "demo-server"');
    expect(packageJson).not.toContain('{{PACKAGE_NAME}}');
    expect(packageJson).not.toContain('{{FRAMEWORK_VERSION}}');
    expect(claude).toContain('**Server:** demo-server');
    expect(claude).not.toContain('{{PACKAGE_NAME}}');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Scaffolding demo-server');
    expect(output).toContain('Next steps:');
    expect(output).toContain('cd demo-server');
    expect(output).toContain('bun install');
  });

  it('scaffolds in the current directory, skips existing files, and preserves user content', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    writeFileSync(join(tempRoot, 'package.json'), '{"name":"preexisting"}\n');
    writeFileSync(join(tempRoot, 'CLAUDE.md'), 'keep me\n');

    await runCli(['init']);

    expect(readFileSync(join(tempRoot, 'package.json'), 'utf-8')).toBe('{"name":"preexisting"}\n');
    expect(readFileSync(join(tempRoot, 'CLAUDE.md'), 'utf-8')).toBe('keep me\n');
    expect(existsSync(join(tempRoot, 'scripts', 'build.ts'))).toBe(true);
    expect(existsSync(join(tempRoot, 'skills', 'api-auth', 'SKILL.md'))).toBe(true);

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Skipped (already exist):');
    expect(output).toContain('package.json');
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('bun install');
    expect(output).not.toContain('\n    1. cd ');
  });
});
