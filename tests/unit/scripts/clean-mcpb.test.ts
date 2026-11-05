/**
 * @fileoverview Tests for scripts/clean-mcpb.ts — the entry filters behind the
 * post-pack strip: agent docs at an installed package's root (issues #230,
 * #794, #820), node-gyp build output (issue #783), and build-only package files
 * (issue #791). Imports the real implementation. The pairing with
 * scripts/lint-packaging.ts is asserted in tests/unit/scripts/lint-packaging.test.ts.
 * @module tests/unit/scripts/clean-mcpb.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY,
  filterAgentDocEntries,
  filterBuildOnlyEntries,
  filterNodeGypBuildEntries,
} from '../../../scripts/clean-mcpb.js';
import { expectLinearCost } from '../../helpers/cpu-time.js';

/** The agent directories a package root may carry. */
const AGENT_DIRS = new Set(['framework-skills', 'skills', '.claude', '.agents']);

/** The agent instruction files a package root may carry. */
const AGENT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

/**
 * The agent-doc rule stated over path segments, independently of the regex: an
 * entry under `node_modules/` is an agent doc when, below some `node_modules`
 * segment, the installed package rooted there (two segments when the first
 * starts with `@`) holds an agent directory or is followed by exactly an agent
 * instruction file — or when the entry is a `SKILL.md` inside any package.
 */
