/**
 * @fileoverview Tests for `buildServerManifest` and its helpers.
 * @module tests/core/serverManifest.test
 */
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '@/config/index.js';
import {
  buildServerManifest,
  classifyPreRelease,
  deriveSourceUrl,
  deriveTitleFromName,
  detectGitHubRepo,
  GITHUB_REPO_ROOT_PATTERN,
  LANDING_MAX_ENV_EXAMPLE,
  LANDING_MAX_LINKS,
  snakeToKebab,
} from '@/core/serverManifest.js';
import { appTool } from '@/mcp-server/apps/appBuilders.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { disabledTool } from '@/mcp-server/tools/utils/disabled-tool.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';

/**
 * Minimal AppConfig stub — only the fields `buildServerManifest` reads.
 * Cast once so each test can override specific fields.
 */
function stubConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mcpServerName: 'test-server',
    mcpServerVersion: '1.0.0',
    mcpServerDescription: 'A test MCP server',
    mcpServerHomepage: 'https://github.com/acme/test-server',
    environment: 'test',
    mcpTransportType: 'http',
    mcpHttpEndpointPath: '/mcp',
    mcpSessionMode: 'stateless',
    mcpAuthMode: 'none',
    ...overrides,
  } as AppConfig;
}

describe('detectGitHubRepo', () => {
  test('parses a canonical GitHub URL', () => {
    const repo = detectGitHubRepo('https://github.com/cyanheads/mcp-ts-core');
    expect(repo).toEqual({
      url: 'https://github.com/cyanheads/mcp-ts-core',
      owner: 'cyanheads',
      repo: 'mcp-ts-core',
    });
  });

  test('strips trailing slash', () => {
    const repo = detectGitHubRepo('https://github.com/cyanheads/mcp-ts-core/');
    expect(repo?.url).toBe('https://github.com/cyanheads/mcp-ts-core');
  });

  test('returns undefined for non-github URLs', () => {
    expect(detectGitHubRepo('https://gitlab.com/x/y')).toBeUndefined();
    expect(detectGitHubRepo('https://example.com')).toBeUndefined();
  });

  test('returns undefined for URLs with extra path segments', () => {
    expect(detectGitHubRepo('https://github.com/a/b/tree/main')).toBeUndefined();
    expect(detectGitHubRepo('https://github.com/a')).toBeUndefined();
  });

  test('returns undefined for undefined/empty input', () => {
    expect(detectGitHubRepo(undefined)).toBeUndefined();
    expect(detectGitHubRepo('')).toBeUndefined();
  });

  test('validates the public regex', () => {
    expect(GITHUB_REPO_ROOT_PATTERN.test('https://github.com/a/b')).toBe(true);
    expect(GITHUB_REPO_ROOT_PATTERN.test('http://github.com/a/b')).toBe(false);
  });
});

describe('classifyPreRelease', () => {
  test.each([
    ['1.0.0', false, undefined],
    ['1.2.3', false, undefined],
    ['0.1.0', true, 'pre-1.0'],
    ['0.5.4', true, 'pre-1.0'],
    ['1.0.0-alpha', true, 'alpha'],
    ['1.0.0-beta.1', true, 'beta'],
    ['1.0.0-rc.2', true, 'rc'],
    ['2.0.0-alpha.5', true, 'alpha'],
  ])('%s → pre=%s label=%s', (version, expectedPre, expectedLabel) => {
    const result = classifyPreRelease(version);
    expect(result.isPreRelease).toBe(expectedPre);
    expect(result.label).toBe(expectedLabel);
  });
});

