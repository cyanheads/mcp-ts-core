/**
 * @fileoverview Tests for scripts/check-docs-sync.ts — the CLAUDE.md/AGENTS.md
 * parity gate devcheck runs as a hard failure. Each agent tool reads the file
 * named for it, so drift leaves one agent on a stale protocol. The check covers
 * the project-root pair and, where it exists, the framework's `templates/` pair.
 * Spawns the real script against a temp project root, since it reads the cwd and
 * exits.
 * @module tests/unit/scripts/check-docs-sync.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/check-docs-sync.ts',
);

const PROTOCOL = '# Developer Protocol\n\n- Logic throws, framework catches.\n';

let dir: string;

function write(relPath: string, content: string): void {
  mkdirSync(dirname(resolve(dir, relPath)), { recursive: true });
  writeFileSync(resolve(dir, relPath), content);
}

function runCheck(): { code: number; out: string } {
  const result = spawnSync('bun', ['run', SCRIPT], { cwd: dir, encoding: 'utf-8' });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describe('check-docs-sync', () => {
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'check-docs-sync-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes a byte-identical root pair', () => {
    write('CLAUDE.md', PROTOCOL);
    write('AGENTS.md', PROTOCOL);

    const { code, out } = runCheck();

    expect(code).toBe(0);
    expect(out).toContain('CLAUDE.md and AGENTS.md are in sync.');
  });

  it('fails a drifted root pair and prints the diverging line from each file', () => {
    write('CLAUDE.md', PROTOCOL);
    write('AGENTS.md', PROTOCOL.replace('framework catches', 'handler catches'));

    const { code, out } = runCheck();

    expect(code).toBe(1);
    expect(out).toContain('CLAUDE.md and AGENTS.md have drifted:');
    expect(out).toContain('   3  - CLAUDE.md: - Logic throws, framework catches.');
    expect(out).toContain('   3  + AGENTS.md: - Logic throws, handler catches.');
    expect(out).not.toContain('   1  ');
  });

  it('passes when only one file of the pair exists', () => {
    write('CLAUDE.md', PROTOCOL);

    const { code, out } = runCheck();

    expect(code).toBe(0);
    expect(out).toContain('CLAUDE.md found. No AGENTS.md found');
  });

  it('fails a drifted templates/ pair even when the root pair is in sync', () => {
    write('CLAUDE.md', PROTOCOL);
    write('AGENTS.md', PROTOCOL);
    write('templates/CLAUDE.md', PROTOCOL);
    write('templates/AGENTS.md', `${PROTOCOL}- Extra rule.\n`);

    const { code, out } = runCheck();

    expect(code).toBe(1);
    expect(out).toContain('templates/CLAUDE.md and templates/AGENTS.md have drifted:');
    expect(out).toContain('+ templates/AGENTS.md: - Extra rule.');
  });

  it('caps the printed drift at 20 lines and counts the rest', () => {
    const lines = (tag: string) =>
      Array.from({ length: 25 }, (_, index) => `${tag} line ${index}`).join('\n');
    write('CLAUDE.md', lines('claude'));
    write('AGENTS.md', lines('agents'));

    const { code, out } = runCheck();

    expect(code).toBe(1);
    expect(out).toContain('  20  - CLAUDE.md: claude line 19');
    expect(out).not.toContain('claude line 20');
    expect(out).toContain('... and 5 more diverging line(s)');
  });
});
