/**
 * @fileoverview Tests for scripts/lint-packaging.ts — the `.mcpbignore` static
 * guards (checks 5–7, issues #172/#207), the post-bundle content check
 * (check 8, issue #230), and the identity checks (check 9, issue #231).
 * Imports the real implementation; no inline mirror.
 * @module tests/unit/scripts/lint-packaging.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY } from '../../../scripts/clean-mcpb.js';
import {
  AGENT_DOC_ENTRY,
  checkBundleContent,
  checkBundleEntries,
  checkEntrypointIdentity,
  checkManifestIdentity,
} from '../../../scripts/lint-packaging.js';

describe('lint-packaging · bundle-content guard (checks 5–7)', () => {
  describe('dev-dir exclusion (check 5)', () => {
    it('passes with anchored root patterns', async () => {
      const content = '/skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/\n/Dockerfile\n/bun.lock';
      const errors = await checkBundleContent(content);
      expect(errors.filter((e) => e.includes('does not exclude'))).toHaveLength(0);
    });

    it('flags a dev dir that is entirely missing from the ignore file', async () => {
      const content = '/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('does not exclude root dev directory "skills/"'))).toBe(
        true,
      );
      expect(errors.some((e) => e.includes('".agents/"'))).toBe(false);
    });
  });

  describe('unanchored pattern strips runtime paths (check 6)', () => {
    it('passes with anchored patterns — no runtime path stripping', async () => {
      const content = '/skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = await checkBundleContent(content);
      expect(errors.filter((e) => e.includes('unanchored'))).toHaveLength(0);
    });

    it('flags unanchored skills/ pattern that also strips node_modules/x/skills/', async () => {
      const content = 'skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('unanchored') && e.includes('skills/'))).toBe(true);
    });

    it('flags all three unanchored dev-dir patterns', async () => {
      const content = 'skills/\n.agents/\n.claude/';
      const errors = await checkBundleContent(content);
      expect(errors.filter((e) => e.includes('unanchored'))).toHaveLength(3);
    });

    it('flags a mix of anchored and unanchored entries', async () => {
      const content = '/skills/\n.agents/\n/.claude/';
      const errors = await checkBundleContent(content);
      const unanchored = errors.filter((e) => e.includes('unanchored'));
      expect(unanchored).toHaveLength(1);
      expect(unanchored[0]).toContain('.agents/');
    });
  });

  describe('critical-runtime-path protection (check 7)', () => {
    it('passes when no runtime paths are stripped', async () => {
      const content = '/skills/\n/.agents/\n/.claude/';
      const errors = await checkBundleContent(content);
      expect(errors.filter((e) => e.includes('critical runtime path'))).toHaveLength(0);
    });

    it('flags a pattern that strips all node_modules paths', async () => {
      const content = 'node_modules/**\n/skills/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('@opentelemetry'))).toBe(true);
    });

    it('flags a pattern that strips dist/', async () => {
      const content = 'dist/\n/skills/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('dist/index.js'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('ignores comment lines', async () => {
      const content = '# this is a comment\n/skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = await checkBundleContent(content);
      expect(errors).toHaveLength(0);
    });

    it('handles empty .mcpbignore — all dev dirs unexcluded', async () => {
      const errors = await checkBundleContent('');
      expect(errors.filter((e) => e.includes('does not exclude'))).toHaveLength(3);
    });
  });
});

describe('lint-packaging · post-bundle content check (check 8)', () => {
  it('keeps the agent-doc filter in sync with clean-mcpb.ts', () => {
    expect(AGENT_DOC_ENTRY.source).toBe(CLEAN_AGENT_DOC_ENTRY.source);
    expect(AGENT_DOC_ENTRY.flags).toBe(CLEAN_AGENT_DOC_ENTRY.flags);
  });

  it('passes a clean bundle listing', () => {
    const entries = [
      'manifest.json',
      'dist/index.js',
      'node_modules/@cyanheads/mcp-ts-core/dist/core/index.js',
      'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js',
    ];
    expect(checkBundleEntries(entries, 'dist/test.mcpb')).toEqual([]);
  });

  it('flags agent-doc entries with a count and sample', () => {
    const entries = [
      'dist/index.js',
      'node_modules/@cyanheads/mcp-ts-core/skills/add-tool/SKILL.md',
      'node_modules/dotenv/skills/dotenv/SKILL.md',
      'node_modules/resolve/.claude/settings.json',
    ];
    const errors = checkBundleEntries(entries, 'dist/test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dist/test.mcpb');
    expect(errors[0]).toContain('3 node_modules agent-doc entries');
    expect(errors[0]).toContain('clean-mcpb.ts');
  });
});

describe('lint-packaging · entrypoint identity check (check 9)', () => {
  const UNSCOPED = 'pubmed-mcp-server';
  const entry = (body: string): string =>
    `import { createApp } from '@cyanheads/mcp-ts-core';\n\nawait createApp({\n${body}\n});\n`;

  it('passes a matching name/title pair', () => {
    const source = entry(`  name: '${UNSCOPED}',\n  title: '${UNSCOPED}',\n  tools: [a],`);
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('fails a display-case title', () => {
    const source = entry(`  name: '${UNSCOPED}',\n  title: 'PubMed MCP Server',\n  tools: [a],`);
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('title: "PubMed MCP Server"');
    expect(result.errors[0]).toContain(UNSCOPED);
  });

  it('fails a scoped name', () => {
    const source = entry(`  name: '@cyanheads/${UNSCOPED}',\n  title: '${UNSCOPED}',`);
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`name: "@cyanheads/${UNSCOPED}"`);
  });

  it('warns on a partial pair without failing', () => {
    const source = entry(`  title: '${UNSCOPED}',\n  tools: [a],`);
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('missing: name');
  });

  it('warns listing both fields when no identity is set', () => {
    const source = entry('  tools: [a],\n  resources: [b],');
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('missing: name, title');
  });

  it('does not count commented-out identity lines as present', () => {
    const source = entry(`  // name: 'wrong-name',\n  // title: 'Wrong Title',\n  tools: [a],`);
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it('skips a bare createApp() call with no options object', () => {
    const source = `import { createApp } from '@/core/app.js';\n\nawait createApp();\n`;
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('skips a file with no entrypoint call at all', () => {
    const result = checkEntrypointIdentity('export const x = 1;\n', UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores name/title keys nested inside setup() bodies', () => {
    const source = entry(
      `  name: '${UNSCOPED}',\n  title: '${UNSCOPED}',\n  setup(core) {\n    initThing(core.config, { name: 'cache-service' });\n  },`,
    );
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores name/title keys nested inside extension config objects', () => {
    const source = entry(
      `  name: '${UNSCOPED}',\n  title: '${UNSCOPED}',\n  extensions: {\n    'vendor/thing': { title: 'Fancy Extension' },\n  },`,
    );
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
  });

  it('ignores field-like text inside string literals', () => {
    const source = entry(
      `  name: '${UNSCOPED}',\n  title: '${UNSCOPED}',\n  instructions: 'Set title: X via config { nested: true }',`,
    );
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/index.ts');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('checks createWorkerHandler() the same way', () => {
    const source = `import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';\n\nexport default createWorkerHandler({\n  title: 'Worker Server',\n  tools: [a],\n});\n`;
    const result = checkEntrypointIdentity(source, UNSCOPED, 'src/worker.ts');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('title: "Worker Server"');
  });
});

describe('lint-packaging · manifest identity (check 9, manifest surface)', () => {
  it('passes a matching display_name', () => {
    expect(
      checkManifestIdentity({ display_name: 'pubmed-mcp-server' }, 'pubmed-mcp-server'),
    ).toEqual([]);
  });

  it('fails a display-case display_name', () => {
    const errors = checkManifestIdentity(
      { display_name: 'PubMed MCP Server' },
      'pubmed-mcp-server',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('display_name');
  });

  it('skips when display_name is absent or not a string', () => {
    expect(checkManifestIdentity({}, 'pubmed-mcp-server')).toEqual([]);
    expect(checkManifestIdentity({ display_name: 42 }, 'pubmed-mcp-server')).toEqual([]);
  });
});
