/**
 * @fileoverview Tests for scripts/lint-packaging.ts — the `.mcpbignore` static
 * guards (checks 5–7, issues #172/#207), the post-bundle content check
 * (check 8, issues #230/#274), the identity checks (check 9, issue #231), and
 * the plugin marketplace manifests (check 10, issues #240/#393), and the
 * npm `files` exclusion of the built bundle (check 13, issue #469), manifest.json
 * version parity (check 14), the Dockerfile stages that run JavaScript off
 * the build platform (check 15, #575), and the launch shape of server.json npm
 * entries (check 16, #622).
 * Imports the real implementation; no inline mirror.
 * @module tests/unit/scripts/lint-packaging.test
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY,
  NATIVE_BINDING_ENTRY as CLEAN_NATIVE_BINDING_ENTRY,
} from '../../../scripts/clean-mcpb.js';
import {
  AGENT_DOC_ENTRY,
  checkBundleContent,
  checkBundleEntries,
  checkBundleExcludedFromFiles,
  checkDockerfileBuildPlatform,
  checkEntrypointIdentity,
  checkManifestIdentity,
  checkManifestUserConfigWiring,
  checkManifestVersion,
  checkPluginManifests,
  checkReadmeVersionBadge,
  checkServerJsonLaunch,
  NATIVE_BINDING_ENTRY,
} from '../../../scripts/lint-packaging.js';

describe('lint-packaging · bundle-content guard (checks 5–7)', () => {
  describe('dev-dir exclusion (check 5)', () => {
    it('passes with anchored root patterns', async () => {
      const content =
        '/framework-skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/\n/Dockerfile\n/bun.lock';
      const errors = await checkBundleContent(content);
      expect(errors.filter((e) => e.includes('does not exclude'))).toHaveLength(0);
    });

    it('flags a dev dir that is entirely missing from the ignore file', async () => {
      const content = '/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = await checkBundleContent(content);
      expect(
        errors.some((e) => e.includes('does not exclude root dev directory "framework-skills/"')),
      ).toBe(true);
      expect(errors.some((e) => e.includes('".agents/"'))).toBe(false);
    });
  });

  describe('unanchored pattern strips runtime paths (check 6)', () => {
    it('flags unanchored framework-skills/ pattern that also strips node_modules/x/framework-skills/', async () => {
      const content = 'framework-skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('unanchored') && e.includes('framework-skills/'))).toBe(
        true,
      );
    });

    it('flags all three unanchored dev-dir patterns', async () => {
      const content = 'framework-skills/\n.agents/\n.claude/';
      const errors = await checkBundleContent(content);
      expect(errors.filter((e) => e.includes('unanchored'))).toHaveLength(3);
    });

    it('flags a mix of anchored and unanchored entries', async () => {
      const content = '/framework-skills/\n.agents/\n/.claude/';
      const errors = await checkBundleContent(content);
      const unanchored = errors.filter((e) => e.includes('unanchored'));
      expect(unanchored).toHaveLength(1);
      expect(unanchored[0]).toContain('.agents/');
    });
  });

  describe('critical-runtime-path protection (check 7)', () => {
    it('flags a pattern that strips all node_modules paths', async () => {
      const content = 'node_modules/**\n/framework-skills/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('@opentelemetry'))).toBe(true);
    });

    it('flags a pattern that strips dist/', async () => {
      const content = 'dist/\n/framework-skills/';
      const errors = await checkBundleContent(content);
      expect(errors.some((e) => e.includes('dist/index.js'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('ignores comment lines', async () => {
      const content =
        '# this is a comment\n/framework-skills/\n/.agents/\n/.claude/\n/scripts/\n/tests/';
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
      'node_modules/@modelcontextprotocol/server/dist/index.mjs',
    ];
    expect(checkBundleEntries(entries, 'dist/test.mcpb')).toEqual([]);
  });

  it('flags agent-doc entries with a count and sample', () => {
    const entries = [
      'dist/index.js',
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/dotenv/framework-skills/dotenv/SKILL.md',
      'node_modules/resolve/.claude/settings.json',
    ];
    const errors = checkBundleEntries(entries, 'dist/test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dist/test.mcpb');
    expect(errors[0]).toContain('3 node_modules agent-doc entries');
    expect(errors[0]).toContain('clean-mcpb.ts');
  });

  it('keeps the native-binding filter in sync with clean-mcpb.ts', () => {
    expect(NATIVE_BINDING_ENTRY.source).toBe(CLEAN_NATIVE_BINDING_ENTRY.source);
    expect(NATIVE_BINDING_ENTRY.flags).toBe(CLEAN_NATIVE_BINDING_ENTRY.flags);
  });

  // A packed bundle carries only the build host's platform slice, so shipping
  // it locks the "Install in Claude Desktop" artifact to that platform. (#274)
  it('flags platform-specific native bindings', () => {
    const entries = [
      'dist/index.js',
      'node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node',
      'node_modules/@duckdb/node-bindings-darwin-arm64/libduckdb.dylib',
    ];
    const errors = checkBundleEntries(entries, 'dist/test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('2 platform-specific native binding entries');
    expect(errors[0]).toContain('clean-mcpb.ts');
  });

  it('keeps the portable duckdb packages — only the platform slices go', () => {
    const entries = [
      'node_modules/@duckdb/node-api/lib/index.js',
      'node_modules/@duckdb/node-bindings/duckdb.d.ts',
    ];
    expect(checkBundleEntries(entries, 'dist/test.mcpb')).toEqual([]);
  });

  it('reports agent-doc and native-binding classes as separate errors', () => {
    const entries = [
      'node_modules/dotenv/framework-skills/dotenv/SKILL.md',
      'node_modules/@duckdb/node-bindings-linux-x64/libduckdb.so',
    ];
    expect(checkBundleEntries(entries, 'dist/test.mcpb')).toHaveLength(2);
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

describe('lint-packaging · manifest user_config wiring (check 11)', () => {
  const ref = (id: string) => ['$', `{user_config.${id}}`].join('');
  const wired = {
    name: 'pubmed-mcp-server',
    server: {
      mcp_config: {
        args: [['$', '{__dirname}/dist/index.js'].join('')],
        env: { MCP_TRANSPORT_TYPE: 'stdio', NCBI_API_KEY: ref('ncbi_api_key') },
      },
    },
    user_config: {
      ncbi_api_key: { type: 'string', title: 'NCBI API key', required: false, default: '' },
    },
  };

  it('accepts a fully wired manifest', () => {
    expect(checkManifestUserConfigWiring(wired)).toEqual([]);
  });

  it('flags a non-MCPB placeholder that the host would deliver literally', () => {
    const m = {
      ...wired,
      server: { mcp_config: { env: { NCBI_API_KEY: ['$', '{NCBI_API_KEY}'].join('') } } },
      user_config: { NCBI_API_KEY: { type: 'string', title: 'NCBI API key', required: true } },
    };
    const errors = checkManifestUserConfigWiring(m);
    expect(errors.some((e) => e.includes('literal string'))).toBe(true);
    expect(errors.some((e) => e.includes('never referenced'))).toBe(true);
  });

  it('flags a declared option that mcp_config never references', () => {
    const m = { ...wired, server: { mcp_config: { env: { MCP_TRANSPORT_TYPE: 'stdio' } } } };
    const errors = checkManifestUserConfigWiring(m);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('user_config["ncbi_api_key"] is never referenced');
  });

  it('flags a reference to an undeclared option', () => {
    const m = { ...wired, user_config: {} };
    const errors = checkManifestUserConfigWiring(m);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('user_config["ncbi_api_key"] is not declared');
  });

  it('flags an optional string option with no default', () => {
    const m = {
      ...wired,
      user_config: { ncbi_api_key: { type: 'string', title: 'NCBI API key' } },
    };
    const errors = checkManifestUserConfigWiring(m);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no "default"');
  });

  it('does not require a default on required or non-string options', () => {
    const m = {
      ...wired,
      server: {
        mcp_config: { env: { A: ref('a'), B: ref('b') } },
      },
      user_config: {
        a: { type: 'string', title: 'A', required: true },
        b: { type: 'boolean', title: 'B' },
      },
    };
    expect(checkManifestUserConfigWiring(m)).toEqual([]);
  });
});

describe('lint-packaging · plugin marketplace manifests (check 10, #240)', () => {
  const UNSCOPED = 'pubmed-mcp-server';
  const FULL = '@cyanheads/pubmed-mcp-server';
  const VERSION = '0.2.6';

  const validClaude = {
    name: UNSCOPED,
    version: VERSION,
    description: 'Search and fetch PubMed articles.',
    mcpServers: { [UNSCOPED]: { command: 'npx', args: ['-y', FULL] } },
  };
  const validCodex = {
    name: UNSCOPED,
    version: VERSION,
    description: 'Search and fetch PubMed articles.',
    mcpServers: './.codex-plugin/mcp.json',
    interface: {
      displayName: UNSCOPED,
      shortDescription: 'Search PubMed.',
      longDescription: 'Search and fetch PubMed articles via E-utilities.',
    },
  };
  const validCodexMcp = { [UNSCOPED]: { command: 'npx', args: ['-y', FULL] } };

  it('passes a fully populated, correctly-scoped manifest set', () => {
    const errors = checkPluginManifests(
      { claudePlugin: validClaude, codexPlugin: validCodex, codexMcp: validCodexMcp },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toEqual([]);
  });

  it('skips cleanly when no plugin manifests are present', () => {
    expect(checkPluginManifests({}, UNSCOPED, FULL, VERSION)).toEqual([]);
  });

  it('flags a plugin version left behind by a release (#393)', () => {
    const errors = checkPluginManifests(
      {
        claudePlugin: { ...validClaude, version: '0.2.4' },
        codexPlugin: { ...validCodex, version: '0.2.4' },
      },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('.claude-plugin/plugin.json');
    expect(errors[1]).toContain('.codex-plugin/plugin.json');
    for (const error of errors) {
      expect(error).toContain('"0.2.4"');
      expect(error).toContain(VERSION);
    }
  });

  it('flags a plugin manifest that declares no version', () => {
    const { version: _omitted, ...noVersion } = validClaude;
    const errors = checkPluginManifests({ claudePlugin: noVersion }, UNSCOPED, FULL, VERSION);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('has no "version"');
    expect(errors[0]).toContain(VERSION);
  });

  it('skips version parity when package.json declares no version', () => {
    const errors = checkPluginManifests(
      { claudePlugin: { ...validClaude, version: '0.2.4' } },
      UNSCOPED,
      FULL,
    );
    expect(errors).toEqual([]);
  });

  it('flags an empty description in .claude-plugin/plugin.json', () => {
    const errors = checkPluginManifests(
      { claudePlugin: { ...validClaude, description: '' } },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('.claude-plugin/plugin.json');
    expect(errors[0]).toContain('description');
  });

  it('flags empty codex short/long descriptions', () => {
    const errors = checkPluginManifests(
      {
        codexPlugin: {
          ...validCodex,
          interface: { ...validCodex.interface, shortDescription: '', longDescription: '' },
        },
      },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors.some((e) => e.includes('interface.shortDescription'))).toBe(true);
    expect(errors.some((e) => e.includes('interface.longDescription'))).toBe(true);
  });

  it('flags an unscoped install arg for a scoped package (the 404 case)', () => {
    const errors = checkPluginManifests(
      { claudePlugin: { ...validClaude, mcpServers: { [UNSCOPED]: { args: ['-y', UNSCOPED] } } } },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('install arg');
    expect(errors[0]).toContain(FULL);
  });

  it('flags an unscoped install arg in .codex-plugin/mcp.json', () => {
    const errors = checkPluginManifests(
      { codexMcp: { [UNSCOPED]: { args: ['-y', UNSCOPED] } } },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('.codex-plugin/mcp.json');
    expect(errors[0]).toContain('install arg');
  });

  it('flags a scoped name — display identity must be the unscoped machine name', () => {
    const errors = checkPluginManifests(
      { claudePlugin: { ...validClaude, name: FULL } },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"name"');
    expect(errors[0]).toContain('unscoped');
  });

  it('flags a Title-Case codex displayName', () => {
    const errors = checkPluginManifests(
      {
        codexPlugin: {
          ...validCodex,
          interface: { ...validCodex.interface, displayName: 'PubMed MCP Server' },
        },
      },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('interface.displayName');
  });

  it('flags a wrong server key in .codex-plugin/mcp.json', () => {
    const errors = checkPluginManifests(
      { codexMcp: { 'wrong-key': { args: ['-y', FULL] } } },
      UNSCOPED,
      FULL,
      VERSION,
    );
    expect(errors.some((e) => e.includes('server key must be the unscoped'))).toBe(true);
  });

  it('flags an empty-string env placeholder in .claude-plugin/plugin.json', () => {
    const claude = {
      ...validClaude,
      mcpServers: {
        [UNSCOPED]: { command: 'npx', args: ['-y', FULL], env: { NCBI_API_KEY: '' } },
      },
    };
    const errors = checkPluginManifests({ claudePlugin: claude }, UNSCOPED, FULL, VERSION);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('env.NCBI_API_KEY is ""');
    expect(errors[0]).toContain('userConfig');
  });

  /** `${user_config.<id>}` as a plain string, built so Biome's template-placeholder rule stays quiet. */
  const userConfigRef = (id: string) => ['$', `{user_config.${id}}`].join('');

  it('flags a user_config reference with no matching userConfig option', () => {
    const claude = {
      ...validClaude,
      mcpServers: {
        [UNSCOPED]: {
          command: 'npx',
          args: ['-y', FULL],
          env: { NCBI_API_KEY: userConfigRef('ncbi_api_key') },
        },
      },
    };
    const errors = checkPluginManifests({ claudePlugin: claude }, UNSCOPED, FULL, VERSION);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"userConfig.ncbi_api_key" is not declared');
  });

  it('accepts a declared userConfig option referenced from env', () => {
    const claude = {
      ...validClaude,
      userConfig: {
        ncbi_api_key: { type: 'string', title: 'NCBI API key', description: 'Optional.' },
      },
      mcpServers: {
        [UNSCOPED]: {
          command: 'npx',
          args: ['-y', FULL],
          env: { MCP_TRANSPORT_TYPE: 'stdio', NCBI_API_KEY: userConfigRef('ncbi_api_key') },
        },
      },
    };
    expect(checkPluginManifests({ claudePlugin: claude }, UNSCOPED, FULL, VERSION)).toEqual([]);
  });

  it('flags an empty-string env placeholder in .codex-plugin/mcp.json', () => {
    const codexMcp = {
      [UNSCOPED]: { command: 'npx', args: ['-y', FULL], env: { NCBI_API_KEY: '' } },
    };
    const errors = checkPluginManifests({ codexMcp }, UNSCOPED, FULL, VERSION);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('env.NCBI_API_KEY is ""');
    expect(errors[0]).toContain('env_vars');
  });

  it('accepts env_vars forwarding in .codex-plugin/mcp.json', () => {
    const codexMcp = {
      [UNSCOPED]: {
        command: 'npx',
        args: ['-y', FULL],
        env: { MCP_TRANSPORT_TYPE: 'stdio' },
        env_vars: ['NCBI_API_KEY'],
      },
    };
    expect(checkPluginManifests({ codexMcp }, UNSCOPED, FULL, VERSION)).toEqual([]);
  });
});

