/**
 * @fileoverview One headless MCP Apps host run, loaded on demand by `renderAppTool`.
 * Node holds the MCP client and the official `AppBridge`; the bridge's transport relays
 * JSON-RPC through the host page's isolated-world relay into the sandbox proxy and the
 * view. CDP supplies the instrumentation: exceptions and console errors from
 * `Runtime`, CSP violations from `Audits` issues, frames from `Page`. The optional peers
 * are imported here, inside the run, never at module load.
 * @module src/testing/apps/run
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  CallToolResult,
  Client,
  JSONRPCMessage,
  Tool,
  Transport,
} from '@modelcontextprotocol/client';
import type {
  AppBridge,
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiResourcePermissions,
  McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge';

import { FRAMEWORK_VERSION } from '@/config/index.js';
import {
  configurationError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@/types-global/errors.js';

import { discoverBrowser, type LaunchedBrowser, launchBrowser } from './browser.js';
import type { CdpObject, CdpPipe } from './cdp-pipe.js';
import { type AppCspMetadata, buildCsp } from './csp.js';
import {
  HOST_WORLD,
  type HostPages,
  RECEIVE_BINDING,
  RESIZE_FUNCTION,
  SANDBOX_FRAME_ID,
  SEND_FUNCTION,
  startHostPages,
} from './host-pages.js';
import type {
  AppRenderError,
  AppRenderMessage,
  AppRenderReport,
  AppRenderStep,
  AppRenderStepResult,
  AppServerTarget,
  RenderAppToolOptions,
} from './index.js';
import { partialArguments } from './partial-json.js';

const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const APP_MIME_TYPE = 'text/html;profile=mcp-app';
const HOST_INFO = { name: 'mcp-ts-core-app-host', version: FRAMEWORK_VERSION };
const DEFAULT_WIDTH = 720;
/** Starting container height when the host follows the view's size reports. */
const INITIAL_HEIGHT = 480;
const MAX_HEIGHT = 4000;
const MIN_VIEWPORT_HEIGHT = 900;
const SERVER_STDERR_TAIL = 4 * 1024;

/** Script evaluations the CSP reports with no URL, named as `securitypolicyviolation` names them. */
const BLOCKED_EVALUATIONS: Record<string, string> = {
  kEvalViolation: 'eval',
  kWasmEvalViolation: 'wasm-eval',
  kInlineViolation: 'inline',
};

type Peers = Awaited<ReturnType<typeof loadPeers>>;

/** Run one render. See `renderAppTool`. */
export async function runAppRender(options: RenderAppToolOptions): Promise<AppRenderReport> {
  const started = performance.now();
  const peers = await loadPeers();
  const executable = await discoverBrowser(options.browserPath);

  const client = new peers.Client(HOST_INFO, {
    capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } } },
  });
  let pages: HostPages | undefined;
  let browser: LaunchedBrowser | undefined;
  try {
    await connect(peers, client, options.server);
    const tools = await listTools(client);
    const tool = tools.find((candidate) => candidate.name === options.tool);
    if (!tool) {
      throw notFound(
        `The server has no tool named ${options.tool}. Its tools: ${tools.map((t) => t.name).join(', ') || '(none)'}.`,
        { reason: 'tool_not_found' },
      );
    }
    const resourceUri = peers.getToolUiResourceUri(tool);
    if (!resourceUri) {
      throw validationError(
        `Tool ${options.tool} declares no UI resource (_meta.ui.resourceUri), so there is no view to render.`,
        { reason: 'no_ui_resource' },
      );
    }
    const resource = await readView(client, resourceUri);
    const csp = buildCsp(resource.csp);
    const args = options.arguments ?? {};

    let toolResult: CallToolResult | undefined;
    let toolError: string | undefined;
    try {
      toolResult = (await client.callTool({ name: tool.name, arguments: args })) as CallToolResult;
    } catch (err) {
      toolError = errorMessage(err);
    }

    const host = options.host ?? {};
    pages = await startHostPages(csp, {
      allow: peers.buildAllowAttribute(resource.permissions),
      width: host.width ?? DEFAULT_WIDTH,
      height: host.height ?? INITIAL_HEIGHT,
      background: host.theme === 'dark' ? '#1f1f1f' : '#ffffff',
    });
    browser = await launchBrowser(executable);

    const report: AppRenderReport = {
      tool: tool.name,
      resourceUri,
      arguments: args,
      csp,
      initialized: false,
      errors: [],
      cspViolations: [],
      messages: [],
      steps: [],
      text: '',
      screenshots: [],
      browser: { executable, pid: browser.process.pid, profileDir: browser.profileDir },
      durationMs: 0,
      ...(toolResult && { toolResult: toolResult as Record<string, unknown> }),
      ...(toolError !== undefined && { toolError }),
    };
    const run = new BrowserRun({
      peers,
      client,
      tools,
      tool,
      resource,
      options,
      pages,
      cdp: browser.process.cdp,
      report,
      started,
      ...(toolResult && { toolResult }),
      ...(toolError !== undefined && { toolError }),
    });
    try {
      await run.execute();
    } catch (err) {
      report.failure ??= errorMessage(err);
    }
    report.durationMs = Math.round(performance.now() - started);
    return report;
  } finally {
    await closeAll([
      () => browser?.close(),
      () => pages?.close(),
      () => client.close().catch(() => {}),
    ]);
  }
}

