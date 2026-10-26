/**
 * @fileoverview Tests for scripts/lint-packaging.ts — the manifest.json and
 * server.json alignment that runs inside `main()` (checks 1–4: no scope prefix on
 * the manifest name, `title`/`type` on every `user_config` entry, and stdio env
 * vars agreeing in both directions), the `.mcpbignore` static
 * guards (checks 5–7, issues #172/#207/#508), the post-bundle content check
 * (check 8, issues #230/#274/#783/#791, including the selectors shared with
 * scripts/clean-mcpb.ts), the identity checks (check 9, issue #231), and
 * the plugin marketplace manifests (check 10, issues #240/#393, and the Agent
 * Plugins root pair, #426), and the
 * npm `files` exclusion of the built bundle (check 13, issue #469), manifest.json
 * version parity (check 14), the Dockerfile stages that run JavaScript off
 * the build platform (check 15, #575), the launch shape of server.json npm
 * entries (check 16, #622), and the published root skills/ tree (check 17, #429).
 * Imports the real implementation; no inline mirror.
 * @module tests/unit/scripts/lint-packaging.test
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateSkillTree } from '@/mcp-server/skills.js';
import {
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY,
  BUILD_ONLY_ENTRY as CLEAN_BUILD_ONLY_ENTRY,
  NATIVE_BINDING_ENTRY as CLEAN_NATIVE_BINDING_ENTRY,
  NODE_GYP_OUTPUT as CLEAN_NODE_GYP_OUTPUT,
  filterBuildOnlyEntries as cleanFilterBuildOnlyEntries,
  filterNodeGypBuildEntries as cleanFilterNodeGypBuildEntries,
} from '../../../scripts/clean-mcpb.js';
import {
  AGENT_DOC_ENTRY,
  BUILD_ONLY_ENTRY,
  CRITICAL_RUNTIME_PATHS,
  checkBundleContent,
  checkBundleEntries,
  checkBundleExcludedFromFiles,
  checkDockerfileBuildPlatform,
  checkEntrypointIdentity,
  checkManifestIdentity,
  checkManifestUserConfigWiring,
  checkManifestVersion,
  checkPluginManifests,
  checkPublishedSkills,
  checkReadmeVersionBadge,
  checkServerJsonLaunch,
  checkSkillsKeptInBundle,
  filterNodeGypBuildEntries,
  KNOWN_DEV_DIRS,
  NATIVE_BINDING_ENTRY,
  NODE_GYP_OUTPUT,
} from '../../../scripts/lint-packaging.js';

describe('lint-packaging · manifest and server.json alignment (checks 1–4, standalone run)', () => {
  const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts/lint-packaging.ts');
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  type Json = Record<string, any>;

  /** A stdio bundle whose manifest and server.json agree on every env var. */
  function alignedPair(): { manifest: Json; serverJson: Json } {
    return {
      manifest: {
        name: 'probe-mcp-server',
        version: '0.1.0',
        server: {
          mcp_config: {
            command: 'node',
            args: [`\${__dirname}/dist/index.js`],
            env: {
              PROBE_API_KEY: `\${user_config.api_key}`,
              PROBE_REGION: `\${user_config.region}`,
              MCP_TRANSPORT_TYPE: 'stdio',
            },
          },
        },
        user_config: {
          api_key: { title: 'API key', type: 'string', required: true },
          region: { title: 'Region', type: 'string', default: '' },
        },
      },
      serverJson: {
        packages: [
          {
            registryType: 'npm',
            identifier: '@acme/probe-mcp-server',
            version: '0.1.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'PROBE_API_KEY', isRequired: true },
              { name: 'PROBE_REGION' },
              { name: 'PROBE_TIMEOUT_MS', isRequired: true, default: '30000' },
              { name: 'PROBE_DEBUG' },
            ],
          },
        ],
      },
    };
  }

  function lint(files: Record<string, unknown>): { code: number; lines: string[]; out: string } {
    dir = mkdtempSync(join(tmpdir(), 'lint-packaging-alignment-'));
    const project = {
      'package.json': { name: '@acme/probe-mcp-server', version: '0.1.0' },
      ...files,
    };
    for (const [relPath, content] of Object.entries(project)) {
      mkdirSync(join(dir, relPath, '..'), { recursive: true });
      writeFileSync(
        join(dir, relPath),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    const result = spawnSync('bun', ['run', SCRIPT], { cwd: dir, encoding: 'utf8' });
    const out = `${result.stdout}${result.stderr}`;
    return { code: result.status ?? -1, lines: out.split('\n'), out };
  }

  it('passes a manifest and server.json that agree on every stdio env var', () => {
    const { manifest, serverJson } = alignedPair();
    const { code, out } = lint({ 'manifest.json': manifest, 'server.json': serverJson });
    expect(out).toContain('Packaging alignment OK.');
    expect(code).toBe(0);
  });

  it('fails a scoped manifest name (check 1)', () => {
    const { manifest, serverJson } = alignedPair();
    manifest.name = '@acme/probe-mcp-server';
    const { code, out } = lint({ 'manifest.json': manifest, 'server.json': serverJson });
    expect(code).toBe(1);
    expect(out).toContain(
      'manifest.json "name" contains a scope prefix ("@acme/probe-mcp-server") — use the bare package name (e.g. "probe-mcp-server")',
    );
  });

  it('fails a user_config entry missing its title or type (check 2)', () => {
    const { manifest, serverJson } = alignedPair();
    manifest.user_config.api_key.type = '';
    delete manifest.user_config.region.title;
    const { code, out } = lint({ 'manifest.json': manifest, 'server.json': serverJson });
    expect(code).toBe(1);
    expect(out).toContain(
      'manifest.json user_config["api_key"] is missing required field(s): type',
    );
    expect(out).toContain(
      'manifest.json user_config["region"] is missing required field(s): title',
    );
  });

  it('fails a user_config env var that no stdio package advertises (check 3)', () => {
    const { manifest, serverJson } = alignedPair();
    const [stdio] = serverJson.packages;
    stdio.environmentVariables = stdio.environmentVariables.filter(
      (v: Json) => v.name !== 'PROBE_REGION',
    );
    // A non-stdio package advertising the var does not count.
    serverJson.packages.push({
      registryType: 'oci',
      identifier: 'ghcr.io/acme/probe-mcp-server',
      transport: { type: 'streamable-http', url: 'http://localhost:3010/mcp' },
      environmentVariables: [{ name: 'PROBE_REGION' }],
    });
    const { code, lines } = lint({ 'manifest.json': manifest, 'server.json': serverJson });
    expect(code).toBe(1);
    expect(lines).toContain(
      '  ✗ manifest.json references user_config env var(s) not advertised in server.json stdio environmentVariables[]: PROBE_REGION',
    );
  });

  it('fails a required stdio env var with no default that the manifest never sets (check 4)', () => {
    const { manifest, serverJson } = alignedPair();
    serverJson.packages[0].environmentVariables.push({ name: 'PROBE_ORG', isRequired: true });
    const { code, lines } = lint({ 'manifest.json': manifest, 'server.json': serverJson });
    expect(code).toBe(1);
    // PROBE_TIMEOUT_MS has a default and PROBE_DEBUG is optional, so neither is named.
    expect(lines).toContain(
      '  ✗ server.json declares required stdio env var(s) without default missing from manifest.json mcp_config.env: PROBE_ORG',
    );
  });

  it('fails a malformed manifest.json', () => {
    const { code, out } = lint({ 'manifest.json': '{ "name": ' });
    expect(code).toBe(1);
    expect(out).toContain('manifest.json is unreadable or malformed.');
  });

  it('skips the plugin manifest checks when devcheck.config.json turns them off', () => {
    const stalePlugin = {
      '.claude-plugin/plugin.json': {
        name: 'probe-mcp-server',
        version: '0.0.9',
        description: 'Probe server.',
      },
    };
    const enabled = lint(stalePlugin);
    expect(enabled.code).toBe(1);
    expect(enabled.out).toContain('.claude-plugin/plugin.json');
    rmSync(dir as string, { recursive: true, force: true });

    const disabled = lint({
      ...stalePlugin,
      'devcheck.config.json': { packaging: { pluginManifests: false } },
    });
    expect(disabled.out).toContain(
      'Plugin-manifest checks disabled via devcheck.config.json packaging.pluginManifests.',
    );
    expect(disabled.code).toBe(0);
  });
});