describe('deriveTitleFromName', () => {
  test.each([
    ['my_tool', 'My Tool'],
    ['user_create_account', 'User Create Account'],
    ['kebab-case-name', 'Kebab Case Name'],
    ['simple', 'Simple'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(deriveTitleFromName(input)).toBe(expected);
  });
});

describe('snakeToKebab', () => {
  test.each([
    ['my_tool_name', 'my-tool-name'],
    ['simple', 'simple'],
    ['SHOUTING_NAME', 'shouting-name'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(snakeToKebab(input)).toBe(expected);
  });
});

describe('deriveSourceUrl', () => {
  const repo = {
    url: 'https://github.com/acme/demo',
    owner: 'acme',
    repo: 'demo',
  };

  test('builds the canonical tool path', () => {
    const url = deriveSourceUrl(repo, 'tools', 'search_items');
    expect(url).toBe(
      'https://github.com/acme/demo/blob/main/src/mcp-server/tools/definitions/search-items.tool.ts',
    );
  });

  test('builds the canonical resource path', () => {
    const url = deriveSourceUrl(repo, 'resources', 'user_profile');
    expect(url).toBe(
      'https://github.com/acme/demo/blob/main/src/mcp-server/resources/definitions/user-profile.resource.ts',
    );
  });

  test('builds the canonical prompt path', () => {
    const url = deriveSourceUrl(repo, 'prompts', 'code_review');
    expect(url).toBe(
      'https://github.com/acme/demo/blob/main/src/mcp-server/prompts/definitions/code-review.prompt.ts',
    );
  });

  test('returns undefined without a repo', () => {
    expect(deriveSourceUrl(undefined, 'tools', 'x')).toBeUndefined();
  });

  test('returns undefined for empty name', () => {
    expect(deriveSourceUrl(repo, 'tools', '')).toBeUndefined();
  });
});

describe('buildServerManifest — baseline', () => {
  test('produces a manifest with zero definitions', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
    });

    expect(manifest.definitionCounts).toEqual({ tools: 0, resources: 0, prompts: 0 });
    expect(manifest.capabilities).toEqual({
      logging: true,
      tools: false,
      resources: false,
      prompts: false,
    });
    expect(manifest.definitions.tools).toEqual([]);
    expect(manifest.server.name).toBe('test-server');
  });

  test('surfaces server.keywords when configured', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerKeywords: ['health', 'medical', 'epidemiology'] }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.server.keywords).toEqual(['health', 'medical', 'epidemiology']);
  });

  test('omits server.keywords when unset or empty', () => {
    const unset = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(unset.server.keywords).toBeUndefined();

    const empty = buildServerManifest({
      config: stubConfig({ mcpServerKeywords: [] }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(empty.server.keywords).toBeUndefined();
  });

  test('flips capability flags when definitions are present', () => {
    const fakeTool = {
      name: 'my_tool',
      description: 'Does things.',
      input: z.object({ q: z.string().describe('query') }),
      output: z.object({ r: z.string().describe('result') }),
      handler: async () => ({ r: '' }),
    };
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [fakeTool] as Parameters<typeof buildServerManifest>[0]['tools'],
      resources: [],
      prompts: [],
    });

    expect(manifest.capabilities.tools).toBe(true);
    expect(manifest.capabilities.resources).toBe(false);
    expect(manifest.definitions.tools).toHaveLength(1);
    expect(manifest.definitions.tools[0]?.name).toBe('my_tool');
    expect(manifest.definitions.tools[0]?.requiredFields).toEqual(['q']);
    expect(manifest.definitions.tools[0]?.sourceUrl).toMatch(
      /blob\/main\/src\/mcp-server\/tools\/definitions\/my-tool\.tool\.ts$/,
    );
  });

  test('passes disabled metadata through to ManifestTool when wrapped', () => {
    const enabledDef = tool('readable', {
      description: 'Read tool',
      input: z.object({}),
      output: z.object({}),
      handler: () => ({}),
    });
    const disabledDef = disabledTool(
      tool('writable', {
        description: 'Write tool',
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      }),
      {
        reason: 'Writes are turned off in this deployment.',
        hint: 'BRAPI_ENABLE_WRITES=true',
      },
    );

    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [enabledDef, disabledDef] as Parameters<typeof buildServerManifest>[0]['tools'],
      resources: [],
      prompts: [],
    });

    expect(manifest.definitions.tools).toHaveLength(2);
    expect(manifest.definitionCounts.tools).toBe(2);
    const readable = manifest.definitions.tools.find((t) => t.name === 'readable');
    const writable = manifest.definitions.tools.find((t) => t.name === 'writable');
    expect(readable?.disabled).toBeUndefined();
    expect(writable?.disabled).toEqual({
      reason: 'Writes are turned off in this deployment.',
      hint: 'BRAPI_ENABLE_WRITES=true',
    });
  });

  test('marks MCP App tools from UI metadata', () => {
    const dashboard = appTool('dashboard_open', {
      resourceUri: 'ui://dashboard/app.html',
      description: 'Open the dashboard.',
      input: z.object({}),
      output: z.object({}),
      handler: async () => ({}),
    });
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [dashboard],
      resources: [],
      prompts: [],
    });
    expect(manifest.definitions.tools[0]?.isApp).toBe(true);
  });

  test('materializes resource and prompt metadata for landing/server-card surfaces', () => {
    const inventoryResource = resource('inventory://items/{itemId}', {
      name: 'inventory_item',
      title: 'Inventory Item',
      description: 'Retrieve one inventory item.',
      mimeType: 'application/json',
      annotations: { priority: 0.9 },
      auth: ['inventory:read'],
      params: z.object({ itemId: z.string().describe('Item ID') }),
      handler: async () => ({}),
    });
    const reviewPrompt = prompt('code_review', {
      description: 'Review a patch.',
      args: z.object({
        diff: z.string().describe('Patch diff'),
        language: z.string().optional().describe('Programming language'),
      }),
      generate: () => [],
    });

    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [inventoryResource],
      prompts: [reviewPrompt],
    });

    expect(manifest.definitions.resources[0]).toMatchObject({
      name: 'inventory_item',
      title: 'Inventory Item',
      description: 'Retrieve one inventory item.',
      uriTemplate: 'inventory://items/{itemId}',
      mimeType: 'application/json',
      annotations: { priority: 0.9 },
      auth: ['inventory:read'],
    });
    expect(manifest.definitions.prompts[0]).toMatchObject({
      name: 'code_review',
      title: 'Code Review',
      description: 'Review a patch.',
      args: [
        { name: 'diff', required: true, description: 'Patch diff' },
        { name: 'language', required: false, description: 'Programming language' },
      ],
    });
  });
});