/** Run every closer in order, each one even after an earlier one fails; then rethrow the first failure. */
async function closeAll(closers: (() => Promise<void> | undefined)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

// ── Setup ──────────────────────────────────────────────────────────────

/** The specifier a resolution error reports as missing, in Node's and Bun's wording. */
const MISSING_SPECIFIER = /Cannot find (?:package|module) ['"]([^'"]+)['"]/i;

async function loadPeer<T>(pkg: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    const missing = MISSING_SPECIFIER.exec(errorMessage(err))?.[1];
    if (missing === pkg || missing?.startsWith(`${pkg}/`)) {
      throw configurationError(
        `renderAppTool needs the optional peer dependency ${pkg}, which is not installed. Install it with \`bun add -d ${pkg}\`.`,
        { reason: 'missing_peer', package: pkg },
        { cause: err },
      );
    }
    throw err;
  }
}

async function loadPeers() {
  const client = await loadPeer(
    '@modelcontextprotocol/client',
    () => import('@modelcontextprotocol/client'),
  );
  const stdio = await loadPeer(
    '@modelcontextprotocol/client',
    () => import('@modelcontextprotocol/client/stdio'),
  );
  const apps = await loadPeer(
    '@modelcontextprotocol/ext-apps',
    () => import('@modelcontextprotocol/ext-apps/app-bridge'),
  );
  return {
    Client: client.Client,
    StreamableHTTPClientTransport: client.StreamableHTTPClientTransport,
    StdioClientTransport: stdio.StdioClientTransport,
    AppBridge: apps.AppBridge,
    buildAllowAttribute: apps.buildAllowAttribute,
    getToolUiResourceUri: apps.getToolUiResourceUri,
  };
}

async function connect(peers: Peers, client: Client, server: AppServerTarget): Promise<void> {
  let stderrTail = '';
  let target: string;
  let transport: Transport;
  if ('url' in server) {
    target = server.url;
    transport = new peers.StreamableHTTPClientTransport(
      new URL(server.url),
      server.headers ? { requestInit: { headers: server.headers } } : undefined,
    );
  } else {
    target = [server.command, ...(server.args ?? [])].join(' ');
    const stdio = new peers.StdioClientTransport({
      command: server.command,
      stderr: 'pipe',
      ...(server.args && { args: server.args }),
      ...(server.cwd && { cwd: server.cwd }),
      ...(server.env && { env: server.env }),
    });
    (stdio.stderr as Readable | null)?.setEncoding('utf8').on('data', (text: string) => {
      stderrTail = (stderrTail + text).slice(-SERVER_STDERR_TAIL);
    });
    transport = stdio;
  }
  try {
    await client.connect(transport);
  } catch (err) {
    const stderr = stderrTail.trim().split('\n').at(-1);
    throw serviceUnavailable(
      `Could not connect to the MCP server (${target}): ${errorMessage(err)}${stderr ? ` Server stderr: ${stderr}` : ''}`,
      { reason: 'server_unreachable' },
      { cause: err },
    );
  }
}

