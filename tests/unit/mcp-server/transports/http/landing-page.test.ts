/**
 * @fileoverview Tests for the HTML landing page renderer.
 * Covers rendering correctness, the automatic-polish derivations (GitHub link
 * cluster, pre-release pill, auth banner, tool grouping), and safety
 * invariants (escape behavior under adversarial input).
 * @module tests/mcp-server/transports/http/landing-page.test
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfig } from '@/config/index.js';
import type { ManifestTool, ServerManifest } from '@/core/serverManifest.js';
import { buildServerManifest } from '@/core/serverManifest.js';
import {
  createLandingPageHandler,
  renderLandingPage,
} from '@/mcp-server/transports/http/landing-page/index.js';
import { ADVERSARIAL_STRINGS } from '@/testing/fuzz.js';
import { logger } from '@/utils/internal/logger.js';
import { defaultServerManifest } from '../../../../helpers/fixtures.js';

vi.mock('@/utils/internal/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('@/utils/internal/requestContext.js', () => ({
  requestContextService: {
    createRequestContext: vi.fn((x) => ({ requestId: 'test', ...x })),
  },
}));

function stubConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mcpServerName: 'test-server',
    mcpServerVersion: '1.0.0',
    mcpServerDescription: 'A test server',
    environment: 'test',
    mcpTransportType: 'http',
    mcpHttpEndpointPath: '/mcp',
    mcpSessionMode: 'stateless',
    mcpAuthMode: 'none',
    ...overrides,
  } as AppConfig;
}

function makeTool(name: string, extra: Partial<ManifestTool> = {}): ManifestTool {
  return {
    name,
    title: name,
    description: `Description of ${name}`,
    isTask: false,
    isApp: false,
    requiredFields: [],
    ...extra,
  };
}

describe('renderLandingPage — structure', () => {
  test('returns a complete HTML document', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</html>');
  });

  test('includes the server name in the hero', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain('test-mcp-server');
    expect(html).toContain('v1.0.0');
  });

  test('includes the MCP Server Card alternate link', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain('<link rel="alternate"');
    expect(html).toContain('/.well-known/mcp.json');
  });

  test('emits the auth-status banner', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain('Public access');
  });

  test('emits a "Requires OAuth" banner when auth.mode is oauth', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      auth: { mode: 'oauth', oauthIssuer: 'https://auth.example.com' },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('Requires OAuth');
    expect(html).toContain('https://auth.example.com');
  });

  test('renders the connect snippet tabs', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain('connect-tab-http');
    expect(html).toContain('mcp-remote');
    expect(html).toContain('curl');
  });
});

describe('renderLandingPage — connect snippets', () => {
  function manifestWithEnv(): ServerManifest {
    return {
      ...defaultServerManifest,
      landing: {
        ...defaultServerManifest.landing,
        envExample: [
          { key: 'API_KEY', value: 'your-api-key' },
          { key: 'ADMIN_EMAIL', value: 'you@example.com' },
        ],
        npmPackage: {
          name: '@acme/my-server',
          url: 'https://www.npmjs.com/package/@acme/my-server',
        },
      },
    };
  }

  /**
   * Extract a single connect-panel's raw snippet content (pre-escape reversal
   * not needed — we just match on the escaped HTML form).
   */
  function extractSnippet(html: string, panelId: string): string {
    const match = html.match(
      new RegExp(`<pre id="connect-snippet-${panelId}"><code>([\\s\\S]*?)</code></pre>`),
    );
    if (!match) throw new Error(`panel ${panelId} snippet not found`);
    return match[1] ?? '';
  }

  test('stdio config includes env block when envExample is set', () => {
    const html = renderLandingPage(manifestWithEnv(), 'https://example.com');
    const stdio = extractSnippet(html, 'stdio');
    expect(stdio).toContain('API_KEY');
    expect(stdio).toContain('ADMIN_EMAIL');
    expect(stdio).toContain('&quot;env&quot;');
  });

  test('http config omits env block even when envExample is set', () => {
    const html = renderLandingPage(manifestWithEnv(), 'https://example.com');
    const http = extractSnippet(html, 'http');
    expect(http).toContain('&quot;type&quot;: &quot;http&quot;');
    expect(http).toContain('https://example.com/mcp');
    expect(http).not.toContain('API_KEY');
    expect(http).not.toContain('ADMIN_EMAIL');
    expect(http).not.toContain('&quot;env&quot;');
  });

  test('claude command uses http transport pointing at the endpoint', () => {
    const html = renderLandingPage(manifestWithEnv(), 'https://example.com');
    const claude = extractSnippet(html, 'claude');
    expect(claude).toContain('claude mcp add --transport http');
    expect(claude).toContain('https://example.com/mcp');
    expect(claude).not.toContain('--transport stdio');
    expect(claude).not.toContain('--env');
    expect(claude).not.toContain('bunx');
  });

  test('wraps each connect snippet in Cloudflare email_off comments', () => {
    const html = renderLandingPage(manifestWithEnv(), 'https://example.com');
    // One pair per tab (stdio, http, claude, curl) — 4 total.
    const opens = (html.match(/<!--email_off-->/g) ?? []).length;
    const closes = (html.match(/<!--\/email_off-->/g) ?? []).length;
    expect(opens).toBe(4);
    expect(closes).toBe(4);
  });

  test('honors operator-supplied connectSnippets overrides per tab', () => {
    const customStdio = '{"custom":"stdio-shape"}';
    const customClaude = 'custom-claude-cmd --flag value';
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: {
        ...defaultServerManifest.landing,
        connectSnippets: {
          stdio: customStdio,
          claude: customClaude,
        },
      },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    const stdio = extractSnippet(html, 'stdio');
    const claude = extractSnippet(html, 'claude');
    const http = extractSnippet(html, 'http');
    expect(stdio).toContain('custom&quot;:&quot;stdio-shape');
    expect(stdio).not.toContain('bunx');
    expect(claude).toContain('custom-claude-cmd');
    // Unset tab still derives the default.
    expect(http).toContain('&quot;type&quot;: &quot;http&quot;');
  });

  test('claude command uses http transport even for published packages', () => {
    // Published package used to route to stdio with env flags; the landing
    // page is always served over HTTP, so HTTP is the correct target.
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: {
        ...defaultServerManifest.landing,
        npmPackage: {
          name: '@acme/my-server',
          url: 'https://www.npmjs.com/package/@acme/my-server',
        },
      },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    const claude = extractSnippet(html, 'claude');
    expect(claude).toContain(
      'claude mcp add --transport http test-mcp-server https://example.com/mcp',
    );
    expect(claude).not.toContain('bunx');
  });
});