describe('lint-packaging · README version badge (check 12, #418)', () => {
  /** The badge as a README carries it, in the two suffix forms in use. */
  const badge = (segment: string, suffix = 'blue.svg?style=flat-square'): string =>
    `# Server\n\n[![Version](https://img.shields.io/badge/Version-${segment}-${suffix})](./CHANGELOG.md)\n`;

  it('passes when the badge equals the package version', () => {
    expect(checkReadmeVersionBadge(badge('0.13.1'), '0.13.1')).toEqual([]);
    expect(checkReadmeVersionBadge(badge('0.13.1', 'blue.svg'), '0.13.1')).toEqual([]);
  });

  it('fails a badge left one version behind, naming both values', () => {
    const errors = checkReadmeVersionBadge(badge('0.13.0'), '0.13.1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"0.13.0"');
    expect(errors[0]).toContain('"0.13.1"');
    expect(errors[0]).toContain('README.md');
  });

  it('skips a README with no version badge at all', () => {
    expect(checkReadmeVersionBadge('# Server\n\nSome prose.\n', '0.13.1')).toEqual([]);
  });

  it('skips a README carrying only a live npm/v badge, which cannot drift', () => {
    const readme =
      '# Server\n\n[![npm](https://img.shields.io/npm/v/@cyanheads/pubmed-mcp-server)](https://npmjs.com/)\n';
    expect(checkReadmeVersionBadge(readme, '0.13.1')).toEqual([]);
  });

  it('skips an absent README — the caller passes empty content', () => {
    expect(checkReadmeVersionBadge('', '0.13.1')).toEqual([]);
  });

  it('skips when package.json declares no version, matching the plugin-manifest fail-safe', () => {
    expect(checkReadmeVersionBadge(badge('0.13.0'), undefined)).toEqual([]);
    expect(checkReadmeVersionBadge(badge('0.13.0'), '')).toEqual([]);
  });

  it('decodes the shields.io `--` escape so a prerelease badge matches', () => {
    expect(checkReadmeVersionBadge(badge('0.14.0--rc.1'), '0.14.0-rc.1')).toEqual([]);
  });

  it('fails a prerelease badge that is genuinely behind', () => {
    const errors = checkReadmeVersionBadge(badge('0.14.0--rc.1'), '0.14.0-rc.2');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"0.14.0-rc.1"');
  });

  it('fails an unparseable badge segment rather than skipping it', () => {
    for (const segment of ['', 'latest']) {
      const errors = checkReadmeVersionBadge(badge(segment), '0.13.1');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('README.md');
      expect(errors[0]).toMatch(/version badge/);
    }
  });

  it('ignores other shields badges that carry an escaped `-`', () => {
    const readme = `${badge('0.13.1')}\n[![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2026--07--28-8A2BE2.svg)](https://modelcontextprotocol.io/)\n`;
    expect(checkReadmeVersionBadge(readme, '0.13.1')).toEqual([]);
  });

  it('accepts a prerelease and build segment together', () => {
    expect(
      checkReadmeVersionBadge(badge('1.2.3--alpha.1+build.5'), '1.2.3-alpha.1+build.5'),
    ).toEqual([]);
  });

  it('rejects a dash-run segment in bounded time', () => {
    // A semver core followed by a long run of escaped dashes and a character
    // no segment admits: unreadable either way, but a repeated `(?:[-+]…)*`
    // splits the run two ways per dash and backtracks through every split
    // before saying so. V8 runs that to completion — the `node` lane is where
    // this case goes red; JSC abandons the search early, so under Bun it only
    // pins that the segment is still rejected.
    const readme = badge(`0.0.0+${'--'.repeat(40)}!`);

    const started = performance.now();
    const errors = checkReadmeVersionBadge(readme, '0.13.1');
    expect(performance.now() - started).toBeLessThan(2_000);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not a readable version/);
  });
});

