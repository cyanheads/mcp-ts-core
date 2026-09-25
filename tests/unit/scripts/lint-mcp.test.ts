/**
 * @fileoverview Tests for scripts/lint-mcp.ts — the `lint.truncationAllowlist`
 * read from `devcheck.config.json` (issue #388). Imports the real implementation
 * and feeds the resolved options straight into `validateDefinitions`, so the
 * precedence rungs are exercised through the same path the CLI takes rather than
 * through a copy of its logic.
 * @module tests/unit/scripts/lint-mcp.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