describe('renderLandingPage — polish derivations', () => {
  test('emits GitHub link cluster when repoRoot is set', () => {
    const manifest = buildServerManifest({
      config: stubConfig({
        mcpServerHomepage: 'https://github.com/acme/x',
        mcpServerVersion: '2.5.0',
      }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('https://github.com/acme/x/blob/main/CHANGELOG.md');
    expect(html).toContain('https://github.com/acme/x/issues');
    expect(html).toContain('https://github.com/acme/x/releases/tag/v2.5.0');
  });

  test('status strip surfaces a github repo link near the top', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerHomepage: 'https://github.com/acme/x' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    // status-strip-scoped match: a link to the repo with the owner/repo
    // value alongside the dim 'github' label.
    const strip = html.match(/<div class="status-strip"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(strip).toContain('href="https://github.com/acme/x"');
    expect(strip).toContain('>github<');
    expect(strip).toContain('>acme/x<');
  });

  test('status strip omits the github link when repoRoot is unknown', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerHomepage: undefined }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    const strip = html.match(/<div class="status-strip"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(strip).not.toContain('github');
  });

  test('version badge links to release tag when repo is known', () => {
    const manifest = buildServerManifest({
      config: stubConfig({
        mcpServerHomepage: 'https://github.com/acme/x',
        mcpServerVersion: '1.2.3',
      }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toMatch(
      /<a class="badge-version" href="https:\/\/github\.com\/acme\/x\/releases\/tag\/v1\.2\.3"[^>]*>v1\.2\.3<\/a>/,
    );
  });

  test('renders pre-release pill when version is pre-release', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerVersion: '1.0.0-beta.1' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('badge-pre');
    expect(html).toContain('beta');
  });

  test('does not render pre-release pill for stable versions', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerVersion: '1.0.0' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    // Stylesheet declares `.badge-pre` regardless; assert the class isn't applied to a DOM node.
    expect(html).not.toMatch(/<span class="badge badge-pre"/);
  });

  test('includes npm registry link when scoped package name is provided', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerName: '@acme/demo' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('npmjs.com/package/%40acme%2Fdemo');
  });

  test('renders shields-style framework badge in hero by default', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toMatch(/<div class="hero-badges">/);
    expect(html).toMatch(/<a class="badge-shield"/);
    expect(html).toContain('Built on');
    expect(html).toContain(defaultServerManifest.framework.name);
    expect(html).toContain(
      `npmjs.com/package/${encodeURIComponent(defaultServerManifest.framework.name)}`,
    );
  });

  test('hides framework badge when attribution is disabled', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, attribution: false },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).not.toMatch(/<div class="hero-badges">/);
    expect(html).not.toMatch(/<a class="badge-shield"/);
  });

  test('footer attribution links to both GitHub homepage and npm', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain(defaultServerManifest.framework.homepage);
    expect(html).toContain(
      `npmjs.com/package/${encodeURIComponent(defaultServerManifest.framework.name)}`,
    );
    expect(html).toMatch(/footer-attrib/);
  });

  test('emits section count in headers', () => {
    const tools = [makeTool('a_one'), makeTool('a_two'), makeTool('a_three')];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('Tools');
    expect(html).toMatch(/<span class="section-count"[^>]*>3</);
  });

  test('groups tools by mutability when multiple buckets are populated', () => {
    const tools = [
      makeTool('list_items', { annotations: { readOnlyHint: true } }),
      makeTool('search_items', { annotations: { readOnlyHint: true } }),
      // Deliberate `write` claim — `readOnlyHint: false` is required now that
      // unannotated tools bucket as `unspecified` instead of falling back to
      // `write`.
      makeTool('create_item', { annotations: { readOnlyHint: false } }),
      makeTool('delete_item', { annotations: { destructiveHint: true } }),
    ];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('data-group="read"');
    expect(html).toContain('data-group="write"');
    expect(html).toContain('data-group="destructive"');
    // Cards carry their bucket as a data attribute for client-side filtering.
    expect(html).toContain('data-mutability="read"');
    expect(html).toContain('data-mutability="write"');
    expect(html).toContain('data-mutability="destructive"');
  });

  test('omits group headings when only one mutability bucket is populated', () => {
    const tools = [makeTool('a'), makeTool('b'), makeTool('c')];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).not.toMatch(/<h4 class="group-heading"/);
    // Cards still carry data-mutability so filtering works in the rare case
    // a server has 13 unspecified-bucket tools — but the heading is suppressed.
    expect(html).toContain('data-mutability="unspecified"');
  });

  test('renders the tool filter bar with a chip per populated bucket', () => {
    const tools = [
      makeTool('safe_one', { annotations: { readOnlyHint: true } }),
      // Explicit `readOnlyHint: false` — unannotated tools now bucket as
      // `unspecified`, so a deliberate `write` claim is required to populate
      // the write filter chip.
      makeTool('mut_one', { annotations: { readOnlyHint: false } }),
      makeTool('boom', { annotations: { destructiveHint: true } }),
    ];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('class="tool-filter-bar"');
    expect(html).toContain('data-filter-mutability="all"');
    expect(html).toContain('data-filter-mutability="read"');
    expect(html).toContain('data-filter-mutability="write"');
    expect(html).toContain('data-filter-mutability="destructive"');
    expect(html).toContain('data-tool-search');
    expect(html).toContain('aria-pressed="true"');
  });

  test('search target indexes name and description for client-side filtering', () => {
    const tool = makeTool('FetchUser', { description: 'Look up a user by Email' });
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    // Lower-cased, whitespace-collapsed search index — the filter script
    // does an indexOf against this attribute, so casing must be normalized
    // here at render time.
    expect(html).toMatch(/data-search="fetchuser look up a user by email"/);
  });

  test('renders an unspecified bucket alongside the safety-coded buckets', () => {
    const tools = [
      makeTool('list_items', { annotations: { readOnlyHint: true } }),
      // No annotations — should bucket as `unspecified`.
      makeTool('connect'),
      makeTool('mutate', { annotations: { readOnlyHint: false } }),
      makeTool('delete_item', { annotations: { destructiveHint: true } }),
    ];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    const body = html.replace(/<style>[\s\S]*?<\/style>/g, '');

    // Group heading + filter chip + card data attribute all render the new
    // bucket consistently.
    expect(body).toContain('data-group="unspecified"');
    expect(body).toContain('data-filter-mutability="unspecified"');
    expect(body).toContain('data-mutability="unspecified"');

    // The unspecified card carries the muted pill variant.
    expect(body).toContain('pill-unspecified');
  });

  test('renders a disabled bucket with the operator-facing reason and hint', () => {
    const tools = [
      makeTool('list_items', { annotations: { readOnlyHint: true } }),
      makeTool('submit_observations', {
        // Deliberate write claim — the "would be write" companion pill on
        // disabled cards depends on the underlying classification being a
        // declared bucket (not `unspecified`).
        annotations: { readOnlyHint: false },
        disabled: {
          reason: 'Writes are turned off in this deployment.',
          hint: 'BRAPI_ENABLE_WRITES=true',
        },
      }),
    ];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');

    // Bucket markers and chip
    expect(html).toContain('data-mutability="disabled"');
    expect(html).toContain('data-filter-mutability="disabled"');
    expect(html).toContain('data-group="disabled"');

    // Card variant + callout content
    expect(html).toContain('tool-card--disabled');
    expect(html).toContain('Writes are turned off in this deployment.');
    expect(html).toContain('BRAPI_ENABLE_WRITES=true');

    // Companion "would be write" pill surfaces the underlying mutability so
    // operators understand what flavor of tool is gated. Suppressed when the
    // underlying classification is `unspecified` (no signal worth surfacing).
    expect(html).toContain('would be write');

    // Disabled cards omit the invocation snippet but keep the schema preview
    // available so operators see the contract the tool would expose.
    const submitCardSlice = html.slice(
      html.indexOf('data-name="submit_observations"'),
      html.indexOf('</article>', html.indexOf('data-name="submit_observations"')),
    );
    expect(submitCardSlice).not.toContain('<summary>invocation</summary>');
  });

  test('renders extensions section when extensions present', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      extensions: { 'vendor/widget': { mode: 'advanced' } },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('Extensions');
    expect(html).toContain('vendor/widget');
  });

  test('omits extensions section when none present', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).not.toContain('section-extensions');
  });

  test('renders tool invocation snippet with required fields', () => {
    const tool = makeTool('my_action', { requiredFields: ['target', 'mode'] });
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    // JSON interpolated through html`` is HTML-escaped — `"` becomes `&quot;`.
    expect(html).toContain('&quot;method&quot;: &quot;tools/call&quot;');
    expect(html).toContain('&quot;name&quot;: &quot;my_action&quot;');
    expect(html).toContain('&quot;target&quot;: &quot;&lt;target&gt;&quot;');
    expect(html).toContain('&quot;mode&quot;: &quot;&lt;mode&gt;&quot;');
  });

  test('renders per-tool source link when sourceUrl set', () => {
    const tool = makeTool('x', { sourceUrl: 'https://github.com/acme/x/blob/main/tool.ts' });
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('view source');
    expect(html).toContain('https://github.com/acme/x/blob/main/tool.ts');
  });

  test('omits view-source link when sourceUrl absent', () => {
    const tool = makeTool('x');
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).not.toContain('view source');
  });

  test('renders mutability badge + auxiliary pills (openWorld / task / app)', () => {
    const tools = [
      makeTool('read_tool', { annotations: { readOnlyHint: true } }),
      makeTool('write_tool'),
      makeTool('destroy_tool', { annotations: { destructiveHint: true } }),
      makeTool('search_tool', {
        annotations: { readOnlyHint: true, openWorldHint: true },
      }),
      makeTool('long_task', { isTask: true }),
      makeTool('ui_tool', { isApp: true }),
    ];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('pill-read');
    expect(html).toContain('pill-write');
    expect(html).toContain('pill-destructive');
    expect(html).toContain('pill-openworld');
    expect(html).toContain('pill-task');
    expect(html).toContain('pill-app');
  });

  test('annotation-less tools bucket as unspecified rather than write or destructive', () => {
    // The renderer surfaces only what the author actually declared. With no
    // mutability annotations on the tool, the bucket is `unspecified` — not
    // `write` (which would falsely claim mutation) and not `destructive`
    // (which would invent the spec default).
    const tools = [makeTool('ambiguous_tool')];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    // Inspect rendered card markup only — the inline stylesheet contains
    // the same attribute selectors for the spine colors, which would
    // false-positive a whole-document substring match.
    const body = html.replace(/<style>[\s\S]*?<\/style>/g, '');
    expect(body).toContain('data-mutability="unspecified"');
    expect(body).not.toContain('data-mutability="write"');
    expect(body).not.toContain('data-mutability="destructive"');
  });

  test('classifies by declared annotation: readOnlyHint:false buckets as write, not unspecified', () => {
    // `readOnlyHint: false` is a deliberate mutation claim — this is the
    // signal that distinguishes a real write tool from one whose author
    // simply hasn't declared mutability either way.
    const tools = [makeTool('explicit_write', { annotations: { readOnlyHint: false } })];
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    const body = html.replace(/<style>[\s\S]*?<\/style>/g, '');
    expect(body).toContain('data-mutability="write"');
    expect(body).not.toContain('data-mutability="unspecified"');
  });

  test('scope chips render the access level only (not the full scope string)', () => {
    const tool = makeTool('x', { auth: ['tool:x:read', 'tool:x:write'] });
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('class="scope-chip">read</code>');
    expect(html).toContain('class="scope-chip">write</code>');
    // The full scope string still surfaces via the title attribute (hover).
    expect(html).toContain('title="tool:x:read, tool:x:write"');
  });
});