describe('lint-packaging · npm files exclude the built bundle (check 13, #469)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

  it('passes the scaffold template files allowlist', () => {
    const template = JSON.parse(readFileSync(join(REPO_ROOT, 'templates/package.json'), 'utf8'));
    expect(template.files).toContain('dist/');
    expect(checkBundleExcludedFromFiles(template.files)).toEqual([]);
  });

  it('fails a files allowlist that covers dist/ without the exclusion, naming the entry', () => {
    const errors = checkBundleExcludedFromFiles(['dist/', 'README.md']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"!dist/*.mcpb"');
    expect(errors[0]).toContain('package.json');
  });

  it.each(['dist', 'dist/', './dist/', 'dist/**', 'dist/**/*', 'dist/*'])(
    'treats %s as covering dist/',
    (entry) => {
      expect(checkBundleExcludedFromFiles([entry])).toHaveLength(1);
      expect(checkBundleExcludedFromFiles([entry, '!dist/*.mcpb'])).toEqual([]);
    },
  );

  it('accepts the recursive form of the exclusion', () => {
    expect(checkBundleExcludedFromFiles(['dist/', '!dist/**/*.mcpb'])).toEqual([]);
  });

  it('skips a files allowlist that does not cover dist/ wholesale', () => {
    expect(checkBundleExcludedFromFiles(['dist/**/*.js', 'README.md'])).toEqual([]);
    expect(checkBundleExcludedFromFiles(['distribution/'])).toEqual([]);
  });

  it('skips a package.json without a files allowlist', () => {
    expect(checkBundleExcludedFromFiles(undefined)).toEqual([]);
  });

  describe('standalone run', () => {
    const SCRIPT = join(REPO_ROOT, 'scripts/lint-packaging.ts');
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function project(files: string[], withManifest: boolean): string {
      dir = mkdtempSync(join(tmpdir(), 'lint-packaging-files-'));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'probe-mcp-server', version: '0.1.0', files }),
      );
      if (withManifest) {
        writeFileSync(
          join(dir, 'manifest.json'),
          JSON.stringify({ name: 'probe-mcp-server', version: '0.1.0' }),
        );
      }
      return dir;
    }

    function lint(cwd: string): { code: number; out: string } {
      const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf8' });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    }

    it('fails a project with manifest.json whose files ship dist/ unfiltered', () => {
      const { code, out } = lint(project(['dist/'], true));
      expect(code).toBe(1);
      expect(out).toContain('"!dist/*.mcpb"');
    });

    it('passes the same project once files carries the exclusion', () => {
      const { code, out } = lint(project(['dist/', '!dist/*.mcpb'], true));
      expect(out).not.toContain('!dist/*.mcpb');
      expect(code).toBe(0);
    });

    it('skips the check when manifest.json is absent', () => {
      const { code, out } = lint(project(['dist/'], false));
      expect(out).not.toContain('!dist/*.mcpb');
      expect(code).toBe(0);
    });
  });
});

