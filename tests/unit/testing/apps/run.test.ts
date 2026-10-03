/**
 * @fileoverview Tests for one headless MCP Apps host run (`runAppRender`), driven through
 * `renderAppTool` against the scripted browser, view, and server in `fake-host.ts`. The
 * host protocol is the real ext-apps `AppBridge`; the view is the real ext-apps `App`.
 * @module tests/unit/testing/apps/run.test
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type HostPages, startHostPages } from '@/testing/apps/host-pages.js';
import {
  type AppRenderReport,
  type RenderAppToolOptions,
  renderAppTool,
} from '@/testing/apps/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { exchange } from '../../../helpers/node-http.js';
import {
  ACTION_TOOL,
  APP_TOOL,
  browserModule,
  FAKE_EXECUTABLE,
  FAKE_PID,
  FAKE_PROFILE,
  FakeHost,
  type FakeHostOptions,
  installFakeHost,
  MAIN_FRAME,
  PLAIN_TOOL,
  SESSION,
  VIEW_HTML,
  VIEW_URI,
} from './fake-host.js';

vi.mock('@/testing/apps/browser.js', async () => (await import('./fake-host.js')).browserModule);
vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./fake-host.js')).clientOverrides,
}));
vi.mock('@modelcontextprotocol/client/stdio', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./fake-host.js')).stdioOverrides,
}));
vi.mock('@/testing/apps/host-pages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/testing/apps/host-pages.js')>();
  return { ...actual, startHostPages: vi.fn(actual.startHostPages) };
});

const SERVER = { command: 'fake-server', args: ['--stdio'] };

/** Render options over the test defaults; an explicit `undefined` drops that default. */
type Overrides = { [K in keyof RenderAppToolOptions]?: RenderAppToolOptions[K] | undefined };