describe('lint-packaging · bundle-content guard (checks 5–7)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
  const template = readFileSync(join(REPO_ROOT, 'templates/_.mcpbignore'), 'utf8');

  /** `templates/_.mcpbignore` as it shipped through 0.13.17. */
  const PREVIOUS_TEMPLATE = [
    '.env*',
    '.mcpregistry_*',
    '/.claude/',
    '/.agents/',
    '/framework-skills/',
    '/docs/idea.md',
    '/logs/',
    '/Dockerfile',
    '/bun.lock',
    '/bunfig.toml',
    '/wrangler.toml',
    '/biome.json',
    '/tsconfig*.json',
    '/vitest.config.ts',
  ].join('\n');

  /** The anchored line each check-5 error asks for, sorted. */
  const missingLines = (errors: string[]): string[] =>
    errors
      .map((e) => /^\.mcpbignore does not exclude root dev .* add the line "([^"]+)"$/.exec(e)?.[1])
      .filter((line): line is string => line !== undefined)
      .sort();

  it.each(['templates/_.mcpbignore', '.mcpbignore'])('passes %s', async (file) => {
    expect(await checkBundleContent(readFileSync(join(REPO_ROOT, file), 'utf8'))).toEqual([]);
  });

  describe('dev-path exclusion (check 5)', () => {
    it('fails the previous template, naming each missing line', async () => {
      const errors = await checkBundleContent(PREVIOUS_TEMPLATE);
      expect(missingLines(errors)).toEqual(
        [
          '/src/',
          '/scripts/',
          '/tests/',
          '/docs/',
          '/changelog/',
          '/coverage/',
          '/.cache/',
          '/.github/',
          '/.vscode/',
          '/.claude-plugin/',
          '/.codex-plugin/',
          '/CLAUDE.md',
          '/AGENTS.md',
          '/plugin.json',
          '/mcp.json',
          '/.dockerignore',
          '/.gitattributes',
          '/devcheck.config.json',
        ].sort(),
      );
      expect(errors).toHaveLength(18);
    });

    it('flags a dev dir that is entirely missing from the ignore file', async () => {
      const errors = await checkBundleContent(template.replace('/framework-skills/\n', ''));
      expect(errors).toEqual([
        '.mcpbignore does not exclude root dev directory "framework-skills/" — the bundle ships it; add the line "/framework-skills/"',
      ]);
    });

    it('flags a dev file that is entirely missing from the ignore file', async () => {
      const errors = await checkBundleContent(template.replace('/AGENTS.md\n', ''));
      expect(errors).toEqual([
        '.mcpbignore does not exclude root dev file "AGENTS.md" — the bundle ships it; add the line "/AGENTS.md"',
      ]);
    });

    it('never requires excluding root skills/, which ships the skills a server publishes', () => {
      expect(KNOWN_DEV_DIRS).not.toContain('skills/');
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

    it('flags docs/ and CLAUDE.md written unanchored, one error each', async () => {
      const content = template
        .replace('/docs/\n', 'docs/\n')
        .replace('/CLAUDE.md\n', 'CLAUDE.md\n');
      const errors = await checkBundleContent(content);
      expect(errors).toEqual([
        '.mcpbignore uses an unanchored pattern that also strips runtime paths under node_modules: [docs/]. Use a leading "/" to anchor to root (e.g. "/docs/").',
        '.mcpbignore uses an unanchored pattern that also strips runtime paths under node_modules: [CLAUDE.md]. Use a leading "/" to anchor to root (e.g. "/CLAUDE.md").',
      ]);
    });

    it('leaves a pattern written against node_modules/ to check 7', async () => {
      const errors = await checkBundleContent(`${template}/node_modules/**/tests/\n`);
      expect(errors).toEqual([]);
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
    /** The check-7 errors, keyed by the runtime path each names. */
    const strippedPaths = (errors: string[]): string[] =>
      errors
        .map((e) => /would strip critical runtime path "([^"]+)"/.exec(e)?.[1])
        .filter((path): path is string => path !== undefined);

    it('flags a pattern that strips all node_modules paths', async () => {
      const content = `${template}node_modules/**\n`;
      const errors = await checkBundleContent(content);
      expect(strippedPaths(errors)).toEqual([
        'node_modules/@opentelemetry/api/dist/',
        'node_modules/@opentelemetry/semantic-conventions/build/src/',
        'node_modules/@modelcontextprotocol/server/dist/',
        'node_modules/@cyanheads/mcp-ts-core/dist/',
      ]);
    });

    it('flags an unanchored dist/, naming every dist/ runtime path', async () => {
      const errors = await checkBundleContent(`${template}dist/\n`);
      expect(strippedPaths(errors)).toEqual([
        'node_modules/@opentelemetry/api/dist/',
        'node_modules/@modelcontextprotocol/server/dist/',
        'node_modules/@cyanheads/mcp-ts-core/dist/',
        'dist/index.js',
      ]);
    });

    it('flags an unanchored build/, naming the build/ runtime path', async () => {
      const errors = await checkBundleContent(`${template}build/\n`);
      expect(errors).toEqual([
        '.mcpbignore pattern(s) [build/] would strip critical runtime path ' +
          '"node_modules/@opentelemetry/semantic-conventions/build/src/" — add a leading "/" to anchor to root (e.g. "/build/").',
      ]);
    });

    it('samples dependency paths that exist in a current install', () => {
      // This repository is @cyanheads/mcp-ts-core, so its own dist/ is not under node_modules/.
      const dependencyPaths = CRITICAL_RUNTIME_PATHS.filter(
        (path) =>
          path.startsWith('node_modules/') &&
          !path.startsWith('node_modules/@cyanheads/mcp-ts-core/'),
      );
      expect(dependencyPaths).toHaveLength(3);
      for (const path of dependencyPaths) {
        expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
      }
    });
  });

  describe('edge cases', () => {
    it('ignores comment lines', async () => {
      // A commented-out line excludes nothing.
      const errors = await checkBundleContent(template.replace('/src/\n', '# /src/\n'));
      expect(missingLines(errors)).toEqual(['/src/']);
      expect(errors).toHaveLength(1);
    });

    it('handles empty .mcpbignore — every dev dir and file unexcluded', async () => {
      const errors = await checkBundleContent('');
      expect(errors.filter((e) => e.includes('does not exclude'))).toHaveLength(22);
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

  describe('node-gyp build output (#783) and build-only package files (#791)', () => {
    /** One bundle listing both scripts' selectors run over: the stripped classes and their runtime neighbours. */
    const LISTING = [
      'manifest.json',
      'dist/index.js',
      'skills/repro-guide/SKILL.md',
      // better-sqlite3: a node-gyp tree beside binding.gyp, plus its C sources.
      'node_modules/better-sqlite3/binding.gyp',
      'node_modules/better-sqlite3/package.json',
      'node_modules/better-sqlite3/lib/index.js',
      'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      'node_modules/better-sqlite3/deps/',
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      'node_modules/better-sqlite3/src/better_sqlite3.cpp',
      'node_modules/better-sqlite3/build/',
      'node_modules/better-sqlite3/build/Makefile',
      'node_modules/better-sqlite3/build/config.gypi',
      'node_modules/better-sqlite3/build/binding.Makefile',
      'node_modules/better-sqlite3/build/better_sqlite3.target.mk',
      'node_modules/better-sqlite3/build/gyp-mac-tool',
      'node_modules/better-sqlite3/build/gyp-flock-tool',
      'node_modules/better-sqlite3/build/binding.sln',
      'node_modules/better-sqlite3/build/better_sqlite3.vcxproj',
      'node_modules/better-sqlite3/build/better_sqlite3.vcxproj.filters',
      'node_modules/better-sqlite3/build/node_gyp_bins/python3',
      'node_modules/better-sqlite3/build/better_sqlite3.node',
      'node_modules/better-sqlite3/build/Release/',
      'node_modules/better-sqlite3/build/Release/.deps/Release/obj.target/better_sqlite3.stamp.d',
      'node_modules/better-sqlite3/build/Release/obj.target/',
      'node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.stamp',
      'node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3/src/better_sqlite3.o',
      'node_modules/better-sqlite3/build/Release/obj/better_sqlite3/better_sqlite3.obj',
      'node_modules/better-sqlite3/build/Release/sqlite3.a',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.lib',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.exp',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.pdb',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.ilk',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.iobj',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.ipdb',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/better-sqlite3/build/Release/test_extension.node',
      'node_modules/better-sqlite3/build/Release/libsqlite3.dylib',
      'node_modules/better-sqlite3/build/Debug/better_sqlite3.node',
      // sharp keeps binding.gyp below its package root, so its tree is src/build/.
      'node_modules/sharp/lib/index.js',
      'node_modules/sharp/src/binding.gyp',
      'node_modules/sharp/src/build/config.gypi',
      'node_modules/sharp/src/build/Release/sharp-darwin-arm64v8.node',
      // A build/ with no sibling binding.gyp is runtime code, generator-like names included.
      'node_modules/@opentelemetry/semantic-conventions/build/src/index.js',
      'node_modules/pino/build/sync-version.js',
      'node_modules/other/build/Makefile',
      // mcp-ts-core: build-only files beside the runtime dist/ and package.json.
      'node_modules/@cyanheads/mcp-ts-core/package.json',
      'node_modules/@cyanheads/mcp-ts-core/README.md',
      'node_modules/@cyanheads/mcp-ts-core/dist/core/index.js',
      'node_modules/@cyanheads/mcp-ts-core/dist/cli/init.js',
      'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/AGENTS.md',
      'node_modules/@cyanheads/mcp-ts-core/biome.json',
      'node_modules/@cyanheads/mcp-ts-core/vitest.config.base.mjs',
      'node_modules/@cyanheads/mcp-ts-core/config/',
      'node_modules/@cyanheads/mcp-ts-core/config/tsconfig.base.json',
      'node_modules/@cyanheads/mcp-ts-core/changelog/0.13.x/0.13.17.md',
      'node_modules/@cyanheads/mcp-ts-core/scripts/devcheck.ts',
      'node_modules/@cyanheads/mcp-ts-core/templates/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/templates/src/index.ts',
      // The same names elsewhere ship.
      'node_modules/other/CLAUDE.md',
      'node_modules/other/scripts/postinstall.js',
      'node_modules/other/src/index.js',
      'node_modules/other/biome.json',
      'node_modules/other/config/tsconfig.base.json',
      'node_modules/@cyanheads/mcp-ts-core/dist/scripts/helper.js',
      'node_modules/@cyanheads/mcp-ts-core/dist/config/index.js',
      'node_modules/@cyanheads/mcp-ts-core/templates-extra/biome.json',
      'node_modules/better-sqlite3-extra/src/index.js',
      // A nested install of either package is selected the same way.
      'node_modules/a/node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/a/node_modules/better-sqlite3/deps/sqlite3/sqlite3.h',
    ];

    const NODE_GYP = [
      'node_modules/better-sqlite3/build/Makefile',
      'node_modules/better-sqlite3/build/config.gypi',
      'node_modules/better-sqlite3/build/binding.Makefile',
      'node_modules/better-sqlite3/build/better_sqlite3.target.mk',
      'node_modules/better-sqlite3/build/gyp-mac-tool',
      'node_modules/better-sqlite3/build/gyp-flock-tool',
      'node_modules/better-sqlite3/build/binding.sln',
      'node_modules/better-sqlite3/build/better_sqlite3.vcxproj',
      'node_modules/better-sqlite3/build/better_sqlite3.vcxproj.filters',
      'node_modules/better-sqlite3/build/node_gyp_bins/python3',
      'node_modules/better-sqlite3/build/Release/.deps/Release/obj.target/better_sqlite3.stamp.d',
      'node_modules/better-sqlite3/build/Release/obj.target/',
      'node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.stamp',
      'node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3/src/better_sqlite3.o',
      'node_modules/better-sqlite3/build/Release/obj/better_sqlite3/better_sqlite3.obj',
      'node_modules/better-sqlite3/build/Release/sqlite3.a',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.lib',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.exp',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.pdb',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.ilk',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.iobj',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.ipdb',
      'node_modules/sharp/src/build/config.gypi',
    ];

    const BUILD_ONLY = [
      'node_modules/better-sqlite3/deps/',
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      'node_modules/better-sqlite3/src/better_sqlite3.cpp',
      'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/AGENTS.md',
      'node_modules/@cyanheads/mcp-ts-core/biome.json',
      'node_modules/@cyanheads/mcp-ts-core/vitest.config.base.mjs',
      'node_modules/@cyanheads/mcp-ts-core/config/',
      'node_modules/@cyanheads/mcp-ts-core/config/tsconfig.base.json',
      'node_modules/@cyanheads/mcp-ts-core/changelog/0.13.x/0.13.17.md',
      'node_modules/@cyanheads/mcp-ts-core/scripts/devcheck.ts',
      'node_modules/@cyanheads/mcp-ts-core/templates/CLAUDE.md',
      'node_modules/@cyanheads/mcp-ts-core/templates/src/index.ts',
      'node_modules/a/node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
      'node_modules/a/node_modules/better-sqlite3/deps/sqlite3/sqlite3.h',
    ];

    it('keeps the node-gyp selector in sync with clean-mcpb.ts over one listing', () => {
      expect(NODE_GYP_OUTPUT.source).toBe(CLEAN_NODE_GYP_OUTPUT.source);
      expect(NODE_GYP_OUTPUT.flags).toBe(CLEAN_NODE_GYP_OUTPUT.flags);
      expect(filterNodeGypBuildEntries(LISTING)).toEqual(NODE_GYP);
      expect(cleanFilterNodeGypBuildEntries(LISTING)).toEqual(NODE_GYP);
    });

    it('keeps the build-only filter in sync with clean-mcpb.ts over one listing', () => {
      expect(BUILD_ONLY_ENTRY.source).toBe(CLEAN_BUILD_ONLY_ENTRY.source);
      expect(BUILD_ONLY_ENTRY.flags).toBe(CLEAN_BUILD_ONLY_ENTRY.flags);
      expect(LISTING.filter((entry) => BUILD_ONLY_ENTRY.test(entry))).toEqual(BUILD_ONLY);
      expect(cleanFilterBuildOnlyEntries(LISTING)).toEqual(BUILD_ONLY);
    });

    it('fails an uncleaned listing with one error per class, naming the count and a sample', () => {
      const errors = checkBundleEntries(LISTING, 'dist/test.mcpb');
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('dist/test.mcpb contains 23 node-gyp build entries');
      expect(errors[0]).toContain('\n      node_modules/better-sqlite3/build/Makefile');
      expect(errors[0]).toContain('clean-mcpb.ts');
      expect(errors[1]).toContain('dist/test.mcpb contains 15 build-only package entries');
      expect(errors[1]).toContain('\n      node_modules/better-sqlite3/deps/');
      expect(errors[1]).toContain('clean-mcpb.ts');
    });

    it('passes the listing once both classes are stripped', () => {
      const stripped = new Set([...NODE_GYP, ...BUILD_ONLY]);
      const cleaned = LISTING.filter((entry) => !stripped.has(entry));
      expect(checkBundleEntries(cleaned, 'dist/test.mcpb')).toEqual([]);
      expect(cleaned).toContain('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
      expect(cleaned).toContain('node_modules/better-sqlite3/build/Debug/better_sqlite3.node');
      expect(cleaned).toContain('node_modules/better-sqlite3/build/Release/libsqlite3.dylib');
      expect(cleaned).toContain('node_modules/sharp/src/build/Release/sharp-darwin-arm64v8.node');
      expect(cleaned).toContain(
        'node_modules/@opentelemetry/semantic-conventions/build/src/index.js',
      );
      expect(cleaned).toContain('node_modules/@cyanheads/mcp-ts-core/dist/core/index.js');
      expect(cleaned).toContain('node_modules/@cyanheads/mcp-ts-core/package.json');
    });
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

describe('lint-packaging · Agent Plugins root pair (check 10, #426)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
  const UNSCOPED = 'pubmed-mcp-server';
  const FULL = '@cyanheads/pubmed-mcp-server';
  const VERSION = '0.2.6';
  const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

  /** `${name}` as a plain string, built so Biome's template-placeholder rule stays quiet. */
  const placeholder = (name: string) => ['$', `{${name}}`].join('');

  type Json = Record<string, any>;

  const rootPlugin = (overrides: Json = {}): Json => ({
    $schema: PLUGIN_SCHEMA,
    name: UNSCOPED,
    version: VERSION,
    description: 'Search and fetch PubMed articles.',
    author: { name: 'cyanheads', email: 'casey@example.com', url: 'https://example.com' },
    homepage: 'https://github.com/cyanheads/pubmed-mcp-server',
    repository: 'https://github.com/cyanheads/pubmed-mcp-server',
    license: 'Apache-2.0',
    keywords: ['mcp'],
    ...overrides,
  });
  const stdioEntry = (overrides: Json = {}): Json => ({
    type: 'stdio',
    command: 'npx',
    args: ['-y', FULL],
    env: { MCP_TRANSPORT_TYPE: 'stdio' },
    ...overrides,
  });
  const rootMcp = (entry: Json = stdioEntry()): Json => ({
    $schema: MCP_SCHEMA,
    mcpServers: { [UNSCOPED]: entry },
  });
  const codexPlugin = (overrides: Json = {}): Json => ({
    name: UNSCOPED,
    version: VERSION,
    description: 'Search and fetch PubMed articles.',
    mcpServers: './.codex-plugin/mcp.json',
    interface: {
      displayName: UNSCOPED,
      shortDescription: 'Search PubMed.',
      longDescription: 'Search and fetch PubMed articles via E-utilities.',
    },
    ...overrides,
  });
  const codexMcp = (overrides: Json = {}): Json => ({
    [UNSCOPED]: {
      command: 'npx',
      args: ['-y', FULL],
      env: { MCP_TRANSPORT_TYPE: 'stdio' },
      ...overrides,
    },
  });

  const check = (inputs: Parameters<typeof checkPluginManifests>[0], unscoped = UNSCOPED) =>
    checkPluginManifests(inputs, unscoped, unscoped === UNSCOPED ? FULL : unscoped, VERSION);

  /** The pair plus the Codex overlay, every rule satisfied. */
  const VALID = () => ({
    rootPlugin: rootPlugin(),
    rootMcp: rootMcp(),
    codexPlugin: codexPlugin(),
    codexMcp: codexMcp(),
  });

  it('passes a fully populated pair beside the Codex overlay', () => {
    expect(check(VALID())).toEqual([]);
  });

  describe('the scaffold templates', () => {
    /** Each plugin template as `init` writes it for `demo-server`. */
    const rendered = (file: string, description = ''): unknown =>
      JSON.parse(
        readFileSync(join(REPO_ROOT, 'templates', file), 'utf8')
          .replaceAll('{{PACKAGE_NAME}}', 'demo-server')
          .replaceAll('"description": ""', `"description": "${description}"`)
          .replaceAll('Description": ""', `Description": "${description}"`),
      );
    const scaffold = (description?: string) => ({
      rootPlugin: rendered('plugin.json', description),
      rootMcp: rendered('mcp.json', description),
      claudePlugin: rendered('.claude-plugin/plugin.json', description),
      codexPlugin: rendered('.codex-plugin/plugin.json', description),
      codexMcp: rendered('.codex-plugin/mcp.json', description),
    });

    it('reports only the empty descriptions on a fresh scaffold', () => {
      const errors = checkPluginManifests(scaffold(), 'demo-server', 'demo-server', '0.1.0');
      expect(errors.map((e) => e.split(' — ')[0])).toEqual([
        '.claude-plugin/plugin.json "description" is empty',
        '.codex-plugin/plugin.json "description" is empty',
        '.codex-plugin/plugin.json interface.shortDescription is empty',
        '.codex-plugin/plugin.json interface.longDescription is empty',
        'plugin.json "description" is empty',
      ]);
    });

    it('passes once the descriptions are populated', () => {
      const errors = checkPluginManifests(
        scaffold('A demo server.'),
        'demo-server',
        'demo-server',
        '0.1.0',
      );
      expect(errors).toEqual([]);
    });

    it('ships the root pair keyed and launched like the overlays', () => {
      const pair = scaffold();
      expect(pair.rootPlugin).toMatchObject({ $schema: PLUGIN_SCHEMA, name: 'demo-server' });
      expect(pair.rootMcp).toEqual({
        $schema: MCP_SCHEMA,
        mcpServers: {
          'demo-server': {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'demo-server'],
            env: { MCP_TRANSPORT_TYPE: 'stdio' },
          },
        },
      });
      // The overlays stay as they are: Codex merges env_vars through this pointer.
      expect(pair.codexPlugin).toMatchObject({ mcpServers: './.codex-plugin/mcp.json' });
    });
  });

  describe('plugin.json', () => {
    it.each([
      ['a draft schema', 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json'],
      ['the Claude Code schema', 'https://json.schemastore.org/claude-code-plugin-manifest.json'],
    ])('fails %s', (_label, schema) => {
      const errors = check({ ...VALID(), rootPlugin: rootPlugin({ $schema: schema }) });
      expect(errors).toEqual([
        `plugin.json "$schema" is "${schema}" — must be "${PLUGIN_SCHEMA}"; Codex accepts only Agent Plugins 1.0.0 and rejects the plugin otherwise`,
      ]);
    });

    it('fails a missing $schema', () => {
      const { $schema: _omitted, ...noSchema } = rootPlugin();
      const errors = check({ ...VALID(), rootPlugin: noSchema });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('plugin.json "$schema" is absent');
    });

    it('rejects extensions and every other field outside the closed set', () => {
      const errors = check({
        ...VALID(),
        rootPlugin: rootPlugin({
          extensions: { 'com.openai': { interface: {} } },
          mcpServers: './mcp.json',
          interface: {},
        }),
      });
      expect(errors).toHaveLength(3);
      expect(errors[0]).toContain('plugin.json carries "extensions"');
      expect(errors[0]).toContain('interface in Codex');
      expect(errors[1]).toContain('plugin.json carries "mcpServers", outside the closed');
      expect(errors[2]).toContain('plugin.json carries "interface", outside the closed');
    });

    it('fails a metadata field of the wrong type', () => {
      const errors = check({
        ...VALID(),
        rootPlugin: rootPlugin({
          author: { name: 'cyanheads', github: 'cyanheads' },
          keywords: 'mcp',
          homepage: 7,
        }),
      });
      expect(errors.map((e) => e.split(' — ')[0])).toEqual([
        'plugin.json "author" must be an object carrying only string "name", "email", and "url"',
        'plugin.json "homepage" must be a string',
        'plugin.json "keywords" must be an array of strings',
      ]);
    });

    it('requires a non-empty description and the package version', () => {
      const errors = check({
        ...VALID(),
        rootPlugin: rootPlugin({ description: ' ', version: '0.2.4' }),
      });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('plugin.json "description" is empty');
      expect(errors[1]).toBe(
        'plugin.json "version" is "0.2.4" — must equal the package.json version "0.2.6"',
      );
    });

    it('fails a name that is not the unscoped package name', () => {
      const errors = check({ ...VALID(), rootPlugin: rootPlugin({ name: FULL }) });
      expect(errors).toEqual([
        `plugin.json "name" is "${FULL}" — must equal the unscoped package name "${UNSCOPED}"`,
      ]);
    });

    it('fails a project named My_Server with a §5.5 message', () => {
      const name = 'My_Server';
      const errors = check(
        {
          rootPlugin: rootPlugin({ name }),
          rootMcp: {
            $schema: MCP_SCHEMA,
            mcpServers: { [name]: stdioEntry({ args: ['-y', name] }) },
          },
        },
        name,
      );
      expect(errors).toEqual([
        'plugin.json "name" must be the unscoped package name "My_Server", which breaks Agent Plugins §5.5 — ' +
          'a plugin name is 1–64 characters from a-z, 0-9, "-", and ".", alphanumeric at both ends, with no "--" ' +
          'or ".."; Codex and the other Agent Plugins clients reject the plugin, so rename the package to comply',
      ]);
    });

    /** The pair for a project named `name`, its mcp.json empty: only the name rules apply. */
    const named = (name: string) =>
      check(
        { rootPlugin: rootPlugin({ name }), rootMcp: { $schema: MCP_SCHEMA, mcpServers: {} } },
        name,
      );

    it.each(['a', 'acme.tools', 'lint3r', `${'a'.repeat(63)}z`])(
      'accepts the §5.5 name %s',
      (name) => {
        expect(named(name).filter((e) => e.includes('§5.5'))).toEqual([]);
      },
    );

    it.each(['-start', 'end-', 'has--double', 'too.many..dots', 'a'.repeat(65), 'My-Plugin'])(
      'rejects the §5.5 name %s',
      (name) => {
        expect(named(name).filter((e) => e.includes('§5.5'))).toHaveLength(1);
      },
    );

    it('fails a plugin.json without mcp.json beside it', () => {
      const errors = check({ rootPlugin: rootPlugin() });
      expect(errors).toEqual([
        'plugin.json has no mcp.json beside it — Agent Plugins clients load MCP servers only from root mcp.json, ' +
          'so the plugin installs without its server; add mcp.json',
      ]);
    });

    it('fails a plugin.json or mcp.json that did not parse', () => {
      expect(check({ ...VALID(), rootPlugin: null })).toEqual([
        'plugin.json is not a JSON object — Agent Plugins clients reject the plugin',
      ]);
      expect(check({ ...VALID(), rootMcp: null })).toEqual([
        'mcp.json is not a JSON object — Agent Plugins clients disable MCP for the plugin',
      ]);
    });
  });

  describe('mcp.json', () => {
    it('fails a wrong $schema and an extra top-level field', () => {
      const errors = check({
        ...VALID(),
        rootMcp: {
          ...rootMcp(),
          $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
          servers: {},
        },
      });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(
        'mcp.json "$schema" is "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json"',
      );
      expect(errors[0]).toContain(MCP_SCHEMA);
      expect(errors[1]).toContain('mcp.json carries "servers"');
    });

    it('requires every server key to be the unscoped name', () => {
      const errors = check({
        ...VALID(),
        rootMcp: { $schema: MCP_SCHEMA, mcpServers: { [FULL]: stdioEntry() } },
      });
      expect(errors).toEqual([
        `mcp.json mcpServers has no "${UNSCOPED}" entry — the server key must be the unscoped package name`,
        `mcp.json mcpServers["${FULL}"] — every server key must be the unscoped package name "${UNSCOPED}"`,
      ]);
    });

    it('rejects fields outside the closed stdio variant, env_vars included', () => {
      const errors = check({
        ...VALID(),
        rootMcp: rootMcp(
          stdioEntry({ env_vars: ['NCBI_API_KEY'], url: 'https://example.com/mcp' }),
        ),
      });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(`mcp.json mcpServers["${UNSCOPED}"] carries "env_vars"`);
      expect(errors[0]).toContain('list env_vars in .codex-plugin/mcp.json');
      expect(errors[1]).toContain(`mcp.json mcpServers["${UNSCOPED}"] carries "url"`);
    });

    it.each([
      [
        'a streamable-http type',
        { type: 'streamable-http' },
        '"type" is "streamable-http" — must be "stdio"',
      ],
      ['a missing type', { type: undefined }, '"type" is absent — must be "stdio"'],
      [
        'a plugin-relative command',
        { command: './bin/server' },
        '"command" is "./bin/server" — must be a bare executable name',
      ],
      [
        'a shell command string',
        { command: 'npx -y' },
        '"command" is "npx -y" — must be a bare executable name',
      ],
      [
        'an unscoped install arg',
        { args: ['-y', UNSCOPED] },
        `install arg is "${UNSCOPED}" — must be the full package name "${FULL}"`,
      ],
      [
        'a non-string arg',
        { args: ['-y', FULL, 3] },
        '"args" is ["-y","@cyanheads/pubmed-mcp-server",3] — must be an array of strings',
      ],
      ['a cwd outside the plugin', { cwd: '/tmp' }, '"cwd" is "/tmp" — must start with'],
    ])('fails %s', (_label, overrides, message) => {
      const errors = check({ ...VALID(), rootMcp: rootMcp(stdioEntry(overrides)) });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`mcp.json mcpServers["${UNSCOPED}"] ${message}`);
    });

    it('accepts a cwd rooted at the plugin or its data directory', () => {
      for (const cwd of ['./', placeholder('PLUGIN_ROOT'), `${placeholder('PLUGIN_DATA')}/cache`]) {
        expect(check({ ...VALID(), rootMcp: rootMcp(stdioEntry({ cwd })) }), cwd).toEqual([]);
      }
    });
  });

  describe('mcp.json env', () => {
    /** VALID with the same env on both connection configs, so parity stays out of the way. */
    const withEnv = (env: Json) => ({
      ...VALID(),
      rootMcp: rootMcp(stdioEntry({ env })),
      codexMcp: codexMcp({ env }),
    });
    const at = `mcp.json mcpServers["${UNSCOPED}"].env`;

    it('fails an empty value', () => {
      const errors = check(withEnv({ MCP_TRANSPORT_TYPE: 'stdio', NCBI_API_KEY: '' }));
      // The overlay's own empty-value rule fires first; the root entry gets its own error.
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain(`.codex-plugin/mcp.json "${UNSCOPED}".env.NCBI_API_KEY is ""`);
      expect(errors[1]).toContain(`${at}.NCBI_API_KEY is "" — an empty value replaces`);
      expect(errors[1]).toContain('"env_vars"');
      expect(errors[1]).toContain('"userConfig"');
    });

    it('fails a PLUGIN_ROOT or PLUGIN_DATA key', () => {
      const errors = check(withEnv({ PLUGIN_ROOT: '/x', PLUGIN_DATA: '/y' }));
      expect(errors.map((e) => e.split(' — ')[0])).toEqual([
        `${at}.PLUGIN_ROOT`,
        `${at}.PLUGIN_DATA`,
      ]);
      expect(errors[0]).toContain('PLUGIN_ROOT is reserved');
    });

    it('fails any placeholder besides PLUGIN_ROOT and PLUGIN_DATA', () => {
      const errors = check(
        withEnv({
          NCBI_API_KEY: placeholder('NCBI_API_KEY'),
          REGION: placeholder('user_config.region'),
          CACHE_DIR: `${placeholder('PLUGIN_DATA')}/cache`,
          CONFIG: `${placeholder('PLUGIN_ROOT')}/config.json`,
        }),
      );
      expect(errors.map((e) => e.split(' — ')[0])).toEqual([
        `${at}.NCBI_API_KEY references "${placeholder('NCBI_API_KEY')}"`,
        `${at}.REGION references "${placeholder('user_config.region')}"`,
      ]);
      expect(errors[0]).toContain('the server receives the literal string');
    });

    it('requires the same env as .codex-plugin/mcp.json', () => {
      const errors = check({
        ...VALID(),
        rootMcp: rootMcp(
          stdioEntry({ env: { MCP_TRANSPORT_TYPE: 'stdio', MCP_LOG_LEVEL: 'info' } }),
        ),
        codexMcp: codexMcp({ env: { MCP_TRANSPORT_TYPE: 'http' } }),
      });
      expect(errors).toEqual([
        `${at} differs from .codex-plugin/mcp.json "${UNSCOPED}".env at MCP_TRANSPORT_TYPE, MCP_LOG_LEVEL — keep ` +
          'the two identical: Codex starts the server from root mcp.json, and other Agent Plugins clients read nothing else',
      ]);
    });

    it('skips env parity when the project has no .codex-plugin/mcp.json', () => {
      const { codexMcp: _omitted, ...noCodexMcp } = VALID();
      expect(check(noCodexMcp)).toEqual([]);
    });
  });

  describe('Codex env_vars overlay', () => {
    const keyed = (overrides: Json = {}) => ({
      ...VALID(),
      codexMcp: codexMcp({
        env_vars: ['NCBI_API_KEY', { name: 'NCBI_ADMIN_EMAIL', source: 'local' }],
      }),
      ...overrides,
    });

    it('passes a keyed server whose overlay keeps the mcpServers pointer', () => {
      expect(check(keyed())).toEqual([]);
    });

    it('fails when .codex-plugin/plugin.json is absent, naming each dropped variable', () => {
      const errors = check(keyed({ codexPlugin: undefined }));
      expect(errors).toEqual([
        '.codex-plugin/mcp.json forwards NCBI_API_KEY, NCBI_ADMIN_EMAIL through "env_vars", but ' +
          '.codex-plugin/plugin.json is absent — with root mcp.json present, Codex merges env_vars into its ' +
          'server only through .codex-plugin/plugin.json "mcpServers": "./.codex-plugin/mcp.json", so it drops ' +
          'each of those variables without an error',
      ]);
    });

    it.each([
      ['removed', undefined, 'absent'],
      ['repointed', './mcp.json', '"./mcp.json"'],
    ])('fails when the overlay mcpServers pointer is %s', (_label, mcpServers, shown) => {
      const errors = check(keyed({ codexPlugin: codexPlugin({ mcpServers }) }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        `forwards NCBI_API_KEY, NCBI_ADMIN_EMAIL through "env_vars", but .codex-plugin/plugin.json "mcpServers" is ${shown}`,
      );
    });

    it('needs no pointer for a keyless server', () => {
      expect(check({ ...VALID(), codexPlugin: undefined })).toEqual([]);
    });
  });

  describe('without root plugin.json (regression)', () => {
    it('validates the overlays exactly as before and ignores a root mcp.json', () => {
      const clientConfigSample = {
        mcpServers: { local: { command: 'node', args: ['dist/index.js'], env: { KEY: '' } } },
      };
      expect(
        check({ codexPlugin: codexPlugin(), codexMcp: codexMcp(), rootMcp: clientConfigSample }),
      ).toEqual([]);
      expect(
        check({
          codexPlugin: codexPlugin({ mcpServers: undefined }),
          codexMcp: codexMcp({ env_vars: ['NCBI_API_KEY'] }),
          rootMcp: rootMcp(),
        }),
      ).toEqual([]);
    });
  });

  describe('standalone run', () => {
    const SCRIPT = join(REPO_ROOT, 'scripts/lint-packaging.ts');
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function lint(files: Record<string, unknown>): { code: number; out: string } {
      dir = mkdtempSync(join(tmpdir(), 'lint-packaging-root-pair-'));
      const project = { 'package.json': { name: FULL, version: VERSION }, ...files };
      for (const [relPath, content] of Object.entries(project)) {
        mkdirSync(join(dir, relPath, '..'), { recursive: true });
        writeFileSync(
          join(dir, relPath),
          typeof content === 'string' ? content : JSON.stringify(content),
        );
      }
      const result = spawnSync('bun', ['run', SCRIPT], { cwd: dir, encoding: 'utf8' });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    }

    it('passes a valid root pair', () => {
      const { code, out } = lint({ 'plugin.json': rootPlugin(), 'mcp.json': rootMcp() });
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });

    it('fails a plugin.json that does not parse', () => {
      const { code, out } = lint({ 'plugin.json': '{ "name": ', 'mcp.json': rootMcp() });
      expect(code).toBe(1);
      expect(out).toContain('plugin.json is not a JSON object');
    });

    it('leaves a root mcp.json alone when there is no plugin.json', () => {
      const { code, out } = lint({ 'mcp.json': { mcpServers: { local: { command: 'node' } } } });
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });
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

describe('lint-packaging · published skills (check 17, #429)', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
  const template = readFileSync(join(REPO_ROOT, 'templates/_.mcpbignore'), 'utf8');
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  type TreeEntry = string | Buffer | { symlinkTo: string };

  /** A project directory holding `files` (paths from the project root); returns its path. */
  function project(files: Record<string, TreeEntry>): string {
    dir = mkdtempSync(join(tmpdir(), 'lint-packaging-skills-'));
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(dir, relPath);
      mkdirSync(join(full, '..'), { recursive: true });
      if (typeof content === 'object' && 'symlinkTo' in content)
        symlinkSync(content.symlinkTo, full);
      else writeFileSync(full, content);
    }
    return dir;
  }

  const skillMd = (...frontmatter: string[]): string =>
    `---\n${frontmatter.join('\n')}\n---\n\n# Guide\n`;
  const conformant = (name: string, ...extra: string[]): string =>
    skillMd(`name: ${name}`, `description: Chain demo_search into demo_get.`, ...extra);

  /** check 17 over the project's root `skills/`, with the source `validateSkillTree`. */
  const lintSkills = (files: Record<string, TreeEntry>): Promise<string[]> =>
    checkPublishedSkills(join(project(files), 'skills'), validateSkillTree);

  it('passes a conformant tree', async () => {
    expect(
      await lintSkills({
        'skills/demo-guide/SKILL.md': conformant(
          'demo-guide',
          'license: Apache-2.0',
          'compatibility: Requires network access.',
          'allowed-tools: Bash(git:*) Read',
          'metadata:',
          '  author: owner',
          '  version: "1.0"',
        ),
        'skills/demo-guide/references/ids.md': '# IDs\n',
      }),
    ).toEqual([]);
  });

  it('passes a host-specific field beyond the specification', async () => {
    expect(
      await lintSkills({
        'skills/demo-guide/SKILL.md': conformant('demo-guide', 'disable-model-invocation: true'),
      }),
    ).toEqual([]);
  });

  describe('SDK rules, through validateSkillTree', () => {
    it.each<[string, Record<string, TreeEntry>, string[]]>([
      [
        'name missing',
        { 'skills/x/SKILL.md': skillMd('description: A guide.') },
        ['skills/x/SKILL.md: ', 'must contain string "name"'],
      ],
      [
        'name not a string',
        { 'skills/123/SKILL.md': skillMd('name: 123', 'description: A guide.') },
        ['skills/123/SKILL.md: ', 'must contain string "name"'],
      ],
      [
        'name not the directory name',
        { 'skills/foo/SKILL.md': conformant('bar') },
        ['skills/foo/SKILL.md: ', 'frontmatter name "bar" must match the last path segment "foo"'],
      ],
      [
        'name over 64 characters',
        { [`skills/${'a'.repeat(65)}/SKILL.md`]: conformant('a'.repeat(65)) },
        [`skills/${'a'.repeat(65)}/SKILL.md: `, 'name', 'must be 1-64 lowercase letters'],
      ],
      [
        'name outside the pattern',
        { 'skills/a--b/SKILL.md': conformant('a--b') },
        [
          'skills/a--b/SKILL.md: ',
          'name "a--b" must be 1-64 lowercase letters, digits and single hyphens',
        ],
      ],
      [
        'description missing',
        { 'skills/x/SKILL.md': skillMd('name: x') },
        ['skills/x/SKILL.md: ', '"description"'],
      ],
      [
        'description empty',
        { 'skills/x/SKILL.md': skillMd('name: x', 'description: ""') },
        ['skills/x/SKILL.md: ', 'description must be 1-1024 characters'],
      ],
      [
        'compatibility empty',
        { 'skills/x/SKILL.md': conformant('x', 'compatibility: ""') },
        ['skills/x/SKILL.md: ', 'compatibility must be a string of 1-500 characters'],
      ],
      [
        'compatibility not a string',
        { 'skills/x/SKILL.md': conformant('x', 'compatibility: 3') },
        ['skills/x/SKILL.md: ', 'compatibility must be a string of 1-500 characters'],
      ],
      [
        'compatibility over 500 characters',
        { 'skills/x/SKILL.md': conformant('x', `compatibility: ${'c'.repeat(501)}`) },
        ['skills/x/SKILL.md: ', 'compatibility must be a string of 1-500 characters'],
      ],
      [
        'an unquoted metadata number',
        { 'skills/x/SKILL.md': conformant('x', 'metadata:', '  version: 1.0') },
        ['skills/x/SKILL.md: ', 'metadata must map strings to strings'],
      ],
      [
        'a multi-line quoted value',
        { 'skills/x/SKILL.md': skillMd('name: x', 'description: "first line', '  second line"') },
        ['skills/x/SKILL.md: ', 'line 3', 'multi-line quoted values are not supported'],
      ],
      [
        'a YAML anchor',
        { 'skills/x/SKILL.md': skillMd('name: &n x', 'description: A guide.') },
        ['skills/x/SKILL.md: ', 'anchors, aliases and tags are not supported'],
      ],
      [
        'a symlink in a skill',
        {
          'skills/x/SKILL.md': conformant('x'),
          'skills/x/references/real.md': '# r\n',
          'skills/x/references/link.md': { symlinkTo: 'real.md' },
        },
        ['skills/x/references/link.md: ', 'symlinks and other special files are not followed'],
      ],
      [
        'a skill over 512 files',
        Object.fromEntries([
          ['skills/x/SKILL.md', conformant('x')],
          ...Array.from({ length: 512 }, (_, i) => [`skills/x/r/${i}.md`, `${i}\n`]),
        ]),
        ['skills/x: ', 'exceeds the limit of 512 files / 16777216 bytes'],
      ],
      [
        'a skill over 16 MiB',
        {
          'skills/x/SKILL.md': conformant('x'),
          'skills/x/references/big.bin': Buffer.alloc(16 * 1024 * 1024),
        },
        ['skills/x: ', 'exceeds the limit of 512 files / 16777216 bytes'],
      ],
      [
        'a SKILL.md directly under skills/',
        { 'skills/SKILL.md': conformant('skills') },
        ['skills/SKILL.md: ', 'a SKILL.md at the root has no skill path'],
      ],
    ])('fails %s, naming the file and field', async (_label, files, fragments) => {
      const errors = await lintSkills(files);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.startsWith(fragments[0] ?? '')).toBe(true);
      for (const fragment of fragments.slice(1)) expect(errors[0]).toContain(fragment);
    });

    it('fails a description over 1024 characters on both the SDK rule and the project budget', async () => {
      const errors = await lintSkills({
        'skills/x/SKILL.md': skillMd('name: x', `description: ${'d'.repeat(1025)}`),
      });
      expect(errors).toEqual([
        expect.stringMatching(/^skills\/x\/SKILL\.md: .*description must be 1-1024 characters/),
        expect.stringMatching(/^skills\/x\/SKILL\.md "description" is 1025 characters/),
      ]);
    });
  });

  describe('project rules', () => {
    /** A description field whose value is `chars` characters long, in each YAML form. */
    const descriptions: [string, (chars: number) => string[]][] = [
      ['a plain value', (chars) => [`description: ${'d'.repeat(chars)}`]],
      ['a quoted value', (chars) => [`description: "${'d'.repeat(chars)}"`]],
      // Folding joins the two lines with a space and clips to one trailing newline.
      [
        'a folded block scalar',
        (chars) => ['description: >', `  ${'d'.repeat(250)}`, `  ${'d'.repeat(chars - 252)}`],
      ],
    ];

    it.each(descriptions)(
      'passes a 500-character description written as %s',
      async (_label, field) => {
        expect(
          await lintSkills({ 'skills/x/SKILL.md': skillMd('name: x', ...field(500)) }),
        ).toEqual([]);
      },
    );

    it.each(descriptions)(
      'fails a 501-character description written as %s',
      async (_label, field) => {
        expect(
          await lintSkills({ 'skills/x/SKILL.md': skillMd('name: x', ...field(501)) }),
        ).toEqual([
          'skills/x/SKILL.md "description" is 501 characters — keep it at 500 or fewer: a host keeps every installed skill\'s description in context for the whole session',
        ]);
      },
    );

    it.each([
      ['a block list', ['allowed-tools:', '  - Bash', '  - Read']],
      ['a flow list', ['allowed-tools: [Bash, Read]']],
      ['a boolean', ['allowed-tools: true']],
    ])('fails allowed-tools written as %s', async (_label, field) => {
      expect(await lintSkills({ 'skills/x/SKILL.md': conformant('x', ...field) })).toEqual([
        'skills/x/SKILL.md "allowed-tools" is not a string — the Agent Skills specification defines it as one space-separated string of tool names',
      ]);
    });

    /** A `SKILL.md` of `lines` newline-terminated lines: the six of `conformant('x')`, then filler. */
    const ofLines = (lines: number) => `${conformant('x')}${'line\n'.repeat(lines - 6)}`;

    it('passes a SKILL.md of 150 lines', async () => {
      expect(ofLines(150).split('\n')).toHaveLength(151);
      expect(await lintSkills({ 'skills/x/SKILL.md': ofLines(150) })).toEqual([]);
    });

    it('fails a SKILL.md over 150 lines', async () => {
      expect(await lintSkills({ 'skills/x/SKILL.md': ofLines(151) })).toEqual([
        'skills/x/SKILL.md is 151 lines — keep it at 150 or fewer and move long material into skills/x/references/',
      ]);
    });

    it('fails a skill folder with no SKILL.md', async () => {
      expect(
        await lintSkills({
          'skills/demo-guide/SKILL.md': conformant('demo-guide'),
          'skills/notes/README.md': '# Notes\n',
        }),
      ).toEqual([
        'skills/notes/ has no SKILL.md — plugin hosts and the MCP server skip a skill folder without one; add skills/notes/SKILL.md or remove the folder',
      ]);
    });

    it('fails a SKILL.md below skills/<name>/', async () => {
      expect(
        await lintSkills({
          'skills/demo-guide/SKILL.md': conformant('demo-guide'),
          'skills/demo-guide/advanced/SKILL.md': conformant('advanced'),
        }),
      ).toEqual([
        'skills/demo-guide/advanced/SKILL.md sits below skills/demo-guide/ — plugin hosts discover only skills/<name>/SKILL.md, while the MCP server serves it as a separate skill; move that skill to skills/advanced/, or rename the file if it is reference material',
      ]);
    });

    it.each(['external', '"external"'])('fails metadata.audience: %s', async (value) => {
      expect(
        await lintSkills({
          'skills/x/SKILL.md': conformant(
            'x',
            'metadata:',
            '  version: "1.0"',
            `  audience: ${value}`,
          ),
        }),
      ).toEqual([
        'skills/x/SKILL.md "metadata.audience" is "external" — the value reserved for framework-managed skills, which init copies and the skills sync tracks by it; remove "audience", which a published skill never carries',
      ]);
    });

    it('reads audience from the frontmatter only, never the body', async () => {
      expect(
        await lintSkills({
          'skills/x/SKILL.md': `${conformant('x')}\n\`\`\`yaml\naudience: external\n\`\`\`\n`,
        }),
      ).toEqual([]);
    });
  });

  describe('.mcpbignore keeps the tree in the bundle', () => {
    const FILES = ['skills/demo-guide/SKILL.md', 'skills/demo-guide/references/ids.md'];

    it('passes the template, which never excludes root skills/', async () => {
      expect(await checkSkillsKeptInBundle(template, FILES)).toEqual([]);
    });

    it.each([
      ['/skills/', 'skills/demo-guide/SKILL.md'],
      ['skills/', 'skills/demo-guide/SKILL.md'],
      ['/skills/*/references/', 'skills/demo-guide/references/ids.md'],
    ])('fails "%s", naming the file it strips', async (pattern, file) => {
      expect(await checkSkillsKeptInBundle(`${template}${pattern}\n`, FILES)).toEqual([
        `.mcpbignore pattern "${pattern}" strips ${file} from the bundle — root skills/ holds the skills this server publishes, which the Claude Directory reads from the bundle; remove the line`,
      ]);
    });

    it('leaves a pattern written against node_modules/ alone', async () => {
      expect(await checkSkillsKeptInBundle(`${template}/node_modules/**/skills/\n`, FILES)).toEqual(
        [],
      );
    });
  });

  describe('standalone run', () => {
    const SCRIPT = join(REPO_ROOT, 'scripts/lint-packaging.ts');
    const PRE_013 = `${template}/skills/\n`;
    const TREE = { 'skills/demo-guide/SKILL.md': conformant('demo-guide') };

    function lint(files: Record<string, TreeEntry>): { code: number; out: string } {
      const cwd = project({
        'package.json': '{"name":"probe-mcp-server","version":"0.1.0"}',
        ...files,
      });
      const result = spawnSync('bun', ['run', SCRIPT], { cwd, encoding: 'utf8' });
      return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
    }

    it('prints nothing about skills and passes without a root skills/', () => {
      const { code, out } = lint({ '.mcpbignore': template });
      expect(out).not.toContain('skills');
      expect(code).toBe(0);
    });

    it('passes an .mcpbignore excluding /skills/ when there is no root skills/', () => {
      const { code, out } = lint({ '.mcpbignore': PRE_013 });
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });

    it('passes a conformant tree beside the template .mcpbignore', () => {
      const { code, out } = lint({ ...TREE, '.mcpbignore': template });
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });

    it('fails an .mcpbignore excluding /skills/ beside the tree', () => {
      const { code, out } = lint({ ...TREE, '.mcpbignore': PRE_013 });
      expect(out).toContain(
        '.mcpbignore pattern "/skills/" strips skills/demo-guide/SKILL.md from the bundle',
      );
      expect(code).toBe(1);
    });

    it('fails a tree the SDK rejects through the linter it imports', () => {
      const { code, out } = lint({ 'skills/foo/SKILL.md': conformant('bar') });
      expect(out).toContain(
        'skills/foo/SKILL.md: frontmatter name "bar" must match the last path segment "foo"',
      );
      expect(code).toBe(1);
    });
  });
});