describe('renderLandingPage — degraded mode', () => {
  test('renders reduced body when degraded=true', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: {
        tools: [makeTool('hidden_tool')],
        resources: [],
        prompts: [],
      },
    };
    const html = renderLandingPage(manifest, 'https://example.com', true);
    expect(html).not.toContain('hidden_tool');
    expect(html).toContain('authenticated');
  });
});

describe('createLandingPageHandler — HTTP behavior', () => {
  test('serves HTML with proper headers (public mode)', async () => {
    const app = new Hono();
    app.get('/', createLandingPageHandler(defaultServerManifest));
    const response = await app.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('vary')).toBeNull();
  });

  test('emits private Cache-Control + Vary when requireAuth is set', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, requireAuth: true },
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest));
    const response = await app.fetch(new Request('https://example.com/'));
    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
    expect(response.headers.get('vary')).toBe('Authorization');
  });

  test('serves full body only when bearer token validates', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, requireAuth: true },
      definitions: {
        tools: [makeTool('hidden_tool')],
        resources: [],
        prompts: [],
      },
    };
    const authStrategy = {
      verify: vi.fn(async (token: string) => {
        if (token !== 'valid-token') throw new Error('invalid token');
        return { clientId: 'c', scopes: [], subject: 's' } as any;
      }),
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest, authStrategy));

    const response = await app.fetch(
      new Request('https://example.com/', {
        headers: { Authorization: 'Bearer valid-token' },
      }),
    );
    const body = await response.text();
    expect(body).toContain('tool-hidden_tool');
    expect(authStrategy.verify).toHaveBeenCalledWith('valid-token');
  });

  test('serves degraded body when bearer token fails verification', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, requireAuth: true },
      definitions: {
        tools: [makeTool('hidden_tool')],
        resources: [],
        prompts: [],
      },
    };
    const authStrategy = {
      verify: vi.fn(async () => {
        throw new Error('invalid token');
      }),
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest, authStrategy));

    const response = await app.fetch(
      new Request('https://example.com/', {
        headers: { Authorization: 'Bearer anything' },
      }),
    );
    const body = await response.text();
    expect(body).not.toContain('tool-hidden_tool');
    expect(body).not.toContain('Description of hidden_tool');
  });

  test('serves degraded body to unauthenticated callers when gated', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, requireAuth: true },
      definitions: {
        tools: [makeTool('hidden_tool')],
        resources: [],
        prompts: [],
      },
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest));
    const response = await app.fetch(new Request('https://example.com/'));
    const body = await response.text();
    // The tool's card anchor shouldn't render when degraded.
    expect(body).not.toContain('tool-hidden_tool');
    expect(body).not.toContain('Description of hidden_tool');
  });

  test('serves degraded body for everyone when requireAuth is set but no auth strategy is configured', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, requireAuth: true },
      definitions: {
        tools: [makeTool('hidden_tool')],
        resources: [],
        prompts: [],
      },
    };
    const app = new Hono();
    // No auth strategy passed — header-presence alone must not unlock.
    app.get('/', createLandingPageHandler(manifest));
    const response = await app.fetch(
      new Request('https://example.com/', {
        headers: { Authorization: 'Bearer any-token-here' },
      }),
    );
    const body = await response.text();
    expect(body).not.toContain('tool-hidden_tool');
    expect(body).not.toContain('Description of hidden_tool');
  });

  test('uses manifest.transport.publicUrl when set (proxied deployment)', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      transport: {
        ...defaultServerManifest.transport,
        publicUrl: 'https://mcp.example.com',
      },
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest));

    // Inbound request arrives over http (simulating proxy → container hop)
    const response = await app.fetch(new Request('http://internal.container/'));
    const body = await response.text();

    expect(body).toContain('https://mcp.example.com/mcp');
    expect(body).not.toContain('http://internal.container');
  });
});