async function listTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** The view's HTML and the `_meta.ui` fields the sandbox applies. */
interface ViewResource {
  csp: AppCspMetadata | undefined;
  html: string;
  permissions: McpUiResourcePermissions | undefined;
}

async function readView(client: Client, uri: string): Promise<ViewResource> {
  const read = await client.readResource({ uri }).catch((err: unknown) => {
    throw notFound(
      `Could not read the tool's UI resource ${uri}: ${errorMessage(err)}`,
      { reason: 'ui_resource_unreadable' },
      { cause: err },
    );
  });
  const content = read.contents[0];
  if (!content) {
    throw notFound(`The UI resource ${uri} returned no contents.`, {
      reason: 'ui_resource_unreadable',
    });
  }
  const html =
    'text' in content ? content.text : Buffer.from(content.blob, 'base64').toString('utf8');
  const ui = (
    content._meta as
      | { ui?: { csp?: AppCspMetadata; permissions?: McpUiResourcePermissions } }
      | undefined
  )?.ui;
  return { html, csp: ui?.csp, permissions: ui?.permissions };
}

// ── The browser half ───────────────────────────────────────────────────

interface BrowserRunInit {
  cdp: CdpPipe;
  client: Client;
  options: RenderAppToolOptions;
  pages: HostPages;
  peers: Peers;
  report: AppRenderReport;
  resource: ViewResource;
  started: number;
  tool: Tool;
  toolError?: string;
  toolResult?: CallToolResult;
  tools: Tool[];
}

interface ContextInfo {
  frameId: string;
  isDefault: boolean;
  name: string;
}

interface Point {
  x: number;
  y: number;
}

class BrowserRun {
  readonly #init: BrowserRunInit;
  readonly #report: AppRenderReport;
  readonly #timeoutMs: number;
  readonly #contexts = new Map<number, ContextInfo>();
  /** View requests still waiting for the host's response. */
  readonly #pending = new Set<string | number>();
  readonly #initialized = Promise.withResolvers<void>();
  #sessionId = '';
  #mainFrame = '';
  #sandboxFrame: string | undefined;
  #viewFrame: string | undefined;
  #viewportHeight = MIN_VIEWPORT_HEIGHT;
  #outDir: Promise<string> | undefined;

  constructor(init: BrowserRunInit) {
    this.#init = init;
    this.#report = init.report;
    this.#timeoutMs = init.options.timeoutMs ?? 15_000;
  }

