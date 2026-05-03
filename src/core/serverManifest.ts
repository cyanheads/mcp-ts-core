/**
 * @fileoverview Server manifest — the single source of truth consumed by the
 * HTTP transport's three surfaces: the bespoke `/mcp` status JSON, the
 * SEP-1649 Server Card at `/.well-known/mcp.json`, and the HTML landing page
 * at `/`. `buildServerManifest()` is a pure function: feed it config + the
 * definition arrays that were already passed to `createApp()` and it produces
 * everything the surfaces need to render without re-reading registries or
 * inspecting Zod schemas a second time.
 *
 * Landing-page content limits (tagline/logo/links/repoRoot shape) are
 * enforced at build time here and surfaced through the definition linter —
 * surprising input fails loudly at startup instead of quietly at render.
 * @module src/core/serverManifest
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape } from 'zod';
import { toJSONSchema } from 'zod/v4/core';

import type { AppConfig } from '@/config/index.js';
import { FRAMEWORK_NAME, FRAMEWORK_VERSION } from '@/config/index.js';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import type { AnyToolDef } from '@/mcp-server/tools/tool-registration.js';
import {
  type DisabledMetadata,
  getDisabledMetadata,
} from '@/mcp-server/tools/utils/disabled-tool.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { configurationError } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Public config surface (accepted by createApp({ landing }))
// ---------------------------------------------------------------------------

/** Entry in `landing.links` — rendered in the footer link cluster. */
export interface LandingLink {
  /** When true, opens with `target="_blank" rel="noopener noreferrer"`. */
  external?: boolean;
  /** Absolute URL or same-origin path. */
  href: string;
  /** Visible label. */
  label: string;
}

/** Tab IDs for the connect card; each may have a derived snippet or operator override. */
export const CONNECT_SNIPPET_TABS = ['stdio', 'http', 'claude', 'curl'] as const;
export type ConnectSnippetTab = (typeof CONNECT_SNIPPET_TABS)[number];

/** Consumer-supplied landing page configuration. */
export interface LandingConfig {
  /** When true (default), footer shows "Built on @cyanheads/mcp-ts-core". */
  attribution?: boolean;
  /**
   * Full URL to the changelog. Defaults to `${repoRoot}/blob/main/CHANGELOG.md`
   * when `repoRoot` is known. Override for projects with a non-standard location.
   */
  changelogUrl?: string;
  /**
   * Per-tab override for the connect card's snippets. When a tab's value is
   * set, the renderer uses it verbatim and skips derivation for that tab;
   * unset tabs fall back to the derived default. Use to express client
   * shapes the derivation doesn't produce (custom `env` merging, Docker /
   * in-process launchers, alternate commands).
   *
   * @example
   * ```ts
   * connectSnippets: {
   *   stdio: JSON.stringify({
   *     mcpServers: {
   *       'my-server': {
   *         command: 'docker',
   *         args: ['run', '-i', '--rm', '-e', 'MY_KEY', 'my/image'],
   *         env: { MY_KEY: 'your-key' },
   *       },
   *     },
   *   }, null, 2),
   * }
   * ```
   */
  connectSnippets?: Partial<Record<ConnectSnippetTab, string>>;
  /** Default: true when HTTP transport is active. */
  enabled?: boolean;
  /**
   * Example env vars to surface in the connect snippets (STDIO JSON config +
   * Claude CLI `--env` flags). Values are placeholders shown to the user;
   * never put real secrets here — the config renders verbatim in the page
   * HTML. Max 12 entries.
   *
   * @example
   * ```ts
   * envExample: {
   *   MAILCHIMP_API_KEY: 'your-api-key',
   *   MAILCHIMP_SERVER_PREFIX: 'us1',
   * }
   * ```
   */
  envExample?: Record<string, string>;
  /** Footer link cluster. Max 6 entries. */
  links?: LandingLink[];
  /** Data URI (`data:image/...`) or same-origin path. ≤24KB when data URI. */
  logo?: string;
  /**
   * Canonical GitHub repository root, e.g. `https://github.com/owner/repo`.
   * Unlocks per-definition "view source" links, release linking on the
   * version badge, and the GitHub footer cluster (changelog, issues, source).
   * Auto-derived from `mcpServerHomepage` when that URL matches the pattern.
   */
  repoRoot?: string;
  /** When true, unauthenticated callers receive a reduced landing body. */
  requireAuth?: boolean;
  /** One-line tagline under the server name. ≤120 chars. */
  tagline?: string;
  /** Brand accent color (any CSS color); hover/active pairs derived via `color-mix()`. */
  theme?: { accent?: string };
}