describe('renderLandingPage — safety', () => {
  test('escapes adversarial strings in server name', () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      server: { ...defaultServerManifest.server, name: '<script>alert(1)</script>' },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes adversarial strings in tool descriptions', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const tool = makeTool('x', { description: evil });
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  test.each(ADVERSARIAL_STRINGS)('survives adversarial string: %s', (evil) => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      server: { ...defaultServerManifest.server, name: evil, description: evil },
      landing: { ...defaultServerManifest.landing, tagline: evil },
      definitions: {
        tools: [makeTool(evil || 'x', { description: evil })],
        resources: [],
        prompts: [],
      },
    };
    const html = renderLandingPage(manifest, 'https://example.com');

    // Strip our own legitimate scripts (copy helper + JSON-LD block); those
    // are known-safe and contain `<script>` by design.
    const scrubbed = html
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '');

    // After scrubbing, no further `<script` element may exist.
    expect(scrubbed).not.toMatch(/<script[\s>]/i);

    // When the adversarial payload contains `<`, it must be escaped in the
    // rendered output — no literal `<script` or `<img` injection.
    if (/<(script|img|iframe|svg|object|embed)/i.test(evil)) {
      expect(scrubbed).not.toMatch(/<(script|img|iframe|svg|object|embed)[\s>]/i);
    }

    // Document structure is preserved.
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  test('sanitizes CSS-injection accent via renderTokens fallback', () => {
    // Direct ServerManifest construction bypasses buildServerManifest's
    // validation, so renderTokens is the last line of defense. Expect the
    // malicious payload to be fully dropped and the default indigo accent
    // used instead.
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: {
        ...defaultServerManifest.landing,
        theme: { accent: `red; } body { background: red; /* attack */` },
      },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    // Check inside the <style> block only — the raw payload still appears
    // (escaped) inside `<meta name="theme-color" content="...">` as a
    // stringly-attribute, which is safe but would false-positive a naive
    // substring match against the whole document.
    const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(styleBlock).not.toContain('red; } body');
    expect(styleBlock).not.toContain('/* attack */');
    expect(styleBlock).not.toContain('background: red');
    // Fallback accent (indigo-500) is used instead.
    expect(styleBlock).toContain('--accent: #6366f1;');
  });
});