  async execute(): Promise<void> {
    const { cdp, options, pages } = this.#init;
    const host = options.host ?? {};
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    this.#mainFrame = targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.#sessionId = sessionId;
    this.#instrument();

    await this.#send('Page.enable');
    await this.#send('Runtime.enable');
    await this.#send('Audits.enable');
    await this.#send('Emulation.setFocusEmulationEnabled', { enabled: true });
    this.#viewportHeight = Math.max(MIN_VIEWPORT_HEIGHT, host.height ?? 0);
    await this.#setViewport();
    await this.#send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: host.theme ?? 'light' }],
    });
    await this.#send('Runtime.addBinding', {
      name: RECEIVE_BINDING,
      executionContextName: HOST_WORLD,
    });
    await this.#send('Page.addScriptToEvaluateOnNewDocument', {
      source: pages.relayScript,
      worldName: HOST_WORLD,
      runImmediately: true,
    });

    const transport = new RelayTransport(
      (json) =>
        this.#evaluate(this.#mainFrame, `${SEND_FUNCTION}(${JSON.stringify(json)})`, HOST_WORLD),
      (direction, message) => this.#record(direction, message),
    );
    this.#on<{ name: string; payload: string }>('Runtime.bindingCalled', ({ name, payload }) => {
      if (name === RECEIVE_BINDING) transport.receive(JSON.parse(payload) as JSONRPCMessage);
    });
    const bridge = await this.#connectBridge(transport);

    await this.#send('Page.navigate', { url: pages.hostUrl });
    const initialized = await this.#within(this.#initialized.promise, this.#timeoutMs);
    if (!initialized) {
      this.#report.failure ??= `The view did not complete ui/initialize within ${this.#timeoutMs} ms.`;
    } else {
      await this.#deliverToolCall(bridge);
      await this.#settle();
      for (const step of options.steps ?? []) this.#report.steps.push(await this.#runStep(step));
    }
    if (this.#viewFrame) {
      this.#report.text = await this.#evaluate<string>(
        this.#viewFrame,
        'document.body ? document.body.innerText : ""',
      ).catch(() => '');
      await this.#screenshot('final').catch((err: unknown) => {
        this.#report.failure ??= `Final screenshot failed: ${errorMessage(err)}`;
      });
    }
    if (initialized) await bridge.teardownResource({}, { timeout: 3_000 }).catch(() => {});
    await bridge.close().catch(() => {});
  }

  async #connectBridge(transport: RelayTransport): Promise<AppBridge> {
    const { peers, client, options, tool, tools, resource } = this.#init;
    const host = options.host ?? {};
    const width = host.width ?? DEFAULT_WIDTH;
    const displayModes = host.availableDisplayModes ?? ['inline'];
    let displayMode = host.displayMode ?? 'inline';
    const hostContext = {
      theme: host.theme ?? 'light',
      platform: 'web',
      displayMode,
      availableDisplayModes: displayModes,
      containerDimensions:
        host.height !== undefined
          ? { width, height: host.height }
          : { width, maxHeight: MAX_HEIGHT },
      toolInfo: { tool },
      // McpUiStyles requires every variable; a host passes a partial set.
      ...(host.styles && { styles: { variables: host.styles as McpUiStyles } }),
      ...(host.locale && { locale: host.locale }),
      ...(host.timeZone && { timeZone: host.timeZone }),
    } satisfies McpUiHostContext;
    const sandbox: NonNullable<McpUiHostCapabilities['sandbox']> = {
      ...(resource.csp && { csp: resource.csp }),
      ...(resource.permissions && { permissions: resource.permissions }),
    };
    const capabilities: McpUiHostCapabilities = {
      openLinks: {},
      downloadFile: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
      sandbox,
    };
    /**
     * The bridge gets no client: given one, it forwards every view tools/call unchecked.
     * The handlers below forward to the server and enforce the spec's "Visibility" rule.
     */
    const bridge = new peers.AppBridge(null, HOST_INFO, capabilities, { hostContext });
    bridge.onsandboxready = () => {
      bridge.sendSandboxResourceReady({ html: resource.html, ...sandbox }).catch((err: unknown) => {
        this.#report.failure ??= `Could not deliver the view HTML: ${errorMessage(err)}`;
      });
    };
    bridge.oninitialized = () => {
      this.#report.initialized = true;
      const appInfo = bridge.getAppVersion();
      if (appInfo) this.#report.appInfo = { name: appInfo.name, version: appInfo.version };
      this.#initialized.resolve();
    };
    bridge.onsizechange = (size) => {
      this.#report.size = {
        ...(size.width !== undefined && { width: size.width }),
        ...(size.height !== undefined && { height: size.height }),
      };
      if (host.height === undefined && size.height !== undefined) {
        void this.#resize(Math.min(MAX_HEIGHT, Math.ceil(size.height))).catch(() => {});
      }
    };
    bridge.onmessage = async () => ({});
    bridge.onopenlink = async () => ({});
    bridge.ondownloadfile = async () => ({});
    bridge.onupdatemodelcontext = async () => ({});
    bridge.onrequestdisplaymode = ({ mode }) => {
      if (displayModes.includes(mode)) displayMode = mode;
      return Promise.resolve({ mode: displayMode });
    };
    bridge.oncalltool = (params) => {
      const visibility = (
        tools.find((t) => t.name === params.name)?._meta?.ui as
          | { visibility?: string[] }
          | undefined
      )?.visibility;
      if (Array.isArray(visibility) && !visibility.includes('app')) {
        return Promise.reject(
          new Error(
            `Tool ${params.name} is not callable from an app: its _meta.ui.visibility is ${JSON.stringify(visibility)}.`,
          ),
        );
      }
      return client.callTool(params) as Promise<CallToolResult>;
    };
    bridge.onreadresource = (params) => client.readResource(params);
    bridge.onlistresources = (params) => client.listResources(params);
    bridge.onlistresourcetemplates = (params) => client.listResourceTemplates(params);
    await bridge.connect(transport);
    return bridge;
  }

  async #deliverToolCall(bridge: AppBridge): Promise<void> {
    const { options, toolResult, toolError } = this.#init;
    const args = this.#report.arguments;
    if (options.host?.streamInput) {
      for (const partial of partialArguments(args)) {
        await bridge.sendToolInputPartial({ arguments: partial });
      }
    }
    await bridge.sendToolInput({ arguments: args });
    if (toolResult) await bridge.sendToolResult(toolResult);
    else await bridge.sendToolCancelled({ reason: toolError ?? 'The tool call failed.' });
  }

  async #runStep(step: AppRenderStep): Promise<AppRenderStepResult> {
    try {
      if ('click' in step) {
        await this.#click(step.click);
        await this.#settle();
        return { step, ok: true };
      }
      if ('fill' in step) {
        await this.#evaluate(
          this.#requireView(),
          `(() => { const el = document.querySelector(${JSON.stringify(step.fill)}); if (!el) throw new Error('No element matches ' + ${JSON.stringify(step.fill)}); el.focus(); if (typeof el.select === 'function') el.select(); return true; })()`,
        );
        await this.#send('Input.insertText', { text: step.value });
        await this.#settle();
        return { step, ok: true };
      }
      if ('waitFor' in step) {
        const deadline = Date.now() + (step.timeoutMs ?? this.#timeoutMs);
        const probe = `!!document.querySelector(${JSON.stringify(step.waitFor)})`;
        while (!(await this.#evaluate<boolean>(this.#requireView(), probe))) {
          if (Date.now() > deadline) throw new Error(`Timed out waiting for ${step.waitFor}`);
          await delay(50);
        }
        return { step, ok: true };
      }
      if ('evaluate' in step) {
        const value = await this.#evaluate(this.#requireView(), step.evaluate);
        await this.#settle();
        return { step, ok: true, value };
      }
      return { step, ok: true, screenshot: await this.#screenshot(step.screenshot) };
    } catch (err) {
      return { step, ok: false, error: errorMessage(err) };
    }
  }

  async #click(selector: string): Promise<void> {
    const view = this.#requireView();
    const point = await this.#evaluate<Point | null>(
      view,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!point) throw new Error(`No element matches ${selector}`);
    const outer = await this.#evaluate<Point>(
      this.#mainFrame,
      frameOrigin(`document.getElementById(${JSON.stringify(SANDBOX_FRAME_ID)})`),
    );
    if (!this.#sandboxFrame) throw new Error('The sandbox frame was never created.');
    const inner = await this.#evaluate<Point>(
      this.#sandboxFrame,
      frameOrigin(`document.querySelector('iframe')`),
    );
    const x = outer.x + inner.x + point.x;
    const y = outer.y + inner.y + point.y;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.#send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  async #screenshot(name: string): Promise<string> {
    const rect = await this.#evaluate<{ x: number; y: number; width: number; height: number }>(
      this.#mainFrame,
      `(() => { const r = document.getElementById(${JSON.stringify(SANDBOX_FRAME_ID)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
    );
    const { data } = await this.#send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { ...rect, scale: 1 },
      captureBeyondViewport: true,
    });
    const dir = await this.#screenshotDir();
    const file = path.join(dir, `${name.replace(/[^\w.-]+/g, '-') || 'screenshot'}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    this.#report.screenshots.push(file);
    return file;
  }

  #screenshotDir(): Promise<string> {
    const { outDir } = this.#init.options;
    this.#outDir ??= outDir
      ? mkdir(outDir, { recursive: true }).then(() => outDir)
      : mkdtemp(path.join(os.tmpdir(), 'mcp-app-render-'));
    return this.#outDir;
  }

  async #resize(height: number): Promise<void> {
    await this.#evaluate(this.#mainFrame, `${RESIZE_FUNCTION}(${height})`, HOST_WORLD);
    if (height > this.#viewportHeight) {
      this.#viewportHeight = height;
      await this.#setViewport();
    }
  }

  #setViewport(): Promise<CdpObject> {
    return this.#send('Emulation.setDeviceMetricsOverride', {
      width: this.#init.options.host?.width ?? DEFAULT_WIDTH,
      height: this.#viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** Wait for the view's outstanding requests to be answered, then for two frames to paint. */
  async #settle(): Promise<void> {
    await delay(100);
    const deadline = Date.now() + this.#timeoutMs;
    while (this.#pending.size > 0 && Date.now() < deadline) await delay(25);
    if (this.#viewFrame) {
      await this.#within(
        this.#evaluate(
          this.#viewFrame,
          'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
        ).catch(() => {}),
        1_000,
      );
    }
    await delay(100);
  }

  #record(direction: AppRenderMessage['direction'], message: JSONRPCMessage): void {
    const fields = message as { id?: string | number; method?: string };
    if (fields.method?.startsWith('ui/notifications/sandbox-')) return;
    if (fields.id !== undefined) {
      if (direction === 'view-to-host' && fields.method !== undefined) this.#pending.add(fields.id);
      if (direction === 'host-to-view' && fields.method === undefined)
        this.#pending.delete(fields.id);
    }
    this.#report.messages.push({
      at: Math.round(performance.now() - this.#init.started),
      direction,
      message: message as Record<string, unknown>,
    });
  }

  #instrument(): void {
    this.#on<{ frameId: string; parentFrameId: string }>('Page.frameAttached', (frame) => {
      if (frame.parentFrameId === this.#mainFrame) this.#sandboxFrame = frame.frameId;
      else if (frame.parentFrameId === this.#sandboxFrame) this.#viewFrame = frame.frameId;
    });
    this.#on<{
      context: { id: number; name: string; auxData?: { frameId?: string; isDefault?: boolean } };
    }>('Runtime.executionContextCreated', ({ context }) => {
      if (!context.auxData?.frameId) return;
      this.#contexts.set(context.id, {
        frameId: context.auxData.frameId,
        isDefault: context.auxData.isDefault === true,
        name: context.name,
      });
    });
    this.#on<{ executionContextId: number }>('Runtime.executionContextDestroyed', (event) => {
      this.#contexts.delete(event.executionContextId);
    });
    this.#on('Runtime.executionContextsCleared', () => this.#contexts.clear());
    this.#on<{ exceptionDetails: ExceptionDetails }>(
      'Runtime.exceptionThrown',
      ({ exceptionDetails: d }) => {
        this.#report.errors.push({
          source: 'exception',
          frame: this.#frameOf(d.executionContextId),
          message: d.exception?.description ?? d.text,
          ...location(d.url, d.lineNumber, d.columnNumber),
        });
      },
    );
    this.#on<ConsoleEvent>('Runtime.consoleAPICalled', (event) => {
      if (event.type !== 'error' && event.type !== 'assert') return;
      const top = event.stackTrace?.callFrames[0];
      this.#report.errors.push({
        source: 'console',
        frame: this.#frameOf(event.executionContextId),
        message: event.args.map(describeRemote).join(' '),
        ...location(top?.url, top?.lineNumber, top?.columnNumber),
      });
    });
    this.#on<{ issue: CspIssue }>('Audits.issueAdded', ({ issue }) => {
      const details = issue.details.contentSecurityPolicyIssueDetails;
      if (issue.code !== 'ContentSecurityPolicyIssue' || !details) return;
      const type = details.contentSecurityPolicyViolationType;
      const source = details.sourceCodeLocation;
      this.#report.cspViolations.push({
        directive: details.violatedDirective,
        blockedURI: details.blockedURL ?? BLOCKED_EVALUATIONS[type] ?? type,
        violationType: type,
        ...(source?.url && { sourceURL: source.url }),
        ...(source && source.lineNumber >= 0 && { line: source.lineNumber + 1 }),
      });
    });
  }

  #frameOf(contextId: number | undefined): AppRenderError['frame'] {
    const frameId = contextId === undefined ? undefined : this.#contexts.get(contextId)?.frameId;
    if (frameId === undefined) return 'unknown';
    if (frameId === this.#viewFrame) return 'view';
    if (frameId === this.#sandboxFrame) return 'sandbox';
    return frameId === this.#mainFrame ? 'host' : 'unknown';
  }

  #requireView(): string {
    if (!this.#viewFrame) throw new Error('The view frame was never created.');
    return this.#viewFrame;
  }

  /** Evaluate `expression` in a frame's main world, or in the named isolated world. */
  async #evaluate<T = unknown>(frameId: string, expression: string, world?: string): Promise<T> {
    let contextId: number | undefined;
    for (const [id, info] of this.#contexts) {
      if (info.frameId !== frameId) continue;
      if (world === undefined ? info.isDefault : info.name === world) contextId = id;
    }
    if (contextId === undefined) throw new Error(`No JavaScript context for frame ${frameId}.`);
    const result = await this.#send<{
      result: { value?: unknown };
      exceptionDetails?: ExceptionDetails;
    }>('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text);
    }
    return result.result.value as T;
  }

  #send<R = CdpObject>(method: string, params: CdpObject = {}): Promise<R> {
    return this.#init.cdp.send<R>(method, params, { sessionId: this.#sessionId });
  }

  #on<P = CdpObject>(method: string, listener: (params: P) => void): void {
    this.#init.cdp.on<P>(method, (params, sessionId) => {
      if (sessionId === this.#sessionId) listener(params);
    });
  }

  async #within(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const timer = new AbortController();
    const timedOut = delay(ms, false, { signal: timer.signal }).catch(() => false);
    const settled = await Promise.race([promise.then(() => true), timedOut]);
    timer.abort();
    return settled;
  }
}