describe('buildServerManifest — landing auto-derivation', () => {
  test('detects GitHub repo from mcpServerHomepage', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerHomepage: 'https://github.com/acme/demo' }),
      tools: [],
      resources: [],
      prompts: [],
    });

    expect(manifest.landing.repoRoot).toEqual({
      url: 'https://github.com/acme/demo',
      owner: 'acme',
      repo: 'demo',
    });
    expect(manifest.landing.changelogUrl).toBe(
      'https://github.com/acme/demo/blob/main/CHANGELOG.md',
    );
  });

  test('explicit landing.repoRoot overrides auto-detection', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerHomepage: 'https://example.com/docs' }),
      tools: [],
      resources: [],
      prompts: [],
      landing: { repoRoot: 'https://github.com/alt/repo' },
    });

    expect(manifest.landing.repoRoot?.url).toBe('https://github.com/alt/repo');
  });

  test('landing defaults preserve theme and attribution', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
    });

    expect(manifest.landing.enabled).toBe(true);
    expect(manifest.landing.attribution).toBe(true);
    expect(manifest.landing.requireAuth).toBe(false);
    expect(manifest.landing.theme.accent).toBe('#6366f1');
  });

  test('explicit landing.enabled=false is honored', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      landing: { enabled: false },
    });
    expect(manifest.landing.enabled).toBe(false);
  });

  test('truncates links beyond the maximum', () => {
    const manyLinks = Array.from({ length: 10 }, (_, i) => ({
      href: `https://example.com/${i}`,
      label: `Link ${i}`,
    }));
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      landing: { links: manyLinks },
    });
    expect(manifest.landing.links).toHaveLength(LANDING_MAX_LINKS);
  });

  test('infers `external` for https links', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      landing: {
        links: [
          { href: 'https://external.com', label: 'Ext' },
          { href: '/docs', label: 'Internal' },
        ],
      },
    });
    expect(manifest.landing.links[0]?.external).toBe(true);
    expect(manifest.landing.links[1]?.external).toBe(false);
  });

  test('auto-links scoped npm packages', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerName: '@acme/demo-server' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.landing.npmPackage).toEqual({
      name: '@acme/demo-server',
      url: 'https://www.npmjs.com/package/%40acme%2Fdemo-server',
    });
  });

  test('skips npm linking for unscoped internal-looking names', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerName: 'my-internal-server' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.landing.npmPackage).toBeUndefined();
  });

  test('classifies pre-release from version', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerVersion: '1.0.0-beta.3' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.landing.preRelease.isPreRelease).toBe(true);
    expect(manifest.landing.preRelease.label).toBe('beta');
  });

  test('normalizes env examples by dropping non-strings and truncating at the cap', () => {
    const envExample = {
      BAD_NUMBER: 123,
      ...Object.fromEntries(
        Array.from({ length: LANDING_MAX_ENV_EXAMPLE + 2 }, (_, i) => [`GOOD_${i}`, `value-${i}`]),
      ),
    } as unknown as Record<string, string>;

    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      landing: { envExample },
    });

    expect(manifest.landing.envExample).toHaveLength(LANDING_MAX_ENV_EXAMPLE);
    expect(manifest.landing.envExample).not.toContainEqual({
      key: 'BAD_NUMBER',
      value: 123,
    });
    expect(manifest.landing.envExample[0]).toEqual({
      key: 'GOOD_0',
      value: 'value-0',
    });
  });

  test('keeps only non-empty known connect snippet overrides', () => {
    const connectSnippets = {
      stdio: 'custom stdio',
      http: '',
      claude: 123,
      unknown: 'ignored',
    } as unknown as { claude?: string; curl?: string; http?: string; stdio?: string };

    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      landing: { connectSnippets },
    });

    expect(manifest.landing.connectSnippets).toEqual({ stdio: 'custom stdio' });
  });
});