describe('lint-packaging · manifest.json version (check 14)', () => {
  it('passes when the manifest version equals the package version', () => {
    expect(checkManifestVersion({ version: '0.13.1' }, '0.13.1')).toEqual([]);
  });

  it('fails a stale manifest version, naming both values', () => {
    const errors = checkManifestVersion({ version: '0.13.0' }, '0.13.1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"0.13.0"');
    expect(errors[0]).toContain('"0.13.1"');
  });

  it('fails a manifest that declares no version', () => {
    expect(checkManifestVersion({ name: 'probe-mcp-server' }, '0.13.1')[0]).toContain(
      'has no "version"',
    );
  });

  it('skips when package.json declares no version', () => {
    expect(checkManifestVersion({ version: '0.13.0' }, undefined)).toEqual([]);
  });
});

describe('lint-packaging · Dockerfile build platform (check 15, #575)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

  it('passes the scaffold template Dockerfile', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'templates/Dockerfile'), 'utf8');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  it('fails a build stage without --platform=$BUILDPLATFORM, naming its line', () => {
    const dockerfile = [
      'FROM oven/bun:1.4.2 AS build',
      'RUN bun install',
      'RUN bun run build',
      'FROM oven/bun:1.4.2-slim AS production',
      'COPY --from=build /app/dist ./dist',
    ].join('\n');
    const errors = checkDockerfileBuildPlatform(dockerfile);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Dockerfile:1');
    expect(errors[0]).toContain('--platform=$BUILDPLATFORM');
  });

  it('accepts the braced BUILDPLATFORM form and a build on a continuation line', () => {
    const dockerfile = [
      `FROM --platform=\${BUILDPLATFORM} oven/bun:1.4.2 AS build`,
      'RUN --mount=type=cache,target=/root/.bun/install/cache \\',
      '    bun install && bun run build',
      'FROM oven/bun:1.4.2-slim',
    ].join('\n');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  it('fails a single-stage Dockerfile that builds in place', () => {
    const dockerfile =
      'FROM oven/bun:1.4.2\nCOPY . .\nRUN bun run build\nCMD ["bun", "dist/index.js"]';
    expect(checkDockerfileBuildPlatform(dockerfile)).toHaveLength(1);
  });

  it('ignores stages that do not build and comments that mention the build', () => {
    const dockerfile = [
      '# The build stage runs `bun run build` on the build platform',
      'FROM oven/bun:1.4.2-slim',
      'COPY dist ./dist',
    ].join('\n');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  /** The build stage every fixture below shares; pinned, so it never reports. */
  const BUILD_STAGE = [
    'FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build',
    'WORKDIR /usr/src/app',
    'COPY package.json bun.lock ./',
    'RUN --mount=type=cache,target=/root/.bun/install/cache \\',
    '    bun install --frozen-lockfile --ignore-scripts',
    'COPY . .',
    'RUN bun run build',
  ];

  /** The runtime tail every scaffold carries: shell-only RUNs, then Bun only at container start. */
  const RUNTIME_TAIL = [
    'COPY --from=build /usr/src/app/dist ./dist',
    'RUN mkdir -p /var/log/srv && chown -R bun:bun /var/log/srv',
    'RUN mkdir -p /usr/src/app/.cache \\',
    '  && chown -R bun:bun /usr/src/app/.cache',
    'USER bun',
    'HEALTHCHECK --interval=30s CMD bun -e "fetch(\'http://localhost:3010/healthz\').then((r)=>process.exit(r.ok?0:1))"',
    'CMD ["bun", "run", "dist/index.js"]',
  ];

  it('passes a target-stage install that never sees bunfig.toml (the pre-0.13.8 production stage)', () => {
    const dockerfile = [
      ...BUILD_STAGE,
      'FROM oven/bun:1.4.2-slim AS production',
      'WORKDIR /usr/src/app',
      'COPY package.json bun.lock ./',
      'RUN --mount=type=cache,target=/root/.bun/install/cache \\',
      '    bun install --production --omit=peer --frozen-lockfile --ignore-scripts',
      'ARG OTEL_ENABLED=true',
      'RUN --mount=type=cache,target=/root/.bun/install/cache \\',
      '    if [ "$OTEL_ENABLED" = "true" ]; then \\',
      '      bun add --omit=dev --omit=peer --ignore-scripts @hono/otel \\',
      '        @opentelemetry/sdk-node; \\',
      '    fi',
      'RUN bun i --production && bun a left-pad',
      ...RUNTIME_TAIL,
    ].join('\n');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  it('never reads HEALTHCHECK, CMD, ENTRYPOINT, or bun as a non-command word as a build step', () => {
    const dockerfile = [
      'FROM oven/bun:1.4.2-slim',
      'COPY bunfig.toml ./',
      'RUN chown -R bun:bun /usr/src/app && chown bun /var/log && ls /root/.bun/ && id -u bun',
      'USER bun',
      'HEALTHCHECK CMD bun -e "process.exit(0)"',
      'ENTRYPOINT ["bun"]',
      'CMD ["bun", "run", "dist/index.js"]',
    ].join('\n');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  it('never reads a quoted mention of bun as a command', () => {
    const dockerfile = [
      'FROM oven/bun:1.4.2-slim',
      'COPY bunfig.toml ./',
      `RUN echo "bun run build" > /dev/null && printf '%s' 'bun -e 1; bun install'`,
    ].join('\n');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  it('passes the framework Dockerfile', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    expect(checkDockerfileBuildPlatform(dockerfile)).toEqual([]);
  });

  /** 1-based line of the first fixture line equal to `text`. */
  const lineOf = (lines: string[], text: string): number => {
    const index = lines.indexOf(text);
    expect(index, `fixture carries ${text}`).toBeGreaterThanOrEqual(0);
    return index + 1;
  };

  it('fails the 0.13.8 production stage, naming its install and its OTel step', () => {
    const lines = [
      ...BUILD_STAGE,
      'FROM oven/bun:1.4.2-slim AS production',
      'WORKDIR /usr/src/app',
      'COPY package.json bun.lock bunfig.toml ./',
      'COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner',
      'RUN --mount=type=cache,target=/root/.bun/install/cache \\',
      '    bun install --production --omit=peer --frozen-lockfile --ignore-scripts',
      'ARG OTEL_ENABLED=true',
      '# The OTel step: resolves each range, then installs',
      'RUN --mount=type=cache,target=/root/.bun/install/cache \\',
      '    if [ "$OTEL_ENABLED" = "true" ]; then \\',
      "      specs=$(bun -e ' \\",
      '        const peers = (await Bun.file("node_modules/@cyanheads/mcp-ts-core/package.json").json()).peerDependencies; \\',
      '        console.log(process.argv.slice(1).map((name) => name + "@" + peers[name]).join(" ")); \\',
      "      ' \\",
      '        @hono/otel \\',
      '        @opentelemetry/sdk-node) \\',
      '      && bun add --omit=dev --omit=peer --ignore-scripts $specs; \\',
      '    fi',
      ...RUNTIME_TAIL,
    ];
    const runs = lines
      .map((line, i) => (line.startsWith('RUN --mount') ? i + 1 : 0))
      .filter((line) => line > lineOf(lines, 'FROM oven/bun:1.4.2-slim AS production'));

    const errors = checkDockerfileBuildPlatform(lines.join('\n'));

    expect(runs).toHaveLength(2);
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error).toContain(
      `Dockerfile:${lineOf(lines, 'FROM oven/bun:1.4.2-slim AS production')} "FROM oven/bun:1.4.2-slim AS production"`,
    );
    expect(error).toContain(`Dockerfile:${runs[0]} runs \`bun install\` after bunfig.toml`);
    expect(error).toContain(`Dockerfile:${runs[1]} runs \`bun -e\``);
    expect(error).toContain('--platform=$BUILDPLATFORM');
    expect(error).not.toContain(`Dockerfile:${lineOf(lines, 'USER bun') + 1}`);
  });

  it.each([
    ['shell form', 'RUN bun -e "console.log(1)"', 'bun -e'],
    ['a script file', 'RUN bun scripts/seed.ts', 'bun scripts/seed.ts'],
    ['an absolute path', 'RUN /usr/local/bin/bun run build', 'bun run'],
    ['bunx', 'RUN bunx some-cli --flag', 'bunx some-cli'],
    ['exec form', 'RUN ["bun", "run", "build"]', 'bun run'],
    ['an env prefix', 'RUN NODE_ENV=production bun run build', 'bun run'],
    ['a compound command', 'RUN set -e; if true; then bun x tsc; fi', 'bun x'],
    [
      'a mount flag',
      'RUN --mount=type=cache,target=/root/.bun/install/cache bun run build',
      'bun run',
    ],
    ['a heredoc', 'RUN <<EOF\nset -e\nbun run build\nEOF', 'bun run'],
  ])('fails a target-stage RUN invoking bun (%s)', (_form, run, invocation) => {
    const errors = checkDockerfileBuildPlatform(`FROM oven/bun:1.4.2-slim\n${run}\nCMD ["bun"]`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Dockerfile:1 "FROM oven/bun:1.4.2-slim"');
    expect(errors[0]).toContain(`Dockerfile:2 runs \`${invocation}\``);
  });

  it('fails an install once bunfig.toml reaches the stage, however it arrives', () => {
    const direct = ['FROM oven/bun:1.4.2-slim', 'COPY bunfig.toml ./', 'RUN bun install'];
    const context = ['FROM oven/bun:1.4.2-slim', 'COPY . .', 'RUN bun install --production'];
    const inherited = [
      'FROM oven/bun:1.4.2 AS base',
      'COPY package.json bunfig.toml ./',
      'FROM base AS production',
      'RUN bun add left-pad',
    ];

    for (const [lines, installLine] of [
      [direct, 3],
      [context, 3],
      [inherited, 4],
    ] as const) {
      const errors = checkDockerfileBuildPlatform(lines.join('\n'));
      expect(errors, lines.join(' | ')).toHaveLength(1);
      expect(errors[0]).toContain(`Dockerfile:${installLine} runs \`bun`);
      expect(errors[0]).toContain('after bunfig.toml');
    }

    // An install that ran before bunfig.toml arrived never saw its scanner.
    const before = ['FROM oven/bun:1.4.2-slim', 'RUN bun install', 'COPY bunfig.toml ./'];
    expect(checkDockerfileBuildPlatform(before.join('\n'))).toEqual([]);
  });

  it('reports each target stage that runs JavaScript once, and never a build-platform stage', () => {
    const lines = [
      ...BUILD_STAGE,
      'FROM oven/bun:1.4.2-slim AS migrate',
      'RUN bun run migrate',
      'FROM oven/bun:1.4.2-slim AS target-deps',
      'COPY package.json bun.lock bunfig.toml ./',
      'RUN bun install --production',
      'RUN bun add left-pad',
      'FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps',
      'COPY package.json bun.lock bunfig.toml ./',
      'RUN bun install --production --os=linux --cpu=x64 && bun scripts/install-otel.ts --os=linux --cpu=x64',
      'FROM oven/bun:1.4.2-slim AS production',
      'COPY --from=deps /usr/src/app/node_modules ./node_modules',
      ...RUNTIME_TAIL,
    ];

    const errors = checkDockerfileBuildPlatform(lines.join('\n'));

    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(
      `Dockerfile:${lineOf(lines, 'FROM oven/bun:1.4.2-slim AS migrate')} `,
    );
    expect(errors[0]).toContain(
      `Dockerfile:${lineOf(lines, 'RUN bun run migrate')} runs \`bun run\``,
    );
    expect(errors[1]).toContain(
      `Dockerfile:${lineOf(lines, 'FROM oven/bun:1.4.2-slim AS target-deps')} `,
    );
    expect(errors[1]).toContain(`Dockerfile:${lineOf(lines, 'RUN bun install --production')} `);
    expect(errors[1]).toContain(`Dockerfile:${lineOf(lines, 'RUN bun add left-pad')} `);
  });
});

describe('lint-packaging · server.json npm launch shape (check 16, #622)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

  const LOG_LEVEL = {
    name: 'MCP_LOG_LEVEL',
    description: 'Sets the minimum log level for output.',
    format: 'string',
    isRequired: false,
    default: 'info',
  };
  const TRANSPORT_HTTP = {
    name: 'MCP_TRANSPORT_TYPE',
    description: 'Selects the HTTP transport.',
    format: 'string',
    value: 'http',
  };
  const HTTP_TRANSPORT = { type: 'streamable-http', url: 'http://localhost:3010/mcp' };

  /** One npm package entry; the defaults are a corrected stdio entry. */
  const npmEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    registryType: 'npm',
    registryBaseUrl: 'https://registry.npmjs.org',
    identifier: '@acme/probe-mcp-server',
    runtimeHint: 'npx',
    version: '0.1.0',
    environmentVariables: [LOG_LEVEL],
    transport: { type: 'stdio' },
    ...overrides,
  });
  const httpEntry = (environmentVariables: unknown[]): Record<string, unknown> =>
    npmEntry({ environmentVariables, transport: HTTP_TRANSPORT });
  const runScript = (script: string) => [
    { type: 'positional', value: 'run' },
    { type: 'positional', value: script },
  ];

  /** The two npm entries as `templates/server.json` shipped them through 0.13.10. */
  const PRE_FIX_PACKAGES = [
    npmEntry({ runtimeHint: 'node', packageArguments: runScript('start:stdio') }),
    npmEntry({
      runtimeHint: 'node',
      packageArguments: runScript('start:http'),
      transport: HTTP_TRANSPORT,
    }),
  ];

  it.each(['templates/server.json', 'server.json'])(
    'passes %s, whose npm entries take npx and no arguments',
    (file) => {
      const serverJson = JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8'));
      expect(checkServerJsonLaunch(serverJson)).toEqual([]);
      const npm = serverJson.packages.filter(
        (entry: { registryType: string }) => entry.registryType === 'npm',
      );
      expect(npm).toHaveLength(2);
      for (const entry of npm) {
        expect(entry.runtimeHint).toBe('npx');
        expect(entry.packageArguments).toBeUndefined();
      }
      const http = npm.find(
        (entry: { transport: { type: string } }) => entry.transport.type === 'streamable-http',
      );
      expect(http.environmentVariables).toContainEqual(TRANSPORT_HTTP);
    },
  );

  it('passes a corrected stdio + streamable-http pair', () => {
    const packages = [npmEntry(), httpEntry([TRANSPORT_HTTP, LOG_LEVEL])];
    expect(checkServerJsonLaunch({ packages })).toEqual([]);
  });

  it('fails the pre-fix template entries: both argument pairs and the missing transport', () => {
    const errors = checkServerJsonLaunch({ packages: PRE_FIX_PACKAGES });
    expect(errors).toHaveLength(3);
    expect(errors.filter((e) => e.startsWith('server.json packages[0]'))).toHaveLength(1);
    expect(errors.filter((e) => e.startsWith('server.json packages[1]'))).toHaveLength(2);
  });

  it('fails a streamable-http entry with no MCP_TRANSPORT_TYPE, naming the index and the fix', () => {
    const errors = checkServerJsonLaunch({ packages: [npmEntry(), httpEntry([LOG_LEVEL])] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('server.json packages[1]');
    expect(errors[0]).toContain('does not set MCP_TRANSPORT_TYPE');
    expect(errors[0]).toContain('"name": "MCP_TRANSPORT_TYPE"');
    expect(errors[0]).toContain('"value": "http"');
  });

  it('fails an MCP_TRANSPORT_TYPE carried only as a user-editable default', () => {
    const { value: _value, ...asDefault } = { ...TRANSPORT_HTTP, default: 'http' };
    const errors = checkServerJsonLaunch({ packages: [httpEntry([asDefault])] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('server.json packages[0]');
    expect(errors[0]).toContain('"default": "http"');
    expect(errors[0]).toContain('set "value": "http"');
  });

  it('fails an MCP_TRANSPORT_TYPE that declares neither value nor default', () => {
    const { value: _value, ...bare } = TRANSPORT_HTTP;
    const errors = checkServerJsonLaunch({ packages: [httpEntry([bare])] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('has no "value"');
    expect(errors[0]).toContain('set "value": "http"');
  });

  it.each(['stdio', 'HTTP', ''])('fails an MCP_TRANSPORT_TYPE value of %j', (value) => {
    const errors = checkServerJsonLaunch({
      packages: [httpEntry([{ ...TRANSPORT_HTTP, value }])],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('server.json packages[0]');
    expect(errors[0]).toContain(`"value" is "${value}"`);
    expect(errors[0]).toContain('set it to "http"');
  });

  it.each(['start:stdio', 'start:http', 'start'])(
    'fails an npm entry carrying the run + %s pair, naming the index and the fix',
    (script) => {
      const errors = checkServerJsonLaunch({
        packages: [npmEntry({ packageArguments: runScript(script) })],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('server.json packages[0]');
      expect(errors[0]).toContain(`"run" "${script}"`);
      expect(errors[0]).toContain('remove both arguments');
    },
  );

  it('keeps arguments that are not the npm-script pair', () => {
    const packages = [
      npmEntry({
        packageArguments: [
          { type: 'named', name: '--port', default: '3000' },
          { type: 'positional', value: 'run' },
        ],
      }),
      npmEntry({ packageArguments: [{ type: 'positional', value: 'start:http' }] }),
      npmEntry({
        packageArguments: [
          { type: 'named', name: 'run', value: 'start:http' },
          { type: 'positional', value: 'start:stdio' },
        ],
      }),
    ];
    expect(checkServerJsonLaunch({ packages })).toEqual([]);
  });

  it('reports each npm entry on its own index and leaves other registries alone', () => {
    const packages = [
      npmEntry({ packageArguments: runScript('start:stdio') }),
      {
        registryType: 'oci',
        identifier: 'ghcr.io/acme/probe-mcp-server',
        packageArguments: runScript('start:http'),
        transport: HTTP_TRANSPORT,
      },
      npmEntry(),
      httpEntry([LOG_LEVEL]),
    ];
    const errors = checkServerJsonLaunch({ packages });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('server.json packages[0]');
    expect(errors[0]).toContain('"run" "start:stdio"');
    expect(errors[1]).toContain('server.json packages[3]');
    expect(errors[1]).toContain('MCP_TRANSPORT_TYPE');
  });

  it('skips a server.json with no packages, or entries it cannot read', () => {
    expect(checkServerJsonLaunch({})).toEqual([]);
    expect(checkServerJsonLaunch({ packages: [] })).toEqual([]);
    expect(checkServerJsonLaunch({ packages: 'npm' })).toEqual([]);
    expect(checkServerJsonLaunch({ packages: [null, 'npm', 7] })).toEqual([]);
  });

  describe('standalone run', () => {
    const SCRIPT = join(REPO_ROOT, 'scripts/lint-packaging.ts');
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function project(serverJson: unknown, withManifest: boolean): string {
      dir = mkdtempSync(join(tmpdir(), 'lint-packaging-server-json-'));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'probe-mcp-server', version: '0.1.0' }),
      );
      if (serverJson !== undefined) {
        writeFileSync(join(dir, 'server.json'), JSON.stringify(serverJson));
      }
      if (withManifest) {
        writeFileSync(
          join(dir, 'manifest.json'),
          JSON.stringify({ name: 'probe-mcp-server', version: '0.1.0' }),
        );
      }
      return dir;
    }

    function lint(cwd: string): { code: number; out: string } {
      const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf8' });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    }

    it.each([false, true])(
      'fails the pre-fix template entries (manifest.json present: %s)',
      (withManifest) => {
        const { code, out } = lint(project({ packages: PRE_FIX_PACKAGES }, withManifest));
        expect(code).toBe(1);
        expect(out).toContain('server.json packages[0]');
        expect(out).toContain('server.json packages[1]');
        expect(out).toContain('MCP_TRANSPORT_TYPE');
      },
    );

    it('passes the corrected template', () => {
      const template = JSON.parse(readFileSync(join(REPO_ROOT, 'templates/server.json'), 'utf8'));
      const { code, out } = lint(project(template, false));
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });

    it('skips the check in a project without server.json', () => {
      const { code, out } = lint(project(undefined, false));
      expect(out).not.toContain('server.json packages');
      expect(code).toBe(0);
    });
  });
});
