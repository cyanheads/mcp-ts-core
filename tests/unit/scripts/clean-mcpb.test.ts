/**
 * @fileoverview Tests for scripts/clean-mcpb.ts — the entry filters behind the
 * post-pack strip: agent docs (issue #230), node-gyp build output (issue #783),
 * and build-only package files (issue #791). Imports the real implementation.
 * The pairing with scripts/lint-packaging.ts is asserted in
 * tests/unit/scripts/lint-packaging.test.ts.
 * @module tests/unit/scripts/clean-mcpb.test
 */

import { describe, expect, it } from 'vitest';
import {
  filterAgentDocEntries,
  filterBuildOnlyEntries,
  filterNodeGypBuildEntries,
} from '../../../scripts/clean-mcpb.js';

describe('clean-mcpb · agent-doc entry filter', () => {
  it('matches dependency-shipped framework-skills/, .claude/, .agents/ trees and SKILL.md files', () => {
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
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
      'node_modules/@opentelemetry/semantic-conventions/build/src/index.js',
      'node_modules/foo/package.json',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('does not match near-miss names', () => {
    const entries = [
      // Root-level dev dirs are .mcpbignore territory, not the nested strip's.
      'framework-skills/add-tool/SKILL.md',
      '.claude/settings.json',
      // Segment names must match exactly.
      'node_modules/foo/skillsets/index.js',
      'node_modules/foo/MYSKILL.md',
      'node_modules/foo/dist/skills.js',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('keeps the root skills/ tree the server publishes', () => {
    const entries = [
      'skills/demo-guide/SKILL.md',
      'skills/demo-guide/references/ids.md',
      'node_modules/dep/skills/dep-guide/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(['node_modules/dep/skills/dep-guide/SKILL.md']);
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
});

describe('clean-mcpb · node-gyp build output filter (#783)', () => {
  it('strips the tree a plain node-gyp rebuild of better-sqlite3 leaves', () => {
    const tree = [
      'node_modules/better-sqlite3/build/Makefile',
      'node_modules/better-sqlite3/build/config.gypi',
      'node_modules/better-sqlite3/build/binding.Makefile',
      'node_modules/better-sqlite3/build/better_sqlite3.target.mk',
      'node_modules/better-sqlite3/build/test_extension.target.mk',
      'node_modules/better-sqlite3/build/gyp-mac-tool',
      'node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.stamp',
      'node_modules/better-sqlite3/build/Release/obj.target/test_extension.stamp',
      'node_modules/better-sqlite3/build/Release/.deps/Release/obj.target/better_sqlite3.stamp.d',
      'node_modules/better-sqlite3/build/Release/.deps/Release/obj.target/test_extension.stamp.d',
    ];
    const entries = [
      'node_modules/better-sqlite3/binding.gyp',
      'node_modules/better-sqlite3/lib/index.js',
      ...tree,
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/better-sqlite3/build/Release/test_extension.node',
    ];
    expect(filterNodeGypBuildEntries(entries)).toEqual(tree);
  });

  it('scopes to the build/ beside binding.gyp — sharp/src/build/, not sharp/build/', () => {
    const entries = [
      'node_modules/sharp/src/binding.gyp',
      'node_modules/sharp/src/build/config.gypi',
      'node_modules/sharp/src/build/Release/sharp-darwin-arm64v8.node',
      'node_modules/sharp/build/Makefile',
    ];
    expect(filterNodeGypBuildEntries(entries)).toEqual([
      'node_modules/sharp/src/build/config.gypi',
    ]);
  });

  it('never touches a build/ without a sibling binding.gyp', () => {
    const entries = [
      'node_modules/@opentelemetry/semantic-conventions/build/src/index.js',
      'node_modules/pino/build/sync-version.js',
      'node_modules/other/build/Makefile',
      'node_modules/other/build/config.gypi',
    ];
    expect(filterNodeGypBuildEntries(entries)).toEqual([]);
  });

  it('keeps every compiled addon and shared library under build/', () => {
    const entries = [
      'node_modules/addon/binding.gyp',
      'node_modules/addon/build/addon.node',
      'node_modules/addon/build/Debug/addon.node',
      'node_modules/addon/build/Release/addon.node',
      'node_modules/addon/build/Release/libvendor.so.1',
      'node_modules/addon/build/Release/vendor.dll',
    ];
    expect(filterNodeGypBuildEntries(entries)).toEqual([]);
  });
});

describe('clean-mcpb · build-only package filter (#791)', () => {
  it("strips mcp-ts-core's build-only files and keeps its dist/ and package.json", () => {
    const buildOnly = [
      'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/AGENTS.md',
      'node_modules/@cyanheads/mcp-ts-core/biome.json',
      'node_modules/@cyanheads/mcp-ts-core/vitest.config.base.mjs',
      'node_modules/@cyanheads/mcp-ts-core/config/tsconfig.base.json',
      'node_modules/@cyanheads/mcp-ts-core/changelog/0.13.x/0.13.17.md',
      'node_modules/@cyanheads/mcp-ts-core/scripts/clean-mcpb.ts',
      'node_modules/@cyanheads/mcp-ts-core/templates/_.mcpbignore',
    ];
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/package.json',
      'node_modules/@cyanheads/mcp-ts-core/dist/core/index.js',
      ...buildOnly,
    ];
    expect(filterBuildOnlyEntries(entries)).toEqual(buildOnly);
  });

  it("strips better-sqlite3's C sources and keeps its loader and prebuilds", () => {
    const entries = [
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      'node_modules/better-sqlite3/src/better_sqlite3.cpp',
      'node_modules/better-sqlite3/lib/index.js',
      'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      'node_modules/better-sqlite3/binding.gyp',
    ];
    expect(filterBuildOnlyEntries(entries)).toEqual([
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      'node_modules/better-sqlite3/src/better_sqlite3.cpp',
    ]);
  });

  it('keeps the same names in other packages', () => {
    const entries = [
      'node_modules/other/CLAUDE.md',
      'node_modules/other/scripts/postinstall.js',
      'node_modules/other/src/index.js',
      'node_modules/@cyanheads/mcp-ts-core/dist/scripts/helper.js',
      'node_modules/@cyanheads/mcp-ts-core/dist/config/index.js',
      'node_modules/@cyanheads/other/CLAUDE.md',
      'node_modules/@cyanheads/other/biome.json',
      'node_modules/other/vitest.config.base.mjs',
      'node_modules/better-sqlite3-extra/src/index.js',
    ];
    expect(filterBuildOnlyEntries(entries)).toEqual([]);
  });
});
