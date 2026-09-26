/**
 * @fileoverview Tests for scripts/release-github.ts — the tag-annotation check
 * that runs before `gh release create --notes-from-tag` publishes the message
 * as the release body, and standalone under `--check`.
 * @module tests/unit/scripts/release-github.test
 */

import { describe, expect, it } from 'vitest';
import { checkTagMessage, type TagMessage } from '../../../scripts/release-github.js';

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
