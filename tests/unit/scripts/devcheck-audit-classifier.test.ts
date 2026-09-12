/**
 * @fileoverview Tests devcheck's Security Audit classification of `bun audit`
 * output (issue #390). Bun 1.4 changed the block header from `name  range` to
 * `name@version` and the dependency-path separator from `›` to `>`, and prints
 * `(direct dependency)` for a direct dependency's path. The classifier must
 * demote an all-transitive high/critical set to a warning and still fail on a
 * direct one, on both the pre-1.4 and the 1.4 shape.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location, so the
 * reproduction copies the self-contained script into a temp scaffold and
 * replaces `bun audit` with a PATH shim serving a fixed report — a real
 * registry cannot be made to produce a given advisory set on demand.
 *
 * @module tests/unit/scripts/devcheck-audit-classifier.test
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

const FORM_DATA_ADVISORIES = [
  '  critical: form-data uses unsafe random function in form-data for choosing boundary (<2.5.4) - https://github.com/advisories/GHSA-fjxv-7rqg-78g4',
  '  high: form-data: CRLF injection in form-data via unescaped multipart field names and filenames (<2.5.6) - https://github.com/advisories/GHSA-hmw2-7cc7-3qxx',
];
const LODASH_ADVISORY =
  '  high: Command Injection in lodash (<4.17.21) - https://github.com/advisories/GHSA-35jh-r3h4-6jhm';

/** `bun audit` on Bun 1.4: `name@version` header, ASCII `>` separator. */
const BUN_14_TRANSITIVE = ['form-data@2.3.3', '  request > form-data', ...FORM_DATA_ADVISORIES];
const BUN_14_DIRECT = ['lodash@4.17.15', '  (direct dependency)', LODASH_ADVISORY];

/** `bun audit` before 1.4: two-space header gap, U+203A separator. */
const BUN_13_TRANSITIVE = ['form-data  2.3.3', '  request › form-data', ...FORM_DATA_ADVISORIES];
const BUN_13_DIRECT = ['lodash  4.17.15', '  lodash', LODASH_ADVISORY];

function report(version: string, blocks: readonly (readonly string[])[], summary: string): string {
  return [`bun audit v${version}`, '', ...blocks.flatMap((block) => [...block, '']), summary].join(
    '\n',
  );
}

interface Scaffold {
  dir: string;
  shimDir: string;
}

/**
 * A non-git scaffold carrying devcheck plus a `bun` shim that answers `audit`
 * from a fixture (exit 1, as `bun audit` does on findings) and delegates
 * everything else to the real binary.
 */
function makeScaffold(dependencies: Record<string, string>, audit: string): Scaffold {
  const dir = mkdtempSync(resolve(tmpdir(), 'devcheck-audit-classifier-'));
  mkdirSync(resolve(dir, 'scripts'));
  const shimDir = resolve(dir, 'pm-shim');
  mkdirSync(shimDir);
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(dir, 'scripts', 'devcheck.ts'));
  writeFileSync(
    resolve(dir, 'package.json'),
    `${JSON.stringify({ name: 'scaffold', version: '0.0.0', dependencies }, null, 2)}\n`,
  );
  writeFileSync(resolve(dir, 'audit.txt'), `${audit}\n`);
  writeFileSync(
    resolve(shimDir, 'bun'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "1.4.0" ;;',
      `  audit) cat "${resolve(dir, 'audit.txt')}"; exit 1 ;;`,
      `  *) exec "${REAL_BUN}" "$@" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, shimDir };
}

function runAuditCheck({ dir, shimDir }: Scaffold): { code: number; out: string } {
  const result = spawnSync(
    REAL_BUN,
    ['run', 'scripts/devcheck.ts', '--only', 'Audit', '--no-fix'],
    {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    },
  );
  return {
    code: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`.replace(/\[[0-9;]*m/g, ''),
  };
}

/** The step's own summary row, isolated from the `--only` skip notices. */
function summaryLine(out: string): string {
  return out.split('\n').find((line) => line.startsWith('Security Audit')) ?? '';
}

describe('devcheck Security Audit classification of bun audit output (#390)', () => {
  const scaffolds: Scaffold[] = [];

  const scaffold = (dependencies: Record<string, string>, audit: string) => {
    const made = makeScaffold(dependencies, audit);
    scaffolds.push(made);
    return made;
  };

  beforeEach(() => {
    scaffolds.length = 0;
  });

  afterEach(() => {
    for (const { dir } of scaffolds) rmSync(dir, { recursive: true, force: true });
  });

  it('demotes an all-transitive high/critical set to a warning on Bun 1.4 output', () => {
    const { code, out } = runAuditCheck(
      scaffold(
        { request: '^2.88.2' },
        report('1.4.0 (34cbb9a40)', [BUN_14_TRANSITIVE], '2 vulnerabilities (1 critical, 1 high)'),
      ),
    );

    expect(summaryLine(out)).toContain('WARNING');
    expect(code).toBe(0);
    expect(out).toContain('in transitive deps (upstream, no direct fix available)');
    expect(out).toContain('form-data 2.3.3 (via request)');
  });

  it('still fails on a direct-dependency advisory in Bun 1.4 output', () => {
    const { code, out } = runAuditCheck(
      scaffold(
        { lodash: '^4.17.15', request: '^2.88.2' },
        report(
          '1.4.0 (34cbb9a40)',
          [BUN_14_TRANSITIVE, BUN_14_DIRECT],
          '3 vulnerabilities (1 critical, 2 high)',
        ),
      ),
    );

    expect(summaryLine(out)).toContain('FAILED');
    expect(code).toBe(1);
  });

  it('classifies the literal (direct dependency) path as direct without package.json attribution', () => {
    // No dependencies declared, so DIRECT_DEPS cannot be what classifies it:
    // the path line alone has to.
    const { code, out } = runAuditCheck(
      scaffold({}, report('1.4.0 (34cbb9a40)', [BUN_14_DIRECT], '1 vulnerability (1 high)')),
    );

    expect(summaryLine(out)).toContain('FAILED');
    expect(code).toBe(1);
  });

  it('keeps classifying the pre-1.4 output shape', () => {
    const transitive = scaffold(
      { request: '^2.88.2' },
      report('1.3.0', [BUN_13_TRANSITIVE], '2 vulnerabilities (1 critical, 1 high)'),
    );
    const held = runAuditCheck(transitive);
    expect(summaryLine(held.out)).toContain('WARNING');
    expect(held.out).toContain('form-data 2.3.3 (via request)');

    const direct = scaffold(
      { request: '^2.88.2' },
      report('1.3.0', [BUN_13_TRANSITIVE, BUN_13_DIRECT], '3 vulnerabilities (1 critical, 2 high)'),
    );
    expect(summaryLine(runAuditCheck(direct).out)).toContain('FAILED');
  });
});
