/**
 * @fileoverview Tests for scripts/release-github.ts — the tag-annotation check
 * that runs before `gh release create --notes-from-tag` publishes the message
 * as the release body, and standalone under `--check`; and the CLI's strict
 * argument parsing (#817).
 * @module tests/unit/scripts/release-github.test
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTagMessage, type TagMessage } from '../../../scripts/release-github.js';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'release-github.ts');

/** Absolute path to the real bun, linked into the sandbox's otherwise empty PATH. */
const REAL_BUN = (() => {
  const found = spawnSync('which', ['bun'], { encoding: 'utf-8' }).stdout.trim();
  return found || 'bun';
})();

const VERSION = '0.13.9';
const LINK = `[CHANGELOG v${VERSION}](https://github.com/cyanheads/probe-mcp-server/blob/main/changelog/0.13.x/${VERSION}.md)`;

function tag(overrides: Partial<TagMessage> = {}): TagMessage {
  return {
    objectType: 'tag',
    subject: 'private canvas scratch, sharper hints',
    body: `- canvas scratch tables stay private to the request (#560)\n- deps: \`@cyanheads/mcp-ts-core\` ^0.13.8 → ^0.13.9\n\n${LINK}`,
    ...overrides,
  };
}

describe('release-github · checkTagMessage', () => {
  it('passes a well-formed annotation', () => {
    expect(checkTagMessage(tag(), VERSION)).toEqual([]);
  });

  it('passes a changelog link that carries the release PR suffix', () => {
    const body = `- a change (#1)\n\n${LINK} · release PR #573`;
    expect(checkTagMessage(tag({ body }), VERSION)).toEqual([]);
  });

  it('rejects a lightweight tag outright', () => {
    const errors = checkTagMessage(tag({ objectType: 'commit' }), VERSION);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('lightweight');
  });

  it('rejects a subject that is too long, carries the version, or lists changes', () => {
    expect(checkTagMessage(tag({ subject: 'x'.repeat(73) }), VERSION)[0]).toContain(
      '73 characters',
    );
    expect(checkTagMessage(tag({ subject: `${VERSION} — fixes` }), VERSION)[0]).toContain(
      'contains the version',
    );
    expect(checkTagMessage(tag({ subject: 'canvas fix; hint fix' }), VERSION)[0]).toContain('";"');
  });

  it('rejects a signature block leaked into the body', () => {
    const body = `- a change\n\n${LINK}\n-----BEGIN SSH SIGNATURE-----\nabc\n-----END SSH SIGNATURE-----`;
    const errors = checkTagMessage(tag({ body }), VERSION);
    expect(errors.some((e) => e.includes('signature block'))).toBe(true);
  });

  it('rejects changelog-style section headers but not bullets that start with the same word', () => {
    const headed = `Fixed:\n- a fix\n\n## Dependencies\n- a bump\n\n${LINK}`;
    expect(checkTagMessage(tag({ body: headed }), VERSION)[0]).toContain(
      '"Fixed:", "## Dependencies"',
    );
    const bullets = `- Fixed the retry predicate (#1)\n- Added a hint\n\n${LINK}`;
    expect(checkTagMessage(tag({ body: bullets }), VERSION)).toEqual([]);
  });

  it('rejects any other colon-terminated label line, such as "Dependency bumps:"', () => {
    const labelled = `Highlights:\n- a change\n\nDependency bumps (dev):\n- a bump\n\n${LINK}`;
    expect(checkTagMessage(tag({ body: labelled }), VERSION)[0]).toContain(
      '"Highlights:", "Dependency bumps (dev):"',
    );
    const colonBullet = `- deps: \`zod\` ^4.6.4 → ^4.6.5\n- Note: a caveat\n\n${LINK}`;
    expect(checkTagMessage(tag({ body: colonBullet }), VERSION)).toEqual([]);
  });

  it('rejects a body whose final line is not this version’s changelog link', () => {
    const trailing = `- a change\n\n${LINK}\n\n42 tests passed; devcheck clean.`;
    expect(checkTagMessage(tag({ body: trailing }), VERSION)[0]).toContain('changelog link');
    const otherVersion = `- a change\n\n${LINK.replaceAll(VERSION, '0.13.8')}`;
    expect(checkTagMessage(tag({ body: otherVersion }), VERSION)[0]).toContain('changelog link');
  });

  it('matches a prerelease version literally in the changelog link', () => {
    const version = '0.14.0-rc.1';
    const body = `- a change\n\n[CHANGELOG v${version}](https://github.com/o/r/blob/main/changelog/0.14.x/${version}.md)`;
    expect(checkTagMessage(tag({ body }), version)).toEqual([]);
  });
});