describe('buildServerManifest — landing requireAuth default (issue #156)', () => {
  test('defaults requireAuth=true when auth mode is jwt', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpAuthMode: 'jwt' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.landing.requireAuth).toBe(true);
  });

  test('defaults requireAuth=true when auth mode is oauth', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpAuthMode: 'oauth' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.landing.requireAuth).toBe(true);
  });

  test('defaults requireAuth=false when auth mode is none', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpAuthMode: 'none' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.landing.requireAuth).toBe(false);
  });

  test('explicit requireAuth=false overrides the auth-enabled default (public catalog)', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpAuthMode: 'jwt' }),
      tools: [],
      resources: [],
      prompts: [],
      landing: { requireAuth: false },
    });
    expect(manifest.landing.requireAuth).toBe(false);
  });

  test('explicit requireAuth=true overrides the none default', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpAuthMode: 'none' }),
      tools: [],
      resources: [],
      prompts: [],
      landing: { requireAuth: true },
    });
    expect(manifest.landing.requireAuth).toBe(true);
  });
});

describe('buildServerManifest — auth reflection', () => {
  test('mode=none emits minimal auth block', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpAuthMode: 'none' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.auth).toEqual({ mode: 'none' });
  });

  test('mode=oauth populates issuer/audience/jwks when present', () => {
    const manifest = buildServerManifest({
      config: stubConfig({
        mcpAuthMode: 'oauth',
        oauthIssuerUrl: 'https://auth.example.com',
        oauthAudience: 'mcp-api',
        oauthJwksUri: 'https://auth.example.com/.well-known/jwks.json',
      } as Partial<AppConfig>),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.auth.mode).toBe('oauth');
    expect(manifest.auth.oauthIssuer).toBe('https://auth.example.com');
    expect(manifest.auth.oauthAudience).toBe('mcp-api');
    expect(manifest.auth.jwksUri).toBe('https://auth.example.com/.well-known/jwks.json');
  });
});