/** Run with a fresh fake host. */
async function render(
  overrides: Overrides = {},
  hostOptions: FakeHostOptions = {},
): Promise<{ host: FakeHost; report: AppRenderReport }> {
  const host = installFakeHost(new FakeHost(hostOptions));
  const options = Object.fromEntries(
    Object.entries({
      server: SERVER,
      tool: APP_TOOL.name,
      arguments: { query: 'probe' },
      timeoutMs: 2_000,
      outDir,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as RenderAppToolOptions;
  const report = await renderAppTool(options);
  return { host, report };
}

/** The JSON-RPC methods in the report, in order, with their direction. */
function methods(report: AppRenderReport): string[] {
  return report.messages
    .filter((entry) => typeof entry.message.method === 'string')
    .map((entry) => `${entry.direction}:${entry.message.method as string}`);
}

/** The response the host sent for the view request with `method`. */
function responseTo(report: AppRenderReport, method: string): Record<string, unknown> | undefined {
  const request = report.messages.find(
    (entry) => entry.direction === 'view-to-host' && entry.message.method === method,
  );
  if (!request) return undefined;
  return report.messages.find(
    (entry) =>
      entry.direction === 'host-to-view' &&
      entry.message.method === undefined &&
      entry.message.id === request.message.id,
  )?.message;
}

async function hostPagesOfLastRun(): Promise<HostPages> {
  const results = vi.mocked(startHostPages).mock.results;
  return (await results.at(-1)?.value) as HostPages;
}

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'app-render-run-test-'));
  browserModule.discoverBrowser.mockClear();
  browserModule.launchBrowser.mockClear();
  vi.mocked(startHostPages).mockClear();
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('runAppRender — a view that initializes', () => {
  it('assembles the report from the bridge, the view, and the browser', async () => {
    const { host, report } = await render();

    expect(report).toMatchObject({
      tool: APP_TOOL.name,
      resourceUri: VIEW_URI,
      arguments: { query: 'probe' },
      initialized: true,
      appInfo: { name: 'fake-view', version: '2.0.0' },
      browser: { executable: FAKE_EXECUTABLE, pid: FAKE_PID, profileDir: FAKE_PROFILE },
      errors: [],
      cspViolations: [],
      steps: [],
      toolResult: { structuredContent: { tool: APP_TOOL.name, query: 'probe' } },
    });
    expect(report.failure).toBeUndefined();
    expect(report.toolError).toBeUndefined();
    expect(report.csp).toContain("connect-src 'self' https://api.example.test");
    expect(report.durationMs).toBeGreaterThan(0);
    expect(report.text).toContain('connected');
    expect(report.text).toContain('input: {"query":"probe"}');
    expect(report.text).toContain(`result: {"tool":"${APP_TOOL.name}","query":"probe"}`);

    expect(report.screenshots).toEqual([path.join(outDir, 'final.png')]);
    const png = await readFile(path.join(outDir, 'final.png'));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');

    expect(methods(report)).toEqual([
      'view-to-host:ui/initialize',
      'view-to-host:ui/notifications/initialized',
      'host-to-view:ui/notifications/tool-input',
      'host-to-view:ui/notifications/tool-result',
      'host-to-view:ui/resource-teardown',
    ]);
    const initialize = responseTo(report, 'ui/initialize') as { result?: Record<string, unknown> };
    expect(initialize.result).toMatchObject({
      hostInfo: { name: 'mcp-ts-core-app-host' },
      hostCapabilities: {
        serverTools: {},
        serverResources: {},
        sandbox: {
          csp: { connectDomains: ['https://api.example.test'] },
          permissions: { clipboardWrite: {} },
        },
      },
      hostContext: {
        theme: 'light',
        platform: 'web',
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        containerDimensions: { width: 720, maxHeight: 4000 },
        toolInfo: { tool: { name: APP_TOOL.name } },
      },
    });
    for (const entry of report.messages) expect(entry.at).toBeGreaterThanOrEqual(0);
    expect(
      report.messages.some((entry) =>
        String(entry.message.method).startsWith('ui/notifications/sandbox-'),
      ),
    ).toBe(false);

    expect(host.resourceReady).toEqual({
      html: VIEW_HTML,
      csp: { connectDomains: ['https://api.example.test'] },
      permissions: { clipboardWrite: {} },
    });
    expect(host.close).toHaveBeenCalledOnce();
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
  });

  it('advertises the MCP Apps extension and connects a stdio server as given', async () => {
    const { host } = await render({
      server: { command: 'node', args: ['server.js'], cwd: '/srv', env: { A: '1' } },
    });
    const [client] = host.clients;
    expect(client?.info).toMatchObject({ name: 'mcp-ts-core-app-host' });
    expect(client?.options).toEqual({
      capabilities: {
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
      },
    });
    expect(host.transports).toEqual([
      {
        kind: 'stdio',
        params: {
          command: 'node',
          stderr: 'pipe',
          args: ['server.js'],
          cwd: '/srv',
          env: { A: '1' },
        },
      },
    ]);
  });

  it('connects a bare stdio command with nothing but the command', async () => {
    const { host } = await render({ server: { command: 'fake-server' } });
    expect(host.transports).toEqual([
      { kind: 'stdio', params: { command: 'fake-server', stderr: 'pipe' } },
    ]);
  });

  it('connects a Streamable HTTP server, with and without headers', async () => {
    const { host } = await render({
      server: { url: 'http://127.0.0.1:3010/mcp', headers: { authorization: 'Bearer t' } },
    });
    expect(host.transports).toEqual([
      {
        kind: 'http',
        url: 'http://127.0.0.1:3010/mcp',
        options: { requestInit: { headers: { authorization: 'Bearer t' } } },
      },
    ]);

    const bare = await render({ server: { url: 'http://127.0.0.1:3011/mcp' } });
    expect(bare.host.transports).toEqual([
      { kind: 'http', url: 'http://127.0.0.1:3011/mcp', options: undefined },
    ]);
  });

  it('follows tools/list cursors to find the tool', async () => {
    const { host, report } = await render(
      {},
      { server: { toolPages: [[PLAIN_TOOL], [ACTION_TOOL], [APP_TOOL]] } },
    );
    expect(host.toolListCursors).toEqual([undefined, '1', '2']);
    expect(report.initialized).toBe(true);
  });

  it('drives the browser on its own session with the host page, relay, and theme', async () => {
    const { host } = await render({ host: { theme: 'dark', width: 480 } });
    const pages = await hostPagesOfLastRun();
    const sent = (method: string) => host.commands.filter((command) => command.method === method);

    expect(sent('Target.createTarget')).toEqual([
      { method: 'Target.createTarget', params: { url: 'about:blank' }, sessionId: undefined },
    ]);
    expect(sent('Target.attachToTarget')[0]?.params).toEqual({
      targetId: MAIN_FRAME,
      flatten: true,
    });
    expect(
      host.commands
        .filter((command) => !command.method.startsWith('Target.'))
        .every((command) => command.sessionId === SESSION),
    ).toBe(true);
    expect(sent('Page.navigate')[0]?.params).toEqual({ url: pages.hostUrl });
    expect(sent('Runtime.addBinding')[0]?.params).toEqual({
      name: '__mcpAppsHostReceive',
      executionContextName: '__mcpAppsHost',
    });
    expect(sent('Page.addScriptToEvaluateOnNewDocument')[0]?.params).toEqual({
      source: pages.relayScript,
      worldName: '__mcpAppsHost',
      runImmediately: true,
    });
    expect(sent('Emulation.setEmulatedMedia')[0]?.params).toEqual({
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    expect(sent('Emulation.setDeviceMetricsOverride')[0]?.params).toEqual({
      width: 480,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });
});

describe('runAppRender — host options', () => {
  it('streams growing argument prefixes as tool-input-partial before tool-input', async () => {
    const args = { query: 'a longer probe query to stream', limit: 10 };
    const { report } = await render({ arguments: args, host: { streamInput: true } });
    const toView = methods(report).filter((entry) =>
      entry.startsWith('host-to-view:ui/notifications/tool-'),
    );
    const partials = report.messages.filter(
      (entry) => entry.message.method === 'ui/notifications/tool-input-partial',
    );
    expect(partials.length).toBeGreaterThan(0);
    expect(toView.indexOf('host-to-view:ui/notifications/tool-input')).toBe(partials.length);
    for (const partial of partials) {
      const sent = (partial.message.params as { arguments: unknown }).arguments;
      expect(sent).toBeTypeOf('object');
      expect(sent).not.toEqual(args);
    }
    expect(report.text).toContain(`partials: ${partials.length}`);
  });

  it('passes styles, locale, time zone, display modes, and a fixed height to the view', async () => {
    const { host, report } = await render({
      host: {
        theme: 'dark',
        width: 640,
        height: 1200,
        styles: { '--color-text-primary': '#eee' },
        locale: 'de-DE',
        timeZone: 'Europe/Berlin',
        displayMode: 'pip',
        availableDisplayModes: ['inline', 'pip'],
      },
    });
    const initialize = responseTo(report, 'ui/initialize') as { result: { hostContext: unknown } };
    expect(initialize.result.hostContext).toMatchObject({
      theme: 'dark',
      displayMode: 'pip',
      availableDisplayModes: ['inline', 'pip'],
      containerDimensions: { width: 640, height: 1200 },
      styles: { variables: { '--color-text-primary': '#eee' } },
      locale: 'de-DE',
      timeZone: 'Europe/Berlin',
    });
    const pages = vi.mocked(startHostPages).mock.calls.at(-1);
    expect(pages?.[1]).toEqual({
      allow: 'clipboard-write',
      width: 640,
      height: 1200,
      background: '#1f1f1f',
    });
    const viewport = host.commands.find(
      (command) => command.method === 'Emulation.setDeviceMetricsOverride',
    );
    expect(viewport?.params).toMatchObject({ width: 640, height: 1200 });
  });

  it('follows the view size reports when the host height is not fixed', async () => {
    const { host, report } = await render({
      steps: [{ click: '#grow' }, { click: '#shrink' }, { click: '#widen' }],
    });
    expect(report.steps.every((step) => step.ok)).toBe(true);
    expect(report.size).toEqual({ width: 900 });
    expect(host.resizes).toEqual([1601, 600]);
    const viewports = host.commands
      .filter((command) => command.method === 'Emulation.setDeviceMetricsOverride')
      .map((command) => command.params.height);
    expect(viewports).toEqual([900, 1601]);
    expect(methods(report).filter((entry) => entry.endsWith('size-changed'))).toHaveLength(3);
  });

  it('caps a follow-up resize at the maximum height', async () => {
    const { host, report } = await render({}, { initialSize: { height: 9000 } });
    expect(report.size).toEqual({ height: 9000 });
    expect(host.resizes).toEqual([4000]);
  });

  it('keeps a fixed host height when the view reports its size', async () => {
    const { host, report } = await render(
      { host: { height: 300 } },
      { initialSize: { height: 2000 } },
    );
    expect(report.size).toEqual({ height: 2000 });
    expect(host.resizes).toEqual([]);
  });

  it('writes screenshots to a fresh temp directory when no outDir is given', async () => {
    const { report } = await render({ outDir: undefined });
    const [shot] = report.screenshots;
    expect(path.dirname(shot ?? '')).toMatch(
      new RegExp(`^${os.tmpdir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}.*mcp-app-render-`),
    );
    expect(existsSync(shot ?? '')).toBe(true);
    await rm(path.dirname(shot ?? ''), { recursive: true, force: true });
  });

  it('defaults the arguments, the timeout, and a waitFor deadline', async () => {
    const { report } = await render({
      arguments: undefined,
      timeoutMs: undefined,
      steps: [{ waitFor: '#status' }],
    });
    expect(report.arguments).toEqual({});
    expect(report.text).toContain('input: {}');
    expect(report.steps).toEqual([{ step: { waitFor: '#status' }, ok: true }]);
  });

  it('finishes the report when closing the client fails', async () => {
    const { host, report } = await render(
      {},
      { server: { closeError: new Error('already closed') } },
    );
    expect(report.initialized).toBe(true);
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
  });

  it('waits up to a second for frames that never paint, then carries on', async () => {
    const { report } = await render({}, { framesNeverPaint: true });
    expect(report.initialized).toBe(true);
    expect(report.failure).toBeUndefined();
  });
});

describe('runAppRender — steps', () => {
  it('clicks through both frame offsets, then screenshots under sanitized names', async () => {
    const { host, report } = await render({
      steps: [{ click: '#action' }, { screenshot: 'after click!' }, { screenshot: '' }],
    });
    expect(host.clicked).toEqual(['#action']);
    const presses = host.commands.filter(
      (command) => command.method === 'Input.dispatchMouseEvent',
    );
    expect(presses.map((command) => command.params.type)).toEqual([
      'mousePressed',
      'mouseReleased',
    ]);
    expect(report.steps).toEqual([
      { step: { click: '#action' }, ok: true },
      {
        step: { screenshot: 'after click!' },
        ok: true,
        screenshot: path.join(outDir, 'after-click-.png'),
      },
      { step: { screenshot: '' }, ok: true, screenshot: path.join(outDir, 'screenshot.png') },
    ]);
    expect(report.screenshots).toEqual([
      path.join(outDir, 'after-click-.png'),
      path.join(outDir, 'screenshot.png'),
      path.join(outDir, 'final.png'),
    ]);
    expect(host.toolCalls).toContainEqual(
      expect.objectContaining({ name: ACTION_TOOL.name, arguments: { clicks: 1 } }),
    );
    expect(responseTo(report, 'tools/call')).toMatchObject({
      result: { structuredContent: { echoed: 1 } },
    });
  });

  it('fills an input, waits for what it reveals, and evaluates in the view', async () => {
    const { host, report } = await render(
      {
        steps: [
          { fill: '#name', value: 'Ada' },
          { waitFor: '#echo', timeoutMs: 2_000 },
          { evaluate: 'name value' },
        ],
      },
      {
        evaluate: (expression, fake) =>
          expression === 'name value' ? fake.view?.elements.get('#name')?.value : undefined,
      },
    );
    expect(host.commands.find((command) => command.method === 'Input.insertText')?.params).toEqual({
      text: 'Ada',
    });
    expect(report.steps).toEqual([
      { step: { fill: '#name', value: 'Ada' }, ok: true },
      { step: { waitFor: '#echo', timeoutMs: 2_000 }, ok: true },
      { step: { evaluate: 'name value' }, ok: true, value: 'Ada' },
    ]);
    expect(report.text).toContain('echo: Ada');
  });

  it('records a failing step and keeps running the rest', async () => {
    const { report } = await render(
      {
        steps: [
          { click: '#missing' },
          { fill: '#missing', value: 'x' },
          { waitFor: '#never', timeoutMs: 120 },
          { evaluate: 'throw please' },
          { click: '#action' },
        ],
      },
      {
        evaluate: (expression) => {
          if (expression === 'throw please') throw new Error('ReferenceError: nope is not defined');
          return;
        },
      },
    );
    expect(report.steps.map((step) => [step.ok, step.error])).toEqual([
      [false, 'No element matches #missing'],
      [false, 'No element matches #missing'],
      [false, 'Timed out waiting for #never'],
      [false, 'ReferenceError: nope is not defined'],
      [true, undefined],
    ]);
    expect(report.failure).toBeUndefined();
  });

  it('acknowledges the requests that need a user or a model', async () => {
    const { report } = await render({
      host: { availableDisplayModes: ['inline', 'fullscreen'] },
      steps: [
        { click: '#message' },
        { click: '#link' },
        { click: '#download' },
        { click: '#context' },
        { click: '#fullscreen' },
        { click: '#pip' },
      ],
    });
    for (const method of [
      'ui/message',
      'ui/open-link',
      'ui/download-file',
      'ui/update-model-context',
    ]) {
      expect(responseTo(report, method), method).toMatchObject({ result: {} });
    }
    const modes = report.messages
      .filter((entry) => entry.direction === 'host-to-view')
      .map((entry) => (entry.message.result as { mode?: string } | undefined)?.mode)
      .filter(Boolean);
    expect(modes).toEqual(['fullscreen', 'fullscreen']);
    const message = report.messages.find((entry) => entry.message.method === 'ui/message');
    expect(message?.message.params).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello host' }],
    });
  });

  it('keeps the display mode when the requested one is not offered', async () => {
    const { report } = await render({ steps: [{ click: '#fullscreen' }] });
    expect(responseTo(report, 'ui/request-display-mode')).toMatchObject({
      result: { mode: 'inline' },
    });
  });

  it('forwards resource reads and lists from the view to the server', async () => {
    const { report } = await render({
      steps: [{ click: '#read' }, { click: '#list' }, { click: '#templates' }],
    });
    expect(responseTo(report, 'resources/read')).toMatchObject({
      result: { contents: [{ uri: VIEW_URI, text: VIEW_HTML }] },
    });
    expect(responseTo(report, 'resources/list')).toMatchObject({
      result: { resources: [{ uri: VIEW_URI }] },
    });
    expect(responseTo(report, 'resources/templates/list')).toMatchObject({
      result: { resourceTemplates: [{ uriTemplate: 'ui://fake/{id}' }] },
    });
  });

  it('refuses a view tools/call to a tool whose visibility excludes the app', async () => {
    const { host, report } = await render({
      steps: [{ click: '#model-only' }, { click: '#plain' }],
    });
    const refused = responseTo(report, 'tools/call') as {
      error?: { message: string };
      result?: unknown;
    };
    expect(JSON.stringify(refused)).toContain(
      'Tool model_only is not callable from an app: its _meta.ui.visibility is [\\"model\\"].',
    );
    expect(host.toolCalls.map((call) => call.name)).toEqual([APP_TOOL.name, PLAIN_TOOL.name]);
  });

  it('records uncaught exceptions, console errors, and CSP violations by frame', async () => {
    const { report } = await render(
      { steps: [{ evaluate: 'diagnostics' }, { click: '#throw' }] },
      {
        evaluate: (expression, fake) => {
          if (expression === 'diagnostics') fake.emitDiagnostics();
          return 'emitted';
        },
      },
    );
    expect(report.errors).toEqual([
      {
        source: 'exception',
        frame: 'view',
        message: 'TypeError: view broke',
        url: 'about:blank',
        line: 10,
        column: 1,
      },
      { source: 'exception', frame: 'sandbox', message: 'Uncaught SyntaxError' },
      { source: 'exception', frame: 'host', message: 'host error' },
      { source: 'exception', frame: 'unknown', message: 'other frame' },
      { source: 'exception', frame: 'unknown', message: 'no context' },
      { source: 'exception', frame: 'unknown', message: 'unknown context' },
      {
        source: 'console',
        frame: 'view',
        message: 'failed: 3 {"a":1} Error: inner NaN undefined',
        url: 'about:blank',
        line: 3,
        column: 5,
      },
      { source: 'console', frame: 'sandbox', message: 'assertion failed' },
      { source: 'exception', frame: 'unknown', message: 'after destroy' },
      {
        source: 'exception',
        frame: 'view',
        message: 'Error: thrown on click',
        url: 'about:blank',
        line: 42,
        column: 7,
      },
    ]);
    expect(report.cspViolations).toEqual([
      {
        directive: 'img-src',
        blockedURI: 'https://undeclared.example.test/pixel.png',
        violationType: 'kURLViolation',
        sourceURL: 'about:blank',
        line: 5,
      },
      { directive: 'script-src', blockedURI: 'eval', violationType: 'kEvalViolation' },
      { directive: 'script-src', blockedURI: 'inline', violationType: 'kInlineViolation' },
      { directive: 'script-src', blockedURI: 'wasm-eval', violationType: 'kWasmEvalViolation' },
      {
        directive: 'require-trusted-types-for',
        blockedURI: 'kTrustedTypesSinkViolation',
        violationType: 'kTrustedTypesSinkViolation',
      },
    ]);
  });
});

describe('runAppRender — failures after the browser is reached', () => {
  it('reports a view that never initializes, runs no steps, and still captures the page', async () => {
    const { host, report } = await render(
      { timeoutMs: 150, steps: [{ click: '#action' }] },
      { view: 'silent' },
    );
    expect(report.initialized).toBe(false);
    expect(report.failure).toBe('The view did not complete ui/initialize within 150 ms.');
    expect(report.steps).toEqual([]);
    expect(report.text).toBe('');
    expect(report.screenshots).toEqual([path.join(outDir, 'final.png')]);
    expect(methods(report)).toEqual([]);
    expect(host.close).toHaveBeenCalledOnce();
  });

  it('skips the text and screenshot when the view frame never appears', async () => {
    const { report } = await render({ timeoutMs: 100 }, { view: 'no-frames' });
    expect(report.failure).toBe('The view did not complete ui/initialize within 100 ms.');
    expect(report.screenshots).toEqual([]);
    expect(report.text).toBe('');
  });

  it('names the delivery failure when the view HTML never reaches the sandbox', async () => {
    const { report } = await render(
      { timeoutMs: 150 },
      { failDeliveries: ['ui/notifications/sandbox-resource-ready'] },
    );
    expect(report.initialized).toBe(false);
    expect(report.failure).toMatch(
      /^Could not deliver the view HTML: delivery of ui\/notifications\/sandbox-resource-ready failed/,
    );
  });

  it('delivers tool-cancelled with the reason when the tool call fails', async () => {
    const { report } = await render(
      {},
      {
        server: {
          callTool: (params) => {
            if (params.name === APP_TOOL.name) throw new Error('upstream down');
            return;
          },
        },
      },
    );
    expect(report.toolError).toBe('upstream down');
    expect(report.toolResult).toBeUndefined();
    const cancelled = report.messages.find(
      (entry) => entry.message.method === 'ui/notifications/tool-cancelled',
    );
    expect(cancelled?.direction).toBe('host-to-view');
    expect(cancelled?.message.params).toEqual({ reason: 'upstream down' });
    expect(methods(report)).not.toContain('host-to-view:ui/notifications/tool-result');
    expect(report.text).toContain('cancelled: upstream down');
  });

  it('cancels with a generic reason when the tool call yields nothing', async () => {
    const { report } = await render({}, { server: { callTool: () => undefined } });
    expect(report.toolError).toBeUndefined();
    const cancelled = report.messages.find(
      (entry) => entry.message.method === 'ui/notifications/tool-cancelled',
    );
    expect(cancelled?.message.params).toEqual({ reason: 'The tool call failed.' });
  });

  it('reports a failed screenshot, both as a step and as the final capture', async () => {
    const { report } = await render(
      { steps: [{ screenshot: 'mid' }] },
      { failCommands: { 'Page.captureScreenshot': 'Unable to capture' } },
    );
    expect(report.steps).toEqual([
      {
        step: { screenshot: 'mid' },
        ok: false,
        error: 'Page.captureScreenshot: Unable to capture',
      },
    ]);
    expect(report.failure).toBe(
      'Final screenshot failed: Page.captureScreenshot: Unable to capture',
    );
    expect(report.screenshots).toEqual([]);
  });

  it('degrades when the page loses its execution contexts mid-run', async () => {
    const { host, report } = await render(
      { steps: [{ evaluate: 'clear' }, { evaluate: 'anything' }, { click: '#action' }] },
      {
        evaluate: (expression, fake) => {
          if (expression === 'clear') {
            fake.clearContexts();
            void fake.view?.app.sendSizeChanged({ height: 2000 });
          }
          return 1;
        },
      },
    );
    expect(report.steps.map((step) => [step.ok, step.error])).toEqual([
      [true, undefined],
      [false, `No JavaScript context for frame frame-view.`],
      [false, `No JavaScript context for frame frame-view.`],
    ]);
    expect(report.size).toEqual({ height: 2000 });
    expect(host.resizes).toEqual([]);
    expect(report.text).toBe('');
    expect(report.failure).toBe(
      `Final screenshot failed: No JavaScript context for frame ${MAIN_FRAME}.`,
    );
  });

  it('reports a page exception that carries only text', async () => {
    const { report } = await render(
      { steps: [{ evaluate: 'throw a string' }] },
      {
        evaluate: () => {
          throw 'not an error object';
        },
      },
    );
    expect(report.steps[0]).toMatchObject({ ok: false, error: 'Uncaught not an error object' });
  });

  it('runs the protocol but no frame steps when the frames are never reported', async () => {
    const { report } = await render(
      { steps: [{ click: '#action' }, { fill: '#name', value: 'x' }, { evaluate: '1' }] },
      { view: 'frameless' },
    );
    expect(report.initialized).toBe(true);
    expect(methods(report)).toContain('host-to-view:ui/notifications/tool-result');
    expect(report.steps.map((step) => step.error)).toEqual([
      'The view frame was never created.',
      'The view frame was never created.',
      'The view frame was never created.',
    ]);
    expect(report.text).toBe('');
    expect(report.screenshots).toEqual([]);
  });

  it('turns a CDP failure into the report failure and still tears everything down', async () => {
    const { host, report } = await render(
      {},
      { failCommands: { 'Target.createTarget': 'Target crashed' } },
    );
    expect(report.failure).toBe('Target.createTarget: Target crashed');
    expect(report.initialized).toBe(false);
    expect(host.close).toHaveBeenCalledOnce();
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
    const pages = await hostPagesOfLastRun();
    await expect(
      exchange(Number(new URL(pages.hostUrl).port), { method: 'GET', path: '/' }),
    ).rejects.toThrow();
  });

  it('closes the host pages and the client when closing the browser fails, then rejects with that error', async () => {
    const closeError = new Error('the profile directory is busy');
    const host = installFakeHost(new FakeHost({ closeError }));
    await expect(
      renderAppTool({ server: SERVER, tool: APP_TOOL.name, outDir, timeoutMs: 2_000 }),
    ).rejects.toBe(closeError);
    expect(host.close).toHaveBeenCalledOnce();
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
    const pages = await hostPagesOfLastRun();
    await expect(
      exchange(Number(new URL(pages.hostUrl).port), { method: 'GET', path: '/' }),
    ).rejects.toThrow();
  });
});

describe('runAppRender — setup failures', () => {
  async function setupFailure(
    options: Partial<Parameters<typeof renderAppTool>[0]>,
    hostOptions: FakeHostOptions,
  ): Promise<{ err: Error & { data?: Record<string, unknown> }; host: FakeHost }> {
    const host = installFakeHost(new FakeHost(hostOptions));
    const err = await renderAppTool({
      server: SERVER,
      tool: APP_TOOL.name,
      outDir,
      ...options,
    }).then(
      () => {
        throw new Error('Expected renderAppTool to reject.');
      },
      (error: unknown) => error as Error & { data?: Record<string, unknown> },
    );
    return { err, host };
  }

  it('rejects a tool the server does not have, naming the ones it does', async () => {
    const { err, host } = await setupFailure({ tool: 'nope' }, {});
    expect(err).toBeMcpError(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe(
      'The server has no tool named nope. Its tools: app_probe, app_action, model_only, plain_tool.',
    );
    expect(err.data).toEqual({ reason: 'tool_not_found' });
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
    expect(browserModule.launchBrowser).not.toHaveBeenCalled();
  });

  it('says so when the server lists no tools', async () => {
    const { err } = await setupFailure({ tool: 'nope' }, { server: { toolPages: [[]] } });
    expect(err.message).toBe('The server has no tool named nope. Its tools: (none).');
  });

  it('rejects a tool without a UI resource', async () => {
    const { err } = await setupFailure({ tool: PLAIN_TOOL.name }, {});
    expect(err).toBeMcpError(JsonRpcErrorCode.ValidationError);
    expect(err.message).toBe(
      'Tool plain_tool declares no UI resource (_meta.ui.resourceUri), so there is no view to render.',
    );
    expect(err.data).toEqual({ reason: 'no_ui_resource' });
  });

  it('rejects a UI resource that cannot be read or has no contents', async () => {
    const unreadable = await setupFailure(
      {},
      { server: { resources: { [VIEW_URI]: new Error('boom') } } },
    );
    expect(unreadable.err).toBeMcpError(JsonRpcErrorCode.NotFound);
    expect(unreadable.err.message).toBe(`Could not read the tool's UI resource ${VIEW_URI}: boom`);
    expect(unreadable.err.data).toEqual({ reason: 'ui_resource_unreadable' });

    const empty = await setupFailure(
      {},
      { server: { resources: { [VIEW_URI]: { contents: [] } } } },
    );
    expect(empty.err.message).toBe(`The UI resource ${VIEW_URI} returned no contents.`);
    expect(empty.err.data).toEqual({ reason: 'ui_resource_unreadable' });
  });

  it('rejects a UI resource whose csp holds an unsafe entry, before launching', async () => {
    const { err, host } = await setupFailure(
      {},
      {
        server: {
          resources: {
            [VIEW_URI]: {
              contents: [
                {
                  uri: VIEW_URI,
                  text: VIEW_HTML,
                  _meta: { ui: { csp: { resourceDomains: ["'unsafe-eval'"] } } },
                },
              ],
            },
          },
        },
      },
    );
    expect(err).toBeMcpError(JsonRpcErrorCode.ValidationError);
    expect(err.data).toEqual({ reason: 'invalid_csp_entry', field: 'resourceDomains' });
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
  });

  it('reports an unreachable server with the last line of its stderr', async () => {
    const withStderr = await setupFailure(
      {},
      {
        server: {
          connectError: new Error('Connection closed'),
          stderr: 'booting\nfatal: missing API key\n',
        },
      },
    );
    expect(withStderr.err).toBeMcpError(JsonRpcErrorCode.ServiceUnavailable);
    expect(withStderr.err.message).toBe(
      'Could not connect to the MCP server (fake-server --stdio): Connection closed Server stderr: fatal: missing API key',
    );
    expect(withStderr.err.data).toEqual({ reason: 'server_unreachable' });
    expect(withStderr.host.clients[0]?.close).toHaveBeenCalledOnce();

    const http = await setupFailure(
      { server: { url: 'http://127.0.0.1:9/mcp' } },
      { server: { connectError: new Error('fetch failed') } },
    );
    expect(http.err.message).toBe(
      'Could not connect to the MCP server (http://127.0.0.1:9/mcp): fetch failed',
    );
  });

  it('closes the host pages and the client when the browser fails to launch', async () => {
    const { err, host } = await setupFailure(
      {},
      { launchError: new Error('The browser at x failed to start') },
    );
    expect(err.message).toBe('The browser at x failed to start');
    expect(host.clients[0]?.close).toHaveBeenCalledOnce();
    const pages = await hostPagesOfLastRun();
    await expect(
      exchange(Number(new URL(pages.sandboxOrigin).port), { method: 'GET', path: '/sandbox.html' }),
    ).rejects.toThrow();
  });

  it('fails on browser discovery before contacting the server, passing the explicit path', async () => {
    browserModule.discoverBrowser.mockRejectedValueOnce(
      new Error('The browser path /x is not executable.'),
    );
    const { err, host } = await setupFailure({ browserPath: '/x' }, {});
    expect(err.message).toBe('The browser path /x is not executable.');
    expect(browserModule.discoverBrowser).toHaveBeenLastCalledWith('/x');
    expect(host.clients).toEqual([]);
  });

  it('reads a blob resource and applies the restrictive default with no _meta.ui', async () => {
    const html = '<!doctype html><p>from a blob</p>';
    const { host, report } = await render(
      {},
      {
        server: {
          resources: {
            [VIEW_URI]: {
              contents: [{ uri: VIEW_URI, blob: Buffer.from(html).toString('base64') }],
            },
          },
        },
      },
    );
    expect(host.resourceReady).toEqual({ html });
    expect(vi.mocked(startHostPages).mock.calls.at(-1)?.[1]).toMatchObject({ allow: '' });
    expect(report.csp).toContain("connect-src 'none'");
    const initialize = responseTo(report, 'ui/initialize') as {
      result: { hostCapabilities: { sandbox: unknown } };
    };
    expect(initialize.result.hostCapabilities.sandbox).toEqual({});
  });
});