describe('renderLandingPage — tool schema preview and args', () => {
  test('renders input schema in a collapsible details element', () => {
    const tool = makeTool('t', {
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    });
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      definitions: { ...defaultServerManifest.definitions, tools: [tool] },
    };
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toContain('<details class="card-detail">');
    expect(html).toContain('<summary>schema</summary>');
  });

  test('preserves built schema data through Zod → JSON Schema path', () => {
    const manifest = buildServerManifest({
      config: stubConfig(),
      tools: [
        {
          name: 'my_tool',
          description: 'x',
          input: z.object({
            q: z.string().describe('query'),
            limit: z.number().optional(),
          }),
          output: z.object({ r: z.string() }),
          handler: async () => ({ r: '' }),
        },
      ] as Parameters<typeof buildServerManifest>[0]['tools'],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    // `"q"` → `&quot;q&quot;` after HTML-escaping through html``.
    expect(html).toContain('&quot;q&quot;');
    expect(html).toContain('&quot;limit&quot;');
  });
});

describe('buildServerManifest — accent validation', () => {
  const baseInput = () => ({
    config: stubConfig(),
    tools: [],
    resources: [],
    prompts: [],
  });

  test.each([
    ['hex (short)', '#fff'],
    ['hex (long)', '#6366f1'],
    ['hex with alpha', '#6366f1cc'],
    ['named color', 'indigo'],
    ['rgb()', 'rgb(99, 102, 241)'],
    ['rgb() with spaces', 'rgb(99 102 241)'],
    ['hsl() with slash-alpha', 'hsl(180 50% 50% / 0.5)'],
    ['oklch()', 'oklch(0.7 0.2 140)'],
    ['oklab()', 'oklab(0.7 0.1 0.1)'],
    ['currentcolor', 'currentcolor'],
  ])('accepts %s: %s', (_label, accent) => {
    expect(() =>
      buildServerManifest({
        ...baseInput(),
        landing: { theme: { accent } },
      }),
    ).not.toThrow();
  });

  test.each([
    ['semicolon breakout', 'red; background: url(x)'],
    ['brace injection', 'red) } body { color: red'],
    ['angle brackets', '<script>alert(1)</script>'],
    ['block comment open', 'red /* attack'],
    ['block comment close', 'red */ x'],
    ['backslash escape', 'red\\00003b'],
    ['leading digit', '123'],
    ['leading at-rule', '@import url(x)'],
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])('rejects %s: %s', (_label, accent) => {
    expect(() =>
      buildServerManifest({
        ...baseInput(),
        landing: { theme: { accent } },
      }),
    ).toThrow(/landing\.theme\.accent/);
  });

  test('exceeds length cap (>128) is rejected', () => {
    const long = `#${'a'.repeat(200)}`;
    expect(() =>
      buildServerManifest({
        ...baseInput(),
        landing: { theme: { accent: long } },
      }),
    ).toThrow(/landing\.theme\.accent/);
  });
});

describe('createLandingPageHandler — security headers', () => {
  test('sets a strict Content-Security-Policy', async () => {
    const app = new Hono();
    app.get('/', createLandingPageHandler(defaultServerManifest));
    const response = await app.fetch(new Request('https://example.com/'));
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test('CSP is present on degraded responses too', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      landing: { ...defaultServerManifest.landing, requireAuth: true },
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest));
    const response = await app.fetch(new Request('https://example.com/'));
    expect(response.headers.get('content-security-policy')).toBeTruthy();
  });
});

