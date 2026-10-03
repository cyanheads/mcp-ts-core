/**
 * @fileoverview Headless MCP Apps host. `renderAppTool` connects to a server as a client
 * advertising `io.modelcontextprotocol/ui`, calls a tool, loads its `ui://` resource into
 * headless `chrome-headless-shell` inside the double-iframe sandbox and CSP the MCP Apps
 * specification prescribes, plays the host half of the protocol through the official
 * `AppBridge`, runs scripted steps against the view, and returns a report.
 *
 * Import from `@cyanheads/mcp-ts-core/testing/apps`. The optional peers
 * `@modelcontextprotocol/client` and `@modelcontextprotocol/ext-apps` are loaded on first
 * use; importing this subpath without them succeeds.
 *
 * @example
 * ```ts
 * import { renderAppTool } from '@cyanheads/mcp-ts-core/testing/apps';
 *
 * const run = await renderAppTool({
 *   server: { command: 'bun', args: ['run', 'dist/index.js'] },
 *   tool: 'my_app_tool',
 *   arguments: { query: 'probe' },
 *   steps: [{ click: '#action-btn' }, { screenshot: 'after-click' }],
 * });
 * ```
 * @module src/testing/apps
 */

/** How to reach the server: a stdio command, or a Streamable HTTP endpoint. */
export type AppServerTarget =
  | {
      args?: string[];
      command: string;
      cwd?: string;
      /** The server's environment. Default: the MCP client's inherited-variable allowlist. */
      env?: Record<string, string>;
    }
  | {
      headers?: Record<string, string>;
      url: string;
    };

/** One scripted action against the view, run after the tool result is delivered. */
export type AppRenderStep =
  | { click: string }
  | { fill: string; value: string }
  | { timeoutMs?: number; waitFor: string }
  | { evaluate: string }
  | { screenshot: string };

/** Display modes a host can offer a view. */
export type AppDisplayMode = 'inline' | 'fullscreen' | 'pip';

/** The host the view sees. */
export interface AppHostOptions {
  /** Display modes the host accepts on `ui/request-display-mode`. Default: `['inline']`. */
  availableDisplayModes?: AppDisplayMode[];
  /** The initial display mode. Default: `'inline'`. */
  displayMode?: AppDisplayMode;
  /** Fixed container height in CSS pixels. Default: follows the view's size-changed reports. */
  height?: number;
  locale?: string;
  /** Send `tool-input-partial` notifications (growing prefixes of the arguments) before `tool-input`. */
  streamInput?: boolean;
  /** CSS custom properties passed as `styles.variables`. */
  styles?: Record<string, string>;
  /** Default: `'light'`. */
  theme?: 'light' | 'dark';
  timeZone?: string;
  /** Container width in CSS pixels. Default: 720. */
  width?: number;
}

/** Options for one render. */
export interface RenderAppToolOptions {
  arguments?: Record<string, unknown>;
  /** Path to a `chrome-headless-shell` executable; overrides `MCP_APPS_BROWSER_PATH` and the cache. */
  browserPath?: string;
  host?: AppHostOptions;
  /** Where screenshots are written. Default: a new directory under the OS temp dir. */
  outDir?: string;
  server: AppServerTarget;
  steps?: AppRenderStep[];
  /** How long to wait for the view's `initialized` and for each step. Default: 15000 ms. */
  timeoutMs?: number;
  tool: string;
}

/** A message between the view and the host, as it crossed the sandbox. */
export interface AppRenderMessage {
  /** Milliseconds since the run started. */
  at: number;
  direction: 'view-to-host' | 'host-to-view';
  message: Record<string, unknown>;
}

/** An uncaught exception or console error. */
export interface AppRenderError {
  column?: number;
  /** The frame it came from: the view, the sandbox proxy, or the host page. */
  frame: 'view' | 'sandbox' | 'host' | 'unknown';
  line?: number;
  message: string;
  source: 'exception' | 'console';
  url?: string;
}

/** A Content Security Policy violation in the sandbox or the view. */
export interface AppCspViolation {
  /** The blocked URL, or `eval` / `inline` / `wasm-eval` for a blocked script evaluation. */
  blockedURI: string;
  directive: string;
  line?: number;
  sourceURL?: string;
  violationType: string;
}

/** The outcome of one step. */
export interface AppRenderStepResult {
  error?: string;
  ok: boolean;
  /** Path of the PNG a screenshot step wrote. */
  screenshot?: string;
  step: AppRenderStep;
  /** The value an evaluate step returned. */
  value?: unknown;
}

/** What one render observed. */
export interface AppRenderReport {
  /** The view's `appInfo` from `ui/initialize`. */
  appInfo?: { name: string; version: string };
  arguments: Record<string, unknown>;
  browser: { executable: string; pid: number; profileDir: string };
  /** The CSP header the sandbox applied to the view. */
  csp: string;
  cspViolations: AppCspViolation[];
  durationMs: number;
  errors: AppRenderError[];
  /** A failure after the browser was reached, such as the view never initializing. */
  failure?: string;
  /** The view completed `ui/initialize`. */
  initialized: boolean;
  messages: AppRenderMessage[];
  resourceUri: string;
  screenshots: string[];
  /** The last `ui/notifications/size-changed`. */
  size?: { height?: number; width?: number };
  steps: AppRenderStepResult[];
  /** The view's rendered text after the steps. */
  text: string;
  tool: string;
  /** Why the tool call failed at the protocol level; the view then received `tool-cancelled`. */
  toolError?: string;
  toolResult?: Record<string, unknown>;
}

/**
 * Render an app tool's view in a headless MCP Apps host and report what happened.
 * Resolves with the report whenever the run reached the browser, even when the view
 * failed. Throws only on setup failures: a missing optional peer, no browser, the server
 * unreachable, the tool missing, or its UI resource absent, unreadable, or declaring a
 * `_meta.ui.csp` entry that is not a plain origin.
 */
export async function renderAppTool(options: RenderAppToolOptions): Promise<AppRenderReport> {
  const { runAppRender } = await import('./run.js');
  return runAppRender(options);
}