describe('buildServerManifest — server identity fields (#213)', () => {
  test('title surfaces on manifest.server when provided', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      title: 'My Server',
    });
    expect(manifest.server.title).toBe('My Server');
  });

  test('title is absent from manifest.server when not provided', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.server).not.toHaveProperty('title');
  });

  test('websiteUrl surfaces on manifest.server when provided', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      websiteUrl: 'https://github.com/owner/my-server',
    });
    expect(manifest.server.websiteUrl).toBe('https://github.com/owner/my-server');
  });

  test('websiteUrl is absent from manifest.server when not provided', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.server).not.toHaveProperty('websiteUrl');
  });

  test('icons surface on manifest.server when provided', () => {
    const icons = [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }] as const;
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
      icons: [...icons],
    });
    expect(manifest.server.icons).toEqual(icons);
  });

  test('icons are absent from manifest.server when not provided', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.server).not.toHaveProperty('icons');
  });

  test('explicit description option wins over config.mcpServerDescription', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerDescription: 'from config' }),
      tools: [],
      resources: [],
      prompts: [],
      description: 'from option',
    });
    expect(manifest.server.description).toBe('from option');
  });

  test('config.mcpServerDescription is used as fallback when no explicit description', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerDescription: 'from config' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.server.description).toBe('from config');
  });

  test('description is absent when neither explicit option nor config value is set', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerDescription: undefined }),
      tools: [],
      resources: [],
      prompts: [],
    });
    expect(manifest.server).not.toHaveProperty('description');
  });
});

describe('buildServerManifest — per-definition sourceUrl override', () => {
  test('respects sourceUrl override on tool definitions', () => {
    const myTool = tool('my_tool', {
      description: 'x',
      input: z.object({}),
      output: z.object({}),
      handler: async () => ({}),
      sourceUrl: 'https://gitlab.com/custom/tool.ts',
    });
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [myTool],
      resources: [],
      prompts: [],
    });
    expect(manifest.definitions.tools[0]?.sourceUrl).toBe('https://gitlab.com/custom/tool.ts');
  });

  test('respects sourceUrl override on resource definitions', () => {
    const myResource = resource('myscheme://{id}/data', {
      name: 'my_resource',
      description: 'x',
      params: z.object({ id: z.string().describe('id') }),
      handler: async () => ({}),
      sourceUrl: 'https://gitlab.com/custom/resource.ts',
    });
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [myResource],
      prompts: [],
    });
    expect(manifest.definitions.resources[0]?.sourceUrl).toBe(
      'https://gitlab.com/custom/resource.ts',
    );
  });

  test('respects sourceUrl override on prompt definitions', () => {
    const myPrompt = prompt('my_prompt', {
      description: 'x',
      generate: () => [],
      sourceUrl: 'https://gitlab.com/custom/prompt.ts',
    });
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [],
      resources: [],
      prompts: [myPrompt],
    });
    expect(manifest.definitions.prompts[0]?.sourceUrl).toBe('https://gitlab.com/custom/prompt.ts');
  });

  test('falls back to repoRoot-derived URL when override absent', () => {
    const myTool = tool('plain_tool', {
      description: 'x',
      input: z.object({}),
      output: z.object({}),
      handler: async () => ({}),
    });
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerHomepage: 'https://github.com/acme/demo' }),
      tools: [myTool],
      resources: [],
      prompts: [],
    });
    expect(manifest.definitions.tools[0]?.sourceUrl).toBe(
      'https://github.com/acme/demo/blob/main/src/mcp-server/tools/definitions/plain-tool.tool.ts',
    );
  });
});