describe('createLandingPageHandler — memoization when publicUrl is set', () => {
  beforeEach(() => {
    vi.mocked(logger.debug).mockClear();
  });

  test('reuses precomputed HTML across requests', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      transport: {
        ...defaultServerManifest.transport,
        publicUrl: 'https://mcp.example.com',
      },
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest));

    const [r1, r2] = await Promise.all([
      app.fetch(new Request('https://mcp.example.com/')),
      app.fetch(new Request('http://whatever.internal/')),
    ]);
    const [b1, b2] = await Promise.all([r1.text(), r2.text()]);

    expect(b1).toBe(b2);
    expect(b1).toContain('https://mcp.example.com/mcp');
    // Debug log records that the cache path was taken.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cached: true }),
    );
  });

  test('renders per-request when publicUrl is unset', async () => {
    // defaultServerManifest.transport has no publicUrl, so no override needed.
    const app = new Hono();
    app.get('/', createLandingPageHandler(defaultServerManifest));
    await app.fetch(new Request('https://example.com/'));
    expect(logger.debug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cached: false }),
    );
  });

  test('precomputed degraded body still omits tool inventory', async () => {
    const manifest: ServerManifest = {
      ...defaultServerManifest,
      transport: {
        ...defaultServerManifest.transport,
        publicUrl: 'https://mcp.example.com',
      },
      landing: { ...defaultServerManifest.landing, requireAuth: true },
      definitions: {
        tools: [makeTool('hidden_tool')],
        resources: [],
        prompts: [],
      },
    };
    const app = new Hono();
    app.get('/', createLandingPageHandler(manifest));
    const response = await app.fetch(new Request('https://mcp.example.com/'));
    const body = await response.text();
    expect(body).not.toContain('hidden_tool');
    expect(body).toContain('authenticated');
  });
});