/**
 * A run that gets past argument parsing goes on to read the tag and publish, so
 * every case runs a copy of the script from a temporary directory no git
 * repository encloses, with a PATH holding only bun and a `git` stand-in that
 * records its arguments and finds no tag. `gh` is not on that PATH at all: a
 * regression stops at the missing tag and never reaches GitHub.
 */
describe('release-github · CLI arguments (#817)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-github-cli-'));
    for (const sub of ['bin', 'scripts']) mkdirSync(join(dir, sub));
    symlinkSync(REAL_BUN, join(dir, 'bin', 'bun'));
    writeFileSync(
      join(dir, 'bin', 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, 'git.log')}"\nexit 0\n`,
      { mode: 0o755 },
    );
    copyFileSync(SCRIPT, join(dir, 'scripts', 'release-github.ts'));
    writeFileSync(join(dir, 'package.json'), '{"name":"probe-mcp-server","version":"0.0.1"}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function release(...args: string[]): {
    code: number;
    gitCalls: string[];
    stderr: string;
    stdout: string;
  } {
    const result = spawnSync(join(dir, 'bin', 'bun'), ['scripts/release-github.ts', ...args], {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        HOME: process.env.HOME,
        PATH: join(dir, 'bin'),
        GIT_CEILING_DIRECTORIES: dirname(dir),
      },
    });
    const log = join(dir, 'git.log');
    return {
      code: result.status ?? -1,
      gitCalls: existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [],
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  it.each(['--help', '-h'])(
    '%s prints usage to stdout and exits 0 before running anything',
    (flag) => {
      const { code, gitCalls, stderr, stdout } = release(flag);
      expect(stdout).toContain('Usage: bun run release:github');
      expect(stdout).toContain('--dry-run');
      expect(stderr).toBe('');
      expect(gitCalls).toEqual([]);
      expect(code).toBe(0);
    },
  );

  it.each([
    ['--dryrun', "'--dryrun'"],
    ['--chek', "'--chek'"],
    ['extra', "'extra'"],
    ['--check=1', "'--check'"],
  ])(
    '%s prints an error naming it and usage to stderr, and exits 1 before running anything',
    (arg, named) => {
      const { code, gitCalls, stderr, stdout } = release(arg);
      expect(stderr).toContain(named);
      expect(stderr).toContain('Usage: bun run release:github');
      expect(stdout).toBe('');
      expect(gitCalls).toEqual([]);
      expect(code).toBe(1);
    },
  );

  it('rejects an unknown flag beside a known one', () => {
    const { code, gitCalls, stderr } = release('--check', '--dryrun');
    expect(stderr).toContain("'--dryrun'");
    expect(gitCalls).toEqual([]);
    expect(code).toBe(1);
  });

  it.each([
    { args: [] },
    { args: ['--check'] },
    { args: ['--dry-run'] },
    { args: ['--check', '--dry-run'] },
  ])('accepts $args and goes on to look up the tag, as before', ({ args }) => {
    const { code, gitCalls, stderr } = release(...args);
    expect(gitCalls).toEqual(['for-each-ref refs/tags/v0.0.1 --format=%(contents:subject)']);
    expect(stderr).toContain('Tag v0.0.1 not found locally');
    expect(code).toBe(1);
  });

  /** Replaces the `git` stand-in with one that reports a publishable annotated tag v0.0.1. */
  function publishableTag(): void {
    const link = '[CHANGELOG v0.0.1](https://github.com/o/r/blob/main/changelog/0.0.x/0.0.1.md)';
    writeFileSync(
      join(dir, 'bin', 'git'),
      [
        '#!/bin/sh',
        'case "$*" in',
        "  *contents:subject*) printf '%s\\n' 'a release' ;;",
        `  *contents:body*) printf '%s\\n\\n%s\\n' '- a change' '${link}' ;;`,
        "  *objecttype*) printf '%s\\n' tag ;;",
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  it('fails the release when gh cannot be started (#823)', () => {
    publishableTag();
    const { code, stderr, stdout } = release();
    expect(stdout).not.toContain('Release v0.0.1 created.');
    expect(stderr).toContain('gh release create failed');
    expect(code).toBe(1);
  });

  // With `gh` absent, a run that reaches `gh release create` fails (#823), so exit 0 proves each
  // flag stopped the run where it says.
  it.each([
    { args: ['--check'], printed: 'Tag v0.0.1 OK.' },
    { args: ['--dry-run'], printed: '[dry-run] gh release create v0.0.1 --verify-tag' },
    { args: ['--check', '--dry-run'], printed: 'Tag v0.0.1 OK.' },
  ])('$args stops before running gh on a publishable tag', ({ args, printed }) => {
    publishableTag();
    const { code, stderr, stdout } = release(...args);
    expect(stdout).toContain(printed);
    expect(stdout).not.toContain('Creating GitHub Release');
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});