// ---------------------------------------------------------------------------
// Content limits (enforced by the linter)
// ---------------------------------------------------------------------------

/** Max tagline length. Longer strings break the hero layout. */
export const LANDING_MAX_TAGLINE_LENGTH = 120;
/** Max logo size when supplied as a data URI (bytes). */
export const LANDING_MAX_LOGO_BYTES = 24 * 1024;
/** Max footer link count. Beyond this the cluster wraps unreadably. */
export const LANDING_MAX_LINKS = 6;
/** Max `envExample` entries. Beyond this the connect card grows awkwardly tall. */
export const LANDING_MAX_ENV_EXAMPLE = 12;
/** `repoRoot` must match `https://github.com/{owner}/{repo}` with no trailing path. */
export const GITHUB_REPO_ROOT_PATTERN = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)\/?$/;
/** Max length for `landing.theme.accent`. Anything longer is almost certainly an injection attempt. */
export const LANDING_ACCENT_MAX_LENGTH = 128;

/**
 * Reject CSS values that could escape the custom-property declaration context
 * (`--accent: ${value};`). The renderer HTML-escapes the value, but that's the
 * wrong escape for a CSS context — `;`, `{`, `}`, comment markers, and
 * backslash escapes all survive HTML escaping and can break out. This is the
 * real defense; it's a content shape check, not a full CSS color parser, so
 * new color spaces (`oklch`, `color-mix`, future additions) pass through
 * without regex churn.
 */
export function isSafeCssColor(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > LANDING_ACCENT_MAX_LENGTH) return false;
  if (/[;{}\\<>]/.test(trimmed)) return false;
  if (trimmed.includes('/*') || trimmed.includes('*/')) return false;
  return /^[#a-zA-Z]/.test(trimmed);
}

// ---------------------------------------------------------------------------
// Manifest shape (the thing consumed by `/mcp`, Server Card, landing page)
// ---------------------------------------------------------------------------

export interface ManifestServer {
  description?: string;
  environment: string;
  homepage?: string;
  name: string;
  version: string;
}

export interface ManifestTransport {
  endpointPath: string;
  /**
   * Public-facing origin override (from `MCP_PUBLIC_URL`). When set, the
   * landing page and Server Card render this as the base URL instead of
   * deriving it from the inbound request — required behind TLS-terminating
   * reverse proxies where the container sees `http://` but users reach it
   * over `https://`.
   */
  publicUrl?: string;
  sessionMode: string;
  type: 'http' | 'stdio';
}

export interface ManifestProtocol {
  latestVersion: string;
  supportedVersions: readonly string[];
}

export interface ManifestCapabilities {
  logging: boolean;
  prompts: boolean;
  resources: boolean;
  tools: boolean;
}

export interface ManifestAuth {
  /** JWKS URI, when configured. */
  jwksUri?: string;
  mode: 'none' | 'jwt' | 'oauth';
  /** OAuth audience, when mode = 'oauth'. */
  oauthAudience?: string;
  /** OAuth issuer URL, when mode = 'oauth'. */
  oauthIssuer?: string;
  /** Resource identifier for RFC 9728 discovery. */
  resourceIdentifier?: string;
}

export interface ManifestFramework {
  homepage: string;
  name: string;
  version: string;
}

/** Detected GitHub repository. */
export interface GitHubRepo {
  owner: string;
  repo: string;
  url: string;
}

/** Pre-release classification derived from semver. */
export interface PreReleaseInfo {
  isPreRelease: boolean;
  /** `beta`, `rc`, `alpha`, `pre-1.0`, or undefined when stable. */
  label?: 'alpha' | 'beta' | 'rc' | 'pre-1.0';
}

export interface DefinitionCounts {
  prompts: number;
  resources: number;
  tools: number;
}