/** The bridge's transport: messages for the view go out through the host relay. */
class RelayTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  readonly #deliver: (json: string) => Promise<unknown>;
  readonly #record: (direction: AppRenderMessage['direction'], message: JSONRPCMessage) => void;

  constructor(
    deliver: (json: string) => Promise<unknown>,
    record: (direction: AppRenderMessage['direction'], message: JSONRPCMessage) => void,
  ) {
    this.#deliver = deliver;
    this.#record = record;
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.#record('host-to-view', message);
    await this.#deliver(JSON.stringify(message));
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }

  /** A message from the view (or the sandbox proxy), relayed by the host page. */
  receive(message: JSONRPCMessage): void {
    this.#record('view-to-host', message);
    this.onmessage?.(message);
  }
}

// ── CDP shapes and helpers ─────────────────────────────────────────────

interface ExceptionDetails {
  columnNumber?: number;
  exception?: { description?: string };
  executionContextId?: number;
  lineNumber?: number;
  text: string;
  url?: string;
}

interface RemoteObject {
  description?: string;
  type: string;
  unserializableValue?: string;
  value?: unknown;
}

interface ConsoleEvent {
  args: RemoteObject[];
  executionContextId?: number;
  stackTrace?: { callFrames: { url: string; lineNumber: number; columnNumber: number }[] };
  type: string;
}

interface CspIssue {
  code: string;
  details: {
    contentSecurityPolicyIssueDetails?: {
      blockedURL?: string;
      contentSecurityPolicyViolationType: string;
      sourceCodeLocation?: { url: string; lineNumber: number; columnNumber: number };
      violatedDirective: string;
    };
  };
}

function frameOrigin(element: string): string {
  return `(() => { const r = ${element}.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`;
}

function describeRemote(arg: RemoteObject): string {
  if (arg.value !== undefined)
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.unserializableValue ?? arg.type;
}

function location(
  url: string | undefined,
  line: number | undefined,
  column: number | undefined,
): Pick<AppRenderError, 'url' | 'line' | 'column'> {
  return {
    ...(url && { url }),
    ...(line !== undefined && line >= 0 && { line: line + 1 }),
    ...(column !== undefined && column >= 0 && { column: column + 1 }),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