function isAgentDoc(entry: string): boolean {
  const segments = entry.split('/');
  if (segments[0] !== 'node_modules') return false;
  if (segments.length > 2 && segments.at(-1) === 'SKILL.md') return true;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== 'node_modules') continue;
    const nameLength = segments[i + 1]?.startsWith('@') ? 2 : 1;
    const rest = segments.slice(i + 1 + nameLength);
    // A directory entry ends in `/`, so its split ends in '' — `skills/` is two segments.
    if (rest.length >= 2 && AGENT_DIRS.has(rest[0] ?? '')) return true;
    if (rest.length === 1 && AGENT_FILES.has(rest[0] ?? '')) return true;
  }
  return false;
}

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

  it('matches agent directories at the root of scoped, nested, and store-installed packages', () => {
    const entries = [
      'node_modules/@scope/pkg/skills/guide/SKILL.md',
      'node_modules/@scope/pkg/.agents/',
      'node_modules/a/node_modules/b/skills/x/references/ids.md',
      'node_modules/a/node_modules/@s/b/.claude/x.json',
      'node_modules/a/node_modules/c/node_modules/d/.agents/',
      'node_modules/.bun/foo@1.0.0/node_modules/foo/framework-skills/',
      'node_modules/.pnpm/foo@1.0.0/node_modules/@s/foo/skills/x.md',
      // A package named after an agent directory still roots its own agent tree.
      'node_modules/skills/skills/guide.md',
      'node_modules/@scope/skills/skills/x/SKILL.md',
      // SKILL.md matches anywhere under node_modules/.
      'node_modules/x/docs/SKILL.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(entries);
  });

  it('matches a package-root AGENTS.md or CLAUDE.md, in scoped and nested packages too (#820)', () => {
    const entries = [
      'node_modules/sonic-boom/AGENTS.md',
      'node_modules/@supabase/auth-js/AGENTS.md',
      'node_modules/bun-types/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/AGENTS.md',
      'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/a/node_modules/b/CLAUDE.md',
      'node_modules/a/node_modules/@s/b/AGENTS.md',
      'node_modules/.bun/foo@1.0.0/node_modules/foo/AGENTS.md',
      'node_modules/@scope/skills/AGENTS.md',
    ];
    expect(filterAgentDocEntries(entries)).toEqual(entries);
  });

  it('keeps runtime skills/ modules below a package root (#794)', () => {
    const entries = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/client/dist/ext/skills/index.mjs',
      'node_modules/openai/resources/skills/',
      'node_modules/openai/resources/skills/skills.js',
      'node_modules/openai/src/resources/skills/skills.ts',
      'node_modules/a/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/a/node_modules/openai/resources/skills/skills.js',
      'node_modules/.bun/foo@1.0.0/node_modules/foo/dist/skills/x.js',
      'node_modules/.pnpm/foo@1.0.0/node_modules/@s/foo/lib/skills/x.js',
      'node_modules/x/lib/.claude/settings.json',
      'node_modules/x/dist/.agents/x.json',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('keeps packages named after an agent directory', () => {
    const entries = [
      'node_modules/skills/',
      'node_modules/skills/index.js',
      'node_modules/@scope/skills/',
      'node_modules/@scope/skills/index.js',
      'node_modules/@scope/.claude-config/index.js',
      'node_modules/a/node_modules/skills/index.js',
      'node_modules/a/node_modules/@scope/skills/index.js',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('keeps AGENTS.md and CLAUDE.md below a package root, and near-miss names at one (#820)', () => {
    const entries = [
      'node_modules/x/docs/AGENTS.md',
      'node_modules/x/templates/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/templates/CLAUDE.md',
      'node_modules/x/agents.md',
      'node_modules/x/Claude.md',
      'node_modules/x/AGENTS.md.bak',
      'node_modules/x/CLAUDE.mdx',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('keeps the bundle root’s own agent files — .mcpbignore territory', () => {
    const entries = ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.agents/notes.md'];
    expect(filterAgentDocEntries(entries)).toEqual([]);
  });

  it('selects exactly the entries the package-root rule names, over generated paths', () => {
    const segment = fc.constantFrom(
      'node_modules',
      '@s',
      '@scope',
      'skills',
      'framework-skills',
      '.claude',
      '.agents',
      'AGENTS.md',
      'CLAUDE.md',
      'SKILL.md',
      'agents.md',
      'skills.js',
      'a',
      'dist',
      'ext',
      '.bun',
      'foo@1.0.0',
    );
    // No installer writes `node_modules/node_modules/`, and npm reserves the name, so a
    // `node_modules` segment never directly follows another.
    const entry = fc
      .tuple(
        fc.constantFrom(['node_modules'], []),
        fc.array(segment, { minLength: 1, maxLength: 7 }),
        fc.boolean(),
      )
      .map(([prefix, segments, directory]) => [...prefix, ...segments, ...(directory ? [''] : [])])
      .filter((segments) =>
        segments.every((name, i) => name !== 'node_modules' || segments[i + 1] !== 'node_modules'),
      )
      .map((segments) => segments.join('/'));
    fc.assert(
      fc.property(entry, (path) => {
        expect(AGENT_DOC_ENTRY.test(path), path).toBe(isAgentDoc(path));
      }),
      { numRuns: 5_000 },
    );
  });

  it.each([
    [
      'nested install directories',
      (size: number) => `node_modules/${'a/node_modules/'.repeat(size / 15)}x`,
    ],
    [
      'path segments ending in a near-miss name',
      (size: number) => `node_modules/${'a/'.repeat(size / 2)}SKILL.mdx`,
    ],
  ])('matches in time linear in the entry length: %s', (_shape, entryOfSize) => {
    expectLinearCost((size) => {
      const entry = entryOfSize(size);
      return () => AGENT_DOC_ENTRY.test(entry);
    });
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
      'node_modules/@cyanheads/mcp-ts-core/biome.json',
      'node_modules/@cyanheads/mcp-ts-core/vitest.config.base.mjs',
      'node_modules/@cyanheads/mcp-ts-core/config/tsconfig.base.json',
      'node_modules/@cyanheads/mcp-ts-core/changelog/0.13.x/0.13.17.md',
      'node_modules/@cyanheads/mcp-ts-core/scripts/clean-mcpb.ts',
      'node_modules/@cyanheads/mcp-ts-core/templates/_.mcpbignore',
      'node_modules/@cyanheads/mcp-ts-core/templates/CLAUDE.md',
    ];
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/package.json',
      'node_modules/@cyanheads/mcp-ts-core/dist/core/index.js',
      ...buildOnly,
    ];
    expect(filterBuildOnlyEntries(entries)).toEqual(buildOnly);
  });

  it("leaves mcp-ts-core's root AGENTS.md and CLAUDE.md to the agent-doc class alone (#820)", () => {
    const entries = [
      'node_modules/@cyanheads/mcp-ts-core/AGENTS.md',
      'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/a/node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
    ];
    expect(filterBuildOnlyEntries(entries)).toEqual([]);
    expect(filterAgentDocEntries(entries)).toEqual(entries);
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
