/**
 * @fileoverview Tests devcheck's Dependency Freshness attribution for aliased
 * dependencies (issue #398). `bun outdated` prints a row under the *resolved*
 * package name, so `"typescript-v6": "npm:typescript@^6.0.3"` appears as
 * `typescript` — the allowlist, keyed on the `package.json` key, could never
 * match it, and the printed name misidentified the dependency.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location
 * (`scripts/..`), not the cwd, so the reproduction copies the self-contained
 * script into a temp scaffold. `bun outdated` itself is replaced by a PATH shim
 * serving a fixed table: the interesting rows are ones where an update *is*
 * available in range, which a real registry cannot be made to produce on demand.
 *
 * @module tests/unit/scripts/devcheck-outdated-alias.test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

/** Absolute path to the real bun, so the outer invocation bypasses the shim. */
const REAL_BUN = (() => {
  const found = spawnSync('which', ['bun'], { encoding: 'utf-8' }).stdout.trim();
  return found || 'bun';
})();

type Row = readonly [pkg: string, current: string, update: string, latest: string];

/** Renders rows the way `bun outdated` does, borders and all. */
function outdatedTable(rows: readonly Row[]): string {
  const header = ['Package', 'Current', 'Update', 'Latest'];
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]!.length)),
  );
  const render = (cells: readonly string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(' | ')} |`;
  const rule = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;
  const headerLine = render(header);
  return [
    'bun outdated v1.4.0 (fixture)',
    `|${'-'.repeat(headerLine.length - 2)}|`,
    headerLine,
    ...rows.flatMap((row) => [rule, render(row)]),
    rule,
  ].join('\n');
}

interface Scaffold {
  dir: string;
  shimDir: string;
}

/**
 * A non-git scaffold carrying devcheck plus a `bun` shim that answers
 * `outdated` from a fixture and delegates everything else to the real binary.
 */
function makeScaffold(pkg: Record<string, unknown>, allowlist: string[], table: string): Scaffold {
  const dir = mkdtempSync(resolve(tmpdir(), 'devcheck-outdated-alias-'));
  mkdirSync(resolve(dir, 'scripts'));
  const shimDir = resolve(dir, 'pm-shim');
  mkdirSync(shimDir);
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(dir, 'scripts', 'devcheck.ts'));
  writeFileSync(
    resolve(dir, 'package.json'),
    `${JSON.stringify({ name: 'scaffold', version: '0.0.0', ...pkg }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(dir, 'devcheck.config.json'),
    `${JSON.stringify({ outdated: { allowlist } }, null, 2)}\n`,
  );
  writeFileSync(resolve(dir, 'outdated.txt'), `${table}\n`);
  writeFileSync(
    resolve(shimDir, 'bun'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "1.4.0" ;;',
      `  outdated) cat "${resolve(dir, 'outdated.txt')}" ;;`,
      `  *) exec "${REAL_BUN}" "$@" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, shimDir };
}

function runOutdatedCheck({ dir, shimDir }: Scaffold): { code: number; out: string } {
  const result = spawnSync(
    REAL_BUN,
    ['run', 'scripts/devcheck.ts', '--only', 'Outdated', '--no-fix'],
    {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    },
  );
  return {
    code: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`.replace(/\[[0-9;]*m/g, ''),
  };
}

/** The step's own summary row, isolated from the `--only` skip notices. */
function summaryLine(out: string): string {
  return out.split('\n').find((line) => line.startsWith('Dependencies (Outdated)')) ?? '';
}

describe('devcheck outdated attribution for aliased dependencies (#398)', () => {
  const scaffolds: Scaffold[] = [];

  const scaffold = (pkg: Record<string, unknown>, allowlist: string[], rows: readonly Row[]) => {
    const made = makeScaffold(pkg, allowlist, outdatedTable(rows));
    scaffolds.push(made);
    return made;
  };

  beforeEach(() => {
    scaffolds.length = 0;
  });

  afterEach(() => {
    for (const { dir } of scaffolds) rmSync(dir, { recursive: true, force: true });
  });

  it('matches an allowlisted alias that has an in-range update available', () => {
    const { code, out } = runOutdatedCheck(
      scaffold(
        { devDependencies: { 'typescript-v6': 'npm:typescript@^6.0.3' } },
        ['typescript-v6'],
        [['typescript (dev)', '6.0.3', '6.0.4', '7.0.2']],
      ),
    );

    expect(summaryLine(out)).toContain('PASSED');
    expect(code).toBe(0);
    // The range-hold branch cannot be what passed it: 6.0.4 !== 6.0.3.
    expect(out).toContain('typescript-v6 (dev)');
  });

  it('fails an unallowlisted alias with an in-range update', () => {
    const { code, out } = runOutdatedCheck(
      scaffold(
        { devDependencies: { 'typescript-v6': 'npm:typescript@^6.0.3' } },
        [],
        [['typescript (dev)', '6.0.3', '6.0.4', '7.0.2']],
      ),
    );

    expect(summaryLine(out)).toContain('FAILED');
    expect(code).toBe(1);
    expect(out).toContain('typescript-v6 (dev)');
  });

  it('resolves an alias whose target is scoped', () => {
    const { code, out } = runOutdatedCheck(
      scaffold(
        { devDependencies: { 'pdf-v1': 'npm:@acme/pdf-toolkit@^1.2.0' } },
        ['pdf-v1'],
        [['@acme/pdf-toolkit (dev)', '1.2.0', '1.3.0', '2.0.0']],
      ),
    );

    expect(summaryLine(out)).toContain('PASSED');
    expect(code).toBe(0);
    expect(out).toContain('pdf-v1 (dev)');
    expect(out).not.toContain('@acme/pdf-toolkit');
  });

  it('reports ambiguity instead of applying an alias exemption to a shared target', () => {
    const { code, out } = runOutdatedCheck(
      scaffold(
        {
          devDependencies: {
            typescript: '^6.0.0',
            'typescript-v6': 'npm:typescript@^6.0.3',
          },
        },
        ['typescript-v6'],
        [['typescript (dev)', '6.0.3', '6.0.4', '7.0.2']],
      ),
    );

    expect(summaryLine(out)).toContain('FAILED');
    expect(code).toBe(1);
    expect(out).toContain('attribution is ambiguous');
    expect(out).toContain('typescript and typescript-v6');
  });

  it('keeps a direct dependency and an alias on the same target distinct', () => {
    const { code, out } = runOutdatedCheck(
      scaffold(
        {
          devDependencies: {
            typescript: '^7.0.0',
            'typescript-v6': 'npm:typescript@^6.0.3',
          },
        },
        ['typescript-v6'],
        [
          ['typescript (dev)', '6.0.3', '6.0.4', '7.0.2'],
          ['typescript (dev)', '7.0.1', '7.0.2', '7.0.2'],
        ],
      ),
    );

    // The alias is exempt; the direct dependency's own finding still fails.
    expect(summaryLine(out)).toContain('FAILED');
    expect(code).toBe(1);
    expect(out).toContain('| typescript-v6 (dev) | 6.0.3');
    expect(out).toContain('| typescript (dev)    | 7.0.1');
    expect(out).not.toContain('attribution is ambiguous');
  });

  it('preserves peer exclusion, range holds, and unallowlisted findings', () => {
    const held = scaffold(
      {
        dependencies: { hono: '^4.13.7' },
        devDependencies: { vitest: '^4.1.11' },
        peerDependencies: { vitest: '^4.1.0' },
      },
      [],
      [
        // Peer row: the range declares a floor, not the version to track.
        ['vitest (peer)', '4.1.11', '5.0.0', '5.0.0'],
        // Range hold: nothing to adopt without a deliberate range change.
        ['vitest (dev)', '4.1.11', '4.1.11', '5.0.0'],
        ['hono', '4.13.7', '4.13.7 *', '4.13.8 *'],
      ],
    );
    expect(summaryLine(runOutdatedCheck(held).out)).toContain('PASSED');

    const behind = scaffold(
      { dependencies: { hono: '^4.13.7' } },
      [],
      [['hono', '4.13.7', '4.13.8', '4.13.8']],
    );
    expect(summaryLine(runOutdatedCheck(behind).out)).toContain('FAILED');
  });
});
