/**
 * @fileoverview Tests for the bundle-content guard in scripts/lint-packaging.ts.
 * Validates that unanchored dev-dir patterns are flagged (issues #172/#207) and
 * that critical runtime paths are protected from accidental stripping.
 * @module tests/unit/scripts/lint-packaging.test
 */

import ignore from 'ignore';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Inline the guard logic (mirrors checkBundleContent in lint-packaging.ts) for
// unit testing without spawning the full script. Keep in sync if the impl changes.
// ---------------------------------------------------------------------------

const KNOWN_DEV_DIRS = ['skills/', '.agents/', '.claude/'];

const CRITICAL_RUNTIME_PATHS = [
  'node_modules/@opentelemetry/api/build/src/',
  'node_modules/@modelcontextprotocol/sdk/dist/',
  'node_modules/@cyanheads/mcp-ts-core/dist/',
  'dist/index.js',
];

function evalBundleGuard(rawIgnoreContent: string): string[] {
  const errors: string[] = [];
  const lines = rawIgnoreContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const ig = ignore().add(lines);

  // Check 5: dev dirs must be excluded at root.
  for (const dir of KNOWN_DEV_DIRS) {
    const probe = `${dir}README.md`;
    if (!ig.ignores(probe)) {
      errors.push(`dev-dir-not-excluded:${dir}`);
    }
  }

  // Check 6: unanchored patterns also strip runtime paths under node_modules.
  for (const dir of KNOWN_DEV_DIRS) {
    const name = dir.replace(/\/$/, '');
    const runtimeProbe = `node_modules/some-pkg/${name}/index.js`;
    if (ig.ignores(runtimeProbe)) {
      errors.push(`unanchored-strips-runtime:${dir}`);
    }
  }

  // Check 7: critical runtime paths must not be stripped.
  for (const critPath of CRITICAL_RUNTIME_PATHS) {
    if (ig.ignores(critPath)) {
      errors.push(`runtime-path-stripped:${critPath}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lint-packaging · bundle-content guard', () => {
  describe('dev-dir exclusion (check 5)', () => {
    it('passes with anchored root patterns', () => {
      const content = '/skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/\n/Dockerfile\n/bun.lock';
      expect(
        evalBundleGuard(content).filter((e) => e.startsWith('dev-dir-not-excluded:')),
      ).toHaveLength(0);
    });

    it('flags a dev dir that is entirely missing from the ignore file', () => {
      // Only exclude some dirs, leave out skills/
      const content = '/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = evalBundleGuard(content);
      expect(errors).toContain('dev-dir-not-excluded:skills/');
      // The others are excluded
      expect(errors).not.toContain('dev-dir-not-excluded:.agents/');
    });
  });

  describe('unanchored pattern strips runtime paths (check 6)', () => {
    it('passes with anchored patterns — no runtime path stripping', () => {
      const content = '/skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = evalBundleGuard(content);
      expect(errors.filter((e) => e.startsWith('unanchored-strips-runtime:'))).toHaveLength(0);
    });

    it('flags unanchored skills/ pattern that also strips node_modules/x/skills/', () => {
      // Unanchored `skills/` matches node_modules/some-pkg/skills/index.js too.
      const content = 'skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = evalBundleGuard(content);
      expect(errors).toContain('unanchored-strips-runtime:skills/');
    });

    it('flags all three unanchored dev-dir patterns', () => {
      const content = 'skills/\n.agents/\n.claude/';
      const errors = evalBundleGuard(content);
      const unanchored = errors.filter((e) => e.startsWith('unanchored-strips-runtime:'));
      expect(unanchored).toHaveLength(3);
    });

    it('flags a mix of anchored and unanchored entries', () => {
      const content = '/skills/\n.agents/\n/.claude/';
      const errors = evalBundleGuard(content);
      const unanchored = errors.filter((e) => e.startsWith('unanchored-strips-runtime:'));
      // .agents/ is unanchored → strips nested runtime paths
      expect(unanchored).toContain('unanchored-strips-runtime:.agents/');
      // /skills/ and /.claude/ are anchored → no nested stripping
      expect(unanchored).not.toContain('unanchored-strips-runtime:skills/');
      expect(unanchored).not.toContain('unanchored-strips-runtime:.claude/');
    });
  });

  describe('critical-runtime-path protection (check 7)', () => {
    it('passes when no runtime paths are stripped', () => {
      const content = '/skills/\n/.agents/\n/.claude/';
      expect(
        evalBundleGuard(content).filter((e) => e.startsWith('runtime-path-stripped:')),
      ).toHaveLength(0);
    });

    it('flags a pattern that strips all node_modules paths', () => {
      const content = 'node_modules/**\n/skills/';
      const errors = evalBundleGuard(content);
      const stripped = errors.filter((e) => e.startsWith('runtime-path-stripped:'));
      expect(stripped.some((e) => e.includes('node_modules/@opentelemetry'))).toBe(true);
    });

    it('flags a pattern that strips dist/', () => {
      const content = 'dist/\n/skills/';
      const errors = evalBundleGuard(content);
      const stripped = errors.filter((e) => e.startsWith('runtime-path-stripped:'));
      expect(stripped).toContain('runtime-path-stripped:dist/index.js');
    });
  });

  describe('edge cases', () => {
    it('ignores comment lines', () => {
      const content = '# this is a comment\n/skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = evalBundleGuard(content);
      expect(errors.filter((e) => e.startsWith('dev-dir-not-excluded:'))).toHaveLength(0);
      expect(errors.filter((e) => e.startsWith('unanchored-strips-runtime:'))).toHaveLength(0);
    });

    it('handles empty .mcpbignore — all dev dirs unexcluded', () => {
      const errors = evalBundleGuard('');
      expect(errors.filter((e) => e.startsWith('dev-dir-not-excluded:')).length).toBe(3);
    });
  });
});
