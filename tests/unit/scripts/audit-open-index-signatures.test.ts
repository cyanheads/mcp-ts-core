/**
 * @fileoverview Tests for scripts/audit-open-index-signatures.ts — the
 * framework-only devcheck step that fails an interface or type-literal alias
 * mixing named members with an open `[key: string]: unknown | any` index signature
 * (issue #123), unless an `allow open-indexed-named` comment leads or trails the
 * signature. Spawns the real script in a temp git repository, since it audits the
 * tracked, non-test `.ts` files under `src/` of the cwd.
 * @module tests/unit/scripts/audit-open-index-signatures.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/audit-open-index-signatures.ts',
);

let dir: string;

/** Writes each file and stages it — the audit reads the `git ls-files src` list. */
function track(files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, relPath)), { recursive: true });
    writeFileSync(resolve(dir, relPath), content);
  }
  const added = spawnSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir });
  if (added.status !== 0) throw new Error(`git add failed: ${added.stderr}`);
}

function runAudit(): { code: number; out: string } {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd: dir, encoding: 'utf-8' });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/** An interface and a type-literal alias that mix named members with an open index. */
const UNANNOTATED = `export interface AuthBag {
  token: string;
  scopes: string[];
  [key: string]: unknown;
}

export type MetaBag = {
  id: string;
  [key: string]: any;
};
`;

describe('audit-open-index-signatures', () => {
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'open-index-audit-'));
    const init = spawnSync('git', ['init', '-q'], { cwd: dir });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails an interface and a type alias that mix named members with an open index', () => {
    track({ 'src/types.ts': UNANNOTATED });

    const { code, out } = runAudit();

    expect(code).toBe(1);
    expect(out).toContain('Found 2 open-indexed-named interface(s) without an opt-out in src/');
    expect(out).toContain('src/types.ts:4  AuthBag\n    named: token, scopes');
    expect(out).toContain('index: [key: string]: unknown');
    expect(out).toContain('src/types.ts:9  MetaBag\n    named: id');
    expect(out).toContain('index: [key: string]: any');
  });

  it('passes opted-out signatures, closed or index-only shapes, and files outside the audit', () => {
    track({
      'src/types.ts': `export interface LeadingOptOut {
  id: string;
  // allow open-indexed-named: deliberate extensibility bag
  [key: string]: unknown;
}

export interface TrailingOptOut {
  id: string;
  [key: string]: unknown; // allow open-indexed-named: passthrough record
}

export interface IndexOnly {
  [key: string]: unknown;
}

export interface TypedIndex {
  id: string;
  [key: string]: string;
}
`,
      'src/types.test.ts': UNANNOTATED,
      'src/ambient.d.ts': UNANNOTATED,
      'src/removed.ts': UNANNOTATED,
    });
    // Tracked but deleted from the worktree: `git ls-files` still lists it.
    rmSync(resolve(dir, 'src/removed.ts'));

    const { code, out } = runAudit();

    expect(code).toBe(0);
    expect(out).toContain(
      'No un-annotated open-indexed-named interfaces in src/ (1 file(s) scanned) (2 opted out).',
    );
  });
});