export interface ManifestTool {
  annotations?: Record<string, unknown>;
  /** Auth scopes required by the tool, if any. */
  auth?: string[];
  description: string;
  /**
   * Present when the definition was wrapped with `disabledTool()` — the tool
   * is in the manifest but skipped during MCP server registration. Renderers
   * surface a muted card with the operator-facing reason and optional hint;
   * discovery agents reading the Server Card should treat the tool as
   * present-but-uncallable.
   */
  disabled?: DisabledMetadata;
  /** JSON Schema for the input (when Zod → JSON Schema succeeds). */
  inputSchema?: unknown;
  /** True when `_meta.ui.resourceUri` is set (MCP Apps). */
  isApp: boolean;
  /** True when `task: true` on the definition. */
  isTask: boolean;
  name: string;
  /** JSON Schema for the output (when Zod → JSON Schema succeeds). */
  outputSchema?: unknown;
  /** Required field names from the input schema — used for invocation snippets. */
  requiredFields: string[];
  /** View-source URL; auto-derived from `landing.repoRoot` or per-definition override. */
  sourceUrl?: string;
  title: string;
}

export interface ManifestResource {
  annotations?: Record<string, unknown>;
  auth?: string[];
  description: string;
  mimeType?: string;
  name: string;
  sourceUrl?: string;
  title: string;
  uriTemplate: string;
}

export interface ManifestPromptArg {
  description?: string;
  name: string;
  required: boolean;
}

export interface ManifestPrompt {
  args: ManifestPromptArg[];
  description: string;
  name: string;
  sourceUrl?: string;
  title: string;
}

export interface ManifestDefinitions {
  prompts: ManifestPrompt[];
  resources: ManifestResource[];
  tools: ManifestTool[];
}

/** Derived landing state — what the renderer actually consumes. */
export interface ManifestLanding {
  attribution: boolean;
  changelogUrl?: string;
  /** Operator-supplied per-tab connect snippet overrides; empty object when unset. */
  connectSnippets: Partial<Record<ConnectSnippetTab, string>>;
  enabled: boolean;
  /** Ordered key/value pairs for the STDIO env block and Claude CLI `--env` flags. */
  envExample: Array<{ key: string; value: string }>;
  links: Array<Required<Pick<LandingLink, 'href' | 'label' | 'external'>>>;
  logo?: string;
  /** Registry / scoped npm package auto-link, when derivable. */
  npmPackage?: { name: string; url: string };
  /** Pre-release classification for version badge. */
  preRelease: PreReleaseInfo;
  repoRoot?: GitHubRepo;
  requireAuth: boolean;
  tagline?: string;
  theme: { accent: string };
}

/**
 * Full server manifest — the single source of truth for every HTTP surface.
 * Built once at startup, passed to the transport, consumed by `/mcp`,
 * `/.well-known/mcp.json`, and `/`.
 */
