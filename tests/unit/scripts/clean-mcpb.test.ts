/**
 * @fileoverview Tests for scripts/clean-mcpb.ts — the agent-doc entry filter
 * behind the post-pack strip (issue #230). Imports the real implementation.
 * @module tests/unit/scripts/clean-mcpb.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../../scripts/clean-mcpb.js';

describe('clean-mcpb · agent-doc entry filter', () => {
  it('matches dependency-shipped skills/, .claude/, .agents/ trees and SKILL.md files', () => {
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/skills/add-tool/SKILL.md',
      'node_modules/dotenv/skills/dotenv/SKILL.md',
      'node_modules/resolve/.claude/settings.json',
      'node_modules/nanoid/.agents/notes.md',
      'node_modules/some-pkg/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(entries);
  });

  it('matches zip directory entries, not just files', () => {
    // `unzip -Z1` lists directory placeholders too — they must be stripped so
    // the post-strip verification reads zero matching entries.
    expect(filterAgentDocEntries(['node_modules/foo/skills/'])).toEqual([
      'node_modules/foo/skills/',
    ]);
  });

  it('keeps runtime entries', () => {
    const entries = [
      'dist/index.js',
      'manifest.json',
      'node_modules/@cyanheads/mcp-ts-core/dist/core/index.js',
      'node_modules/@opentelemetry/api/build/src/index.js',
      'node_modules/foo/package.json',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('does not match near-miss names', () => {
    const entries = [
      // Root-level dev dirs are .mcpbignore territory, not the nested strip's.
      'skills/add-tool/SKILL.md',
      '.claude/settings.json',
      // Segment names must match exactly.
      'node_modules/foo/skillsets/index.js',
      'node_modules/foo/MYSKILL.md',
      'node_modules/foo/dist/skills.js',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('preserves listing order in the filtered subset', () => {
    const entries = [
      'node_modules/a/skills/one.md',
      'dist/index.js',
      'node_modules/b/.agents/two.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([
      'node_modules/a/skills/one.md',
      'node_modules/b/.agents/two.md',
    ]);
  });

  it('exposes the filter regex for cross-script sync', () => {
    expect(AGENT_DOC_ENTRY).toBeInstanceOf(RegExp);
    expect(AGENT_DOC_ENTRY.source.startsWith('^node_modules')).toBe(true);
  });
});
