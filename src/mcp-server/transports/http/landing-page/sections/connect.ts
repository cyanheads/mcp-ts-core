/**
 * @fileoverview Terminal-chrome connect card with one tab per common MCP
 * client (Claude, Codex, Cursor, Gemini) plus transport / protocol fallbacks
 * (STDIO, HTTP, curl). Generates copy-paste-ready client configs and commands
 * from the server manifest. Radio-input + `:has()` CSS hack drives tab
 * switching with no JS; the `claude` tab is the default checked panel because
 * it's the most common visitor conversion path.
 *
 * Accessibility: the ARIA tab pattern (`role="tablist"`/`"tab"`/`"tabpanel"`
 * + `aria-selected`/`aria-controls`) is a poor fit for a radio-input-driven
 * widget — the radios already communicate a mutually-exclusive selection to
 * assistive tech. We don't add ARIA tab roles because they'd be incomplete
 * (no `aria-selected` state, no `aria-controls` wiring) and a partial ARIA
 * pattern is worse than none.
 *
 * @module src/mcp-server/transports/http/landing-page/sections/connect
 */

import type { ServerManifest } from '@/core/serverManifest.js';
import { html, type SafeHtml } from '@/utils/formatting/html.js';

export function renderConnectSnippets(manifest: ServerManifest, baseUrl: string): SafeHtml {
  const endpoint = `${baseUrl.replace(/\/$/, '')}${manifest.transport.endpointPath}`;
  const npmPackage = manifest.landing.npmPackage?.name;
  // `@cyanheads/mcp-ts-core` → `mcp-ts-core`. Short aliases match the convention
  // used in real Claude Desktop / Cursor configs and make the `claude mcp add`
  // command more ergonomic.
  const shortName = deriveShortName(manifest.server.name);
  const envExample = manifest.landing.envExample;
  const stdioEnv = envExample.length > 0 ? envFromEntries(envExample) : undefined;
  // Operator-supplied per-tab overrides win over derivation. Empty object
  // when unset — falls through to the derived snippets below.
  const overrides = manifest.landing.connectSnippets;

  // STDIO: prefer native `bunx <pkg>@latest` when the server is published;
  // fall back to `mcp-remote` as a stdio → HTTP bridge so the tab is always
  // useful even for unpublished servers. Env vars belong here — this is the
  // only transport where the client spawns the server process and can pass
  // them through.
  const stdioConfig =
    overrides.stdio ??
    JSON.stringify(
      {
        mcpServers: {
          [shortName]: {
            command: 'bunx',
            args: npmPackage ? [`${npmPackage}@latest`] : ['mcp-remote', endpoint],
            ...(stdioEnv && { env: stdioEnv }),
          },
        },
      },
      null,
      2,
    );

  // HTTP: no `env` block. MCP clients only forward env vars to spawned stdio
  // child processes; for `type: 'http'` there's no process, so including env
  // is a silent no-op that misleads visitors of a hosted instance into
  // thinking they need to supply credentials the server already owns.
  const httpConfig =
    overrides.http ??
    JSON.stringify(
      {
        mcpServers: {
          [shortName]: {
            type: 'http',
            url: endpoint,
          },
        },
      },
      null,
      2,
    );

  // Per-client install snippets — always target the HTTP endpoint. The
  // landing page is served over HTTP, so a visitor is already interacting
  // with this instance; a stdio/bunx command in these tabs would install a
  // different (local) copy and carry env placeholders that HTTP wouldn't
  // forward anyway. The STDIO tab below still carries the JSON for anyone
  // who wants to run locally.
  const claudeCmd = overrides.claude ?? buildClaudeHttpCmd(shortName, endpoint);
  const codexCmd = overrides.codex ?? buildCodexHttpCmd(shortName, endpoint);
  const cursorConfig = overrides.cursor ?? buildCursorHttpConfig(shortName, endpoint);
  const geminiCmd = overrides.gemini ?? buildGeminiHttpCmd(shortName, endpoint);

  const curl =
    overrides.curl ??
    [
      `curl -X POST ${endpoint} \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "MCP-Protocol-Version: ${manifest.protocol.latestVersion}" \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"${manifest.protocol.latestVersion}","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'`,
    ].join('\n');

  // Chrome label — npm package when published, else the HTTP endpoint (trimmed).
  const chromeLabel = npmPackage ?? endpoint.replace(/^https?:\/\//, '');

  // Order is the rendered tab order. `claude` leads as the default conversion
  // path; named clients follow alphabetically; transport / protocol fallbacks
  // bring up the rear. The default checked tab is wired by id below — keep
  // it in sync with `DEFAULT_TAB`.
  const panels: Array<{ id: string; label: string; content: string; copyAriaLabel: string }> = [
    {
      id: 'claude',
      label: 'Claude',
      content: claudeCmd,
      copyAriaLabel: 'Copy claude mcp add command',
    },
    {
      id: 'codex',
      label: 'Codex',
      content: codexCmd,
      copyAriaLabel: 'Copy codex mcp add command',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      content: cursorConfig,
      copyAriaLabel: 'Copy Cursor mcp.json config',
    },
    {
      id: 'gemini',
      label: 'Gemini',
      content: geminiCmd,
      copyAriaLabel: 'Copy gemini mcp add command',
    },
    { id: 'stdio', label: 'STDIO', content: stdioConfig, copyAriaLabel: 'Copy stdio config' },
    {
      id: 'http',
      label: 'Streamable HTTP',
      content: httpConfig,
      copyAriaLabel: 'Copy HTTP config',
    },
    { id: 'curl', label: 'curl', content: curl, copyAriaLabel: 'Copy curl command' },
  ];

  return html`
    <div class="connect" aria-label="Connection snippets">
      <div class="connect-chrome">
        <span class="connect-chrome-dots" aria-hidden="true">
          <span class="connect-chrome-dot"></span>
          <span class="connect-chrome-dot"></span>
          <span class="connect-chrome-dot"></span>
        </span>
        <span class="connect-chrome-endpoint" title="${endpoint}">${chromeLabel}</span>
      </div>
      <div class="connect-tabs">
        ${panels.map((p) =>
          p.id === DEFAULT_TAB
            ? html`<input type="radio" class="connect-tab-input" name="connect" id="connect-tab-${p.id}" checked /><label for="connect-tab-${p.id}" class="connect-tab-label">${p.label}</label>`
            : html`<input type="radio" class="connect-tab-input" name="connect" id="connect-tab-${p.id}" /><label for="connect-tab-${p.id}" class="connect-tab-label">${p.label}</label>`,
        )}
      </div>
      <div class="connect-panels">
        ${panels.map((p) => renderConnectPanel(p.id, p.content, p.copyAriaLabel))}
      </div>
    </div>
  `;
}

/**
 * Default selected tab id. Claude is the most common conversion path for
 * MCP visitors; if it ever moves, the `@supports not selector(:has(*))`
 * fallback in styles.ts (which shows `.connect-panel:first-of-type`) needs
 * to stay aligned with the first entry in the panels array.
 */
const DEFAULT_TAB = 'claude';

/**
 * Single panel inside the connect card — pre/code + copy button.
 *
 * The `<!--email_off-->` wrap suppresses Cloudflare's Email Address
 * Obfuscation edge scanner, which would otherwise rewrite any email-shaped
 * placeholder in the snippet (`you@example.com` → obfuscated markup) and
 * break the Copy button's output for visitors behind a CF Tunnel. The
 * directive is CF-specific but ignored everywhere else — two HTML comments
 * per panel, zero runtime cost.
 */
function renderConnectPanel(id: string, content: string, copyAriaLabel: string): SafeHtml {
  const snippetId = `connect-snippet-${id}`;
  return html`
    <div class="connect-panel panel-${id}">
      <pre id="${snippetId}"><code><!--email_off-->${content}<!--/email_off--></code></pre>
      <button type="button" class="connect-copy" data-copy data-copy-target="#${snippetId}" aria-label="${copyAriaLabel}">Copy</button>
    </div>
  `;
}

/**
 * `@scope/pkg-name` → `pkg-name`. Fall through for bare names.
 * Used as the `mcpServers` key and the Claude CLI server alias.
 */
function deriveShortName(serverName: string): string {
  const slash = serverName.lastIndexOf('/');
  return slash >= 0 ? serverName.slice(slash + 1) : serverName;
}

/** Convert ordered env entries to the `{ KEY: value }` shape MCP clients expect. */
function envFromEntries(
  entries: ReadonlyArray<{ key: string; value: string }>,
): Record<string, string> {
  return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
}

/** `claude mcp add --transport http <name> <url>` */
function buildClaudeHttpCmd(shortName: string, endpoint: string): string {
  return `claude mcp add --transport http ${shortName} ${endpoint}`;
}

/** `codex mcp add <name> --url <url>` — adds a streamable-HTTP server to `~/.codex/config.toml`. */
function buildCodexHttpCmd(shortName: string, endpoint: string): string {
  return `codex mcp add ${shortName} --url ${endpoint}`;
}

/** `gemini mcp add --transport http <name> <url>` — writes to `~/.gemini/settings.json`. */
function buildGeminiHttpCmd(shortName: string, endpoint: string): string {
  return `gemini mcp add --transport http ${shortName} ${endpoint}`;
}

/**
 * Cursor has no first-party CLI; users paste a `mcpServers` block into
 * `~/.cursor/mcp.json` (or `.cursor/mcp.json` per-project). The bare `url`
 * field is the modern streamable-HTTP shape — Cursor handles transport
 * negotiation internally.
 */
function buildCursorHttpConfig(shortName: string, endpoint: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [shortName]: {
          url: endpoint,
        },
      },
    },
    null,
    2,
  );
}