describe('renderLandingPage — accessibility hygiene', () => {
  test('status strip does not use role="status" (not a live region)', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain('class="status-strip"');
    expect(html).not.toMatch(/class="status-strip"[^>]*role="status"/);
  });

  test('connect tabs do not advertise a partial ARIA tab pattern', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('role="tabpanel"');
  });
});

describe('renderLandingPage — warn-token extraction', () => {
  test('exposes --warn family in :root tokens', () => {
    const html = renderLandingPage(defaultServerManifest, 'https://example.com');
    expect(html).toContain('--warn:');
    expect(html).toContain('--warn-text:');
    expect(html).toContain('--warn-bg:');
    expect(html).toContain('--warn-edge:');
  });

  test('pre-release badge resolves through --warn-* vars, not raw hex', () => {
    const manifest = buildServerManifest({
      config: stubConfig({ mcpServerVersion: '1.0.0-beta.1' }),
      tools: [],
      resources: [],
      prompts: [],
    });
    const html = renderLandingPage(manifest, 'https://example.com');
    expect(html).toMatch(/\.badge-pre\s*\{[\s\S]*?color:\s*var\(--warn-text\)/);
    expect(html).toMatch(/\.badge-pre\s*\{[\s\S]*?background:\s*var\(--warn-bg\)/);
    expect(html).toMatch(/\.badge-pre\s*\{[\s\S]*?border:\s*1px\s+solid\s+var\(--warn-edge\)/);
    // The old hardcoded amber hex should no longer appear in the .badge-pre block.
    expect(html).not.toMatch(/\.badge-pre\s*\{[\s\S]*?color:\s*#b45309/);
  });
});