export interface ServerManifest {
  auth: ManifestAuth;
  /** Timestamp the manifest was built (ISO 8601). Informational only. */
  builtAt: string;
  capabilities: ManifestCapabilities;
  definitionCounts: DefinitionCounts;
  definitions: ManifestDefinitions;
  extensions?: Record<string, object>;
  framework: ManifestFramework;
  landing: ManifestLanding;
  protocol: ManifestProtocol;
  server: ManifestServer;
  transport: ManifestTransport;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRE_RELEASE_PATTERNS: Array<[RegExp, NonNullable<PreReleaseInfo['label']>]> = [
  [/-alpha/i, 'alpha'],
  [/-beta/i, 'beta'],
  [/-rc/i, 'rc'],
];

/** Classifies a semver string — anything pre-1.0 or with a `-tag` is a pre-release. */
export function classifyPreRelease(version: string): PreReleaseInfo {
  for (const [pattern, label] of PRE_RELEASE_PATTERNS) {
    if (pattern.test(version)) return { isPreRelease: true, label };
  }
  // `0.x.y` signals unstable per semver convention
  if (/^0\./.test(version)) return { isPreRelease: true, label: 'pre-1.0' };
  return { isPreRelease: false };
}

/** Parses `https://github.com/{owner}/{repo}` into structured form. */
export function detectGitHubRepo(url: string | undefined): GitHubRepo | undefined {
  if (!url) return;
  const match = GITHUB_REPO_ROOT_PATTERN.exec(url.trim());
  if (!match) return;
  const [, owner, repo] = match;
  if (!owner || !repo) return;
  return { url: `https://github.com/${owner}/${repo}`, owner, repo };
}

/** Converts snake_case or kebab-case to Title Case. */
export function deriveTitleFromName(name: string): string {
  return name
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

/** snake_case → kebab-case (for source-link path derivation). */
export function snakeToKebab(name: string): string {
  return name.replace(/_/g, '-').toLowerCase();
}

/** Safe Zod → JSON Schema. Returns undefined if the schema isn't serializable. */
function safeToJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return;
  try {
    return toJSONSchema(schema as ZodObject<ZodRawShape>);
  } catch {
    return;
  }
}

/** Extract required field names from a Zod object schema. Silent on failure. */
function extractRequiredFields(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  try {
    const asObj = schema as { shape?: Record<string, { isOptional?: () => boolean }> };
    if (!asObj.shape || typeof asObj.shape !== 'object') return [];
    const fields: string[] = [];
    for (const [key, field] of Object.entries(asObj.shape)) {
      if (typeof field?.isOptional === 'function' && !field.isOptional()) {
        fields.push(key);
      }
    }
    return fields;
  } catch {
    return [];
  }
}

/** Detect whether a tool's `_meta.ui.resourceUri` flags it as an MCP App tool. */
function isMcpAppTool(def: AnyToolDef): boolean {
  const meta = (def as unknown as Record<string, unknown>)._meta as
    | { ui?: { resourceUri?: string } }
    | undefined;
  return typeof meta?.ui?.resourceUri === 'string' && meta.ui.resourceUri.length > 0;
}

/**
 * Build a canonical source-link URL for a definition by convention:
 *   `${repoRoot}/blob/main/src/mcp-server/<kind>/definitions/<kebab-name>.<suffix>.ts`
 *
 * Returns undefined if `repoRoot` isn't set or the name is empty.
 */
export function deriveSourceUrl(
  repoRoot: GitHubRepo | undefined,
  kind: 'tools' | 'resources' | 'prompts',
  name: string,
): string | undefined {
  if (!repoRoot || !name) return;
  const suffix = kind === 'tools' ? 'tool' : kind === 'resources' ? 'resource' : 'prompt';
  const fileName = `${snakeToKebab(name)}.${suffix}.ts`;
  return `${repoRoot.url}/blob/main/src/mcp-server/${kind}/definitions/${fileName}`;
}

/** Normalize `landing.links` to a concrete array with `external` defaulted. */
function normalizeLinks(links: LandingLink[] | undefined): ManifestLanding['links'] {
  if (!Array.isArray(links) || links.length === 0) return [];
  return links.slice(0, LANDING_MAX_LINKS).map((link) => ({
    href: link.href,
    label: link.label,
    external: link.external ?? /^https?:\/\//i.test(link.href),
  }));
}

/** Discover an npm package auto-link from consumer package.json metadata. */
function detectNpmPackage(pkgName: string | undefined): ManifestLanding['npmPackage'] {
  if (!pkgName) return;
  // Only link scoped packages or names that look like published packages.
  // Avoids false-positive links for internal `my-mcp-server`-style names.
  if (!pkgName.startsWith('@') && !pkgName.includes('/')) return;
  return {
    name: pkgName,
    url: `https://www.npmjs.com/package/${encodeURIComponent(pkgName)}`,
  };
}

/**
 * Normalize `landing.envExample` into the ordered array shape the renderer
 * consumes. Preserves insertion order (important for the rendered JSON block),
 * truncates to {@link LANDING_MAX_ENV_EXAMPLE}, and drops non-string entries
 * silently — the linter surfaces structural issues separately.
 */
function normalizeEnvExample(
  envExample: Record<string, string> | undefined,
): ManifestLanding['envExample'] {
  if (!envExample || typeof envExample !== 'object') return [];
  const entries: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(envExample)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (typeof value !== 'string') continue;
    entries.push({ key, value });
    if (entries.length >= LANDING_MAX_ENV_EXAMPLE) break;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// buildServerManifest
// ---------------------------------------------------------------------------

export interface BuildServerManifestInput {
  config: AppConfig;
  extensions?: Record<string, object>;
  landing?: LandingConfig;
  prompts: AnyPromptDefinition[];
  resources: AnyResourceDefinition[];
  tools: AnyToolDef[];
}

/**
 * Build the server manifest. Pure — same inputs produce the same output.
 * Called once at startup from `composeServices()`.
 */
export function buildServerManifest(input: BuildServerManifestInput): ServerManifest {
  const { config, tools, resources, prompts, extensions, landing = {} } = input;

  const protocolVersions = SUPPORTED_PROTOCOL_VERSIONS;
  const latestProtocol = protocolVersions[0] ?? '2025-06-18';

  // Auto-derive repoRoot from homepage when the consumer didn't set it explicitly.
  const repoRoot = detectGitHubRepo(landing.repoRoot ?? config.mcpServerHomepage);

  const accent = landing.theme?.accent ?? '#6366f1'; // indigo-500 — used by tokens when unset
  if (!isSafeCssColor(accent)) {
    throw configurationError(
      `landing.theme.accent "${accent}" contains characters that are unsafe to interpolate into CSS. Use a hex color (e.g. "#6366f1"), a named color (e.g. "indigo"), or a functional notation like "rgb(99 102 241)" or "oklch(0.7 0.2 280)".`,
      { field: 'landing.theme.accent', value: accent },
    );
  }
  const attribution = landing.attribution ?? true;
  const requireAuth = landing.requireAuth ?? false;

  // Source URL resolution order: per-definition override → repo-convention derivation.
  const toolList: ManifestTool[] = tools.map((def) => {
    const d = def as AnyToolDefinition;
    const name = d.name ?? '';
    const inputSchema = safeToJsonSchema(d.input);
    const outputSchema = safeToJsonSchema(d.output);
    const requiredFields = extractRequiredFields(d.input);
    const sourceUrl = d.sourceUrl ?? deriveSourceUrl(repoRoot, 'tools', name);
    const disabled = getDisabledMetadata(def);

    return {
      name,
      title: d.title ?? d.annotations?.title ?? deriveTitleFromName(name),
      description: d.description ?? '',
      ...(d.annotations && { annotations: d.annotations as Record<string, unknown> }),
      isTask: d.task === true,
      isApp: isMcpAppTool(def),
      ...(d.auth && d.auth.length > 0 && { auth: d.auth }),
      ...(inputSchema !== undefined && { inputSchema }),
      ...(outputSchema !== undefined && { outputSchema }),
      requiredFields,
      ...(sourceUrl && { sourceUrl }),
      ...(disabled && { disabled }),
    };
  });

  const resourceList: ManifestResource[] = resources.map((def) => {
    const name = def.name ?? def.uriTemplate ?? '';
    const sourceUrl = def.sourceUrl ?? deriveSourceUrl(repoRoot, 'resources', name);

    return {
      name,
      title: def.title ?? deriveTitleFromName(name),
      description: def.description ?? '',
      uriTemplate: def.uriTemplate ?? '',
      ...(def.mimeType && { mimeType: def.mimeType }),
      ...(def.annotations && { annotations: def.annotations as Record<string, unknown> }),
      ...(def.auth && def.auth.length > 0 && { auth: def.auth }),
      ...(sourceUrl && { sourceUrl }),
    };
  });

  const promptList: ManifestPrompt[] = prompts.map((def) => {
    const name = def.name ?? '';
    const sourceUrl = def.sourceUrl ?? deriveSourceUrl(repoRoot, 'prompts', name);
    const args = extractPromptArgs(def.args);

    return {
      name,
      title: deriveTitleFromName(name),
      description: def.description ?? '',
      args,
      ...(sourceUrl && { sourceUrl }),
    };
  });

  return {
    server: {
      name: config.mcpServerName,
      version: config.mcpServerVersion,
      ...(config.mcpServerDescription && { description: config.mcpServerDescription }),
      ...(config.mcpServerHomepage && { homepage: config.mcpServerHomepage }),
      environment: config.environment,
    },
    transport: {
      type: config.mcpTransportType,
      endpointPath: config.mcpHttpEndpointPath,
      sessionMode: config.mcpSessionMode,
      ...(config.mcpPublicUrl && { publicUrl: config.mcpPublicUrl }),
    },
    protocol: {
      supportedVersions: protocolVersions,
      latestVersion: latestProtocol,
    },
    definitionCounts: {
      tools: tools.length,
      resources: resources.length,
      prompts: prompts.length,
    },
    capabilities: {
      logging: true,
      tools: tools.length > 0,
      resources: resources.length > 0,
      prompts: prompts.length > 0,
    },
    ...(extensions && { extensions }),
    framework: {
      name: FRAMEWORK_NAME,
      version: FRAMEWORK_VERSION,
      homepage: 'https://github.com/cyanheads/mcp-ts-core',
    },
    auth: {
      mode: config.mcpAuthMode,
      ...(config.oauthIssuerUrl && { oauthIssuer: config.oauthIssuerUrl }),
      ...(config.oauthAudience && { oauthAudience: config.oauthAudience }),
      ...(config.oauthJwksUri && { jwksUri: config.oauthJwksUri }),
      ...(config.mcpServerResourceIdentifier && {
        resourceIdentifier: config.mcpServerResourceIdentifier,
      }),
    },
    definitions: {
      tools: toolList,
      resources: resourceList,
      prompts: promptList,
    },
    landing: buildManifestLanding({
      landing,
      accent,
      repoRoot,
      requireAuth,
      attribution,
      // mcpServerName is derived from the consumer's package.json > MCP_SERVER_NAME > options.name.
      // detectNpmPackage filters to scoped/slashed names, so unscoped server names yield no link.
      packageName: config.mcpServerName,
      version: config.mcpServerVersion,
    }),
    builtAt: new Date().toISOString(),
  };
}

/** Build the derived `landing` branch of the manifest, respecting exactOptionalPropertyTypes. */
function buildManifestLanding(input: {
  landing: LandingConfig;
  accent: string;
  repoRoot: GitHubRepo | undefined;
  requireAuth: boolean;
  attribution: boolean;
  packageName: string | undefined;
  version: string;
}): ManifestLanding {
  const { landing, accent, repoRoot, requireAuth, attribution, packageName, version } = input;
  const npmPackage = detectNpmPackage(packageName);
  const changelogUrl =
    landing.changelogUrl ?? (repoRoot ? `${repoRoot.url}/blob/main/CHANGELOG.md` : undefined);

  return {
    enabled: landing.enabled !== false,
    ...(landing.tagline && { tagline: landing.tagline }),
    ...(landing.logo && { logo: landing.logo }),
    links: normalizeLinks(landing.links),
    envExample: normalizeEnvExample(landing.envExample),
    connectSnippets: normalizeConnectSnippets(landing.connectSnippets),
    theme: { accent },
    ...(repoRoot && { repoRoot }),
    ...(changelogUrl && { changelogUrl }),
    requireAuth,
    attribution,
    ...(npmPackage && { npmPackage }),
    preRelease: classifyPreRelease(version),
  };
}

/**
 * Filter operator-supplied connect snippet overrides to known tab IDs with
 * string values. Unknown keys and non-string values are dropped silently —
 * the linter surfaces structural issues separately.
 */
function normalizeConnectSnippets(
  overrides: LandingConfig['connectSnippets'],
): ManifestLanding['connectSnippets'] {
  if (!overrides || typeof overrides !== 'object') return {};
  const out: Partial<Record<ConnectSnippetTab, string>> = {};
  for (const tab of CONNECT_SNIPPET_TABS) {
    const value = overrides[tab];
    if (typeof value === 'string' && value.length > 0) out[tab] = value;
  }
  return out;
}

/** Extract prompt args (name/description/required) from a Zod object. */
function extractPromptArgs(schema: unknown): ManifestPromptArg[] {
  if (!schema || typeof schema !== 'object') return [];
  try {
    const asObj = schema as {
      shape?: Record<
        string,
        {
          isOptional?: () => boolean;
          description?: string;
          _def?: { description?: string };
        }
      >;
    };
    if (!asObj.shape) return [];
    const args: ManifestPromptArg[] = [];
    for (const [name, field] of Object.entries(asObj.shape)) {
      const required = typeof field?.isOptional === 'function' ? !field.isOptional() : true;
      const description = field?.description ?? field?._def?.description;
      args.push({ name, required, ...(description && { description }) });
    }
    return args;
  } catch {
    return [];
  }
}
