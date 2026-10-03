/**
 * @fileoverview A scripted stand-in for everything `runAppRender` talks to, so the run can
 * be driven in the unit lane with no browser and no server process.
 *
 * - **Browser:** `FakeCdp` answers every CDP command the run sends and emits the frame,
 *   execution-context, binding, exception, console, and `Audits.issueAdded` events it
 *   listens for. It plays the sandbox proxy: `Page.navigate` attaches the sandbox and view
 *   frames and announces `sandbox-proxy-ready`; `__mcpAppsHostSend(...)` evaluations carry
 *   host messages to the view.
 * - **View:** the real ext-apps `App`, connected over a transport whose outgoing messages
 *   become `Runtime.bindingCalled` events. A small element model answers the click, fill,
 *   waitFor, and text expressions the run evaluates in the view frame.
 * - **Server:** `FakeClient` and the two client transports replace the
 *   `@modelcontextprotocol/client` peer with scripted tools, resources, and tool results.
 *
 * Tests install one `FakeHost` per run with `installFakeHost` and mock `./browser.js`,
 * `@modelcontextprotocol/client`, and `@modelcontextprotocol/client/stdio` with the
 * modules exported here.
 * @module tests/unit/testing/apps/fake-host
 */

import { PassThrough } from 'node:stream';

import type {
  CallToolResult,
  JSONRPCMessage,
  ReadResourceResult,
  Tool,
  Transport,
} from '@modelcontextprotocol/client';
import { App } from '@modelcontextprotocol/ext-apps';
import { vi } from 'vitest';

import type { CdpObject } from '@/testing/apps/cdp-pipe.js';
import {
  HOST_WORLD,
  RECEIVE_BINDING,
  RESIZE_FUNCTION,
  SANDBOX_FRAME_ID,
  SEND_FUNCTION,
} from '@/testing/apps/host-pages.js';

export const SESSION = 'session-page';
export const MAIN_FRAME = 'frame-main';
export const SANDBOX_FRAME = 'frame-sandbox';
export const VIEW_FRAME = 'frame-view';
export const OTHER_FRAME = 'frame-other';
export const FAKE_PID = 4242;
export const FAKE_PROFILE = '/tmp/mcp-apps-host-fake-profile';
export const FAKE_EXECUTABLE = '/fake/chrome-headless-shell';
export const VIEW_URI = 'ui://fake/view.html';
export const VIEW_HTML = '<!doctype html><html><body><p>fake view</p></body></html>';
/** A 1×1 transparent PNG. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Where the sandbox iframe sits in the host page, and the view iframe in the sandbox. */
const SANDBOX_ORIGIN = { x: 8, y: 12 };
const VIEW_ORIGIN = { x: 2, y: 3 };

const CONTEXTS = {
  main: 1,
  hostWorld: 2,
  sandbox: 3,
  view: 4,
  other: 5,
} as const;

export const APP_TOOL: Tool = {
  name: 'app_probe',
  inputSchema: { type: 'object' },
  _meta: { ui: { resourceUri: VIEW_URI, visibility: ['model', 'app'] } },
};
export const ACTION_TOOL: Tool = {
  name: 'app_action',
  inputSchema: { type: 'object' },
  _meta: { ui: { visibility: ['app'] } },
};
export const MODEL_ONLY_TOOL: Tool = {
  name: 'model_only',
  inputSchema: { type: 'object' },
  _meta: { ui: { visibility: ['model'] } },
};
export const PLAIN_TOOL: Tool = { name: 'plain_tool', inputSchema: { type: 'object' } };

// ── The server behind the client peer ─────────────────────────────────

/** What the scripted server answers. */
export interface ServerScript {
  callTool?: (params: {
    arguments?: Record<string, unknown>;
    name: string;
  }) => Promise<CallToolResult | undefined> | CallToolResult | undefined;
  /** `client.close` rejects with this. */
  closeError?: Error;
  /** `client.connect` rejects with this, after writing `stderr`. */
  connectError?: Error;
  resources?: Record<string, ReadResourceResult | Error>;
  stderr?: string;
  /** `tools/list` pages; a page is followed by a cursor while more remain. */
  toolPages?: Tool[][];
}

function defaultCallTool(params: {
  arguments?: Record<string, unknown>;
  name: string;
}): Promise<CallToolResult> {
  const args = params.arguments ?? {};
  if (params.name === ACTION_TOOL.name) {
    return new Promise((resolve) =>
      setTimeout(() => resolve({ content: [], structuredContent: { echoed: args.clicks } }), 150),
    );
  }
  return Promise.resolve({
    content: [{ type: 'text', text: `${params.name} ok` }],
    structuredContent: { tool: params.name, ...args },
  });
}

const defaultResources = (): Record<string, ReadResourceResult> => ({
  [VIEW_URI]: {
    contents: [
      {
        uri: VIEW_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: VIEW_HTML,
        _meta: {
          ui: {
            csp: { connectDomains: ['https://api.example.test'] },
            permissions: { clipboardWrite: {} },
          },
        },
      },
    ],
  },
});

/** The transport `StdioClientTransport` is replaced with. */
export class FakeStdioClientTransport {
  readonly stderr = new PassThrough();
  constructor(readonly params: Record<string, unknown>) {
    active().transports.push({ kind: 'stdio', params });
  }
}

/** The transport `StreamableHTTPClientTransport` is replaced with. */
export class FakeStreamableHTTPClientTransport {
  constructor(
    readonly url: URL,
    readonly options?: Record<string, unknown>,
  ) {
    active().transports.push({ kind: 'http', url: url.href, options });
  }
}

/** The client `Client` is replaced with: answers from the active host's `ServerScript`. */
export class FakeClient {
  readonly host = active();
  readonly close = vi.fn(async () => {
    if (this.host.server.closeError) throw this.host.server.closeError;
  });

  constructor(
    readonly info: { name: string; version: string },
    readonly options: Record<string, unknown>,
  ) {
    this.host.clients.push(this);
  }

  get #script(): ServerScript {
    return this.host.server;
  }

  async connect(transport: unknown): Promise<void> {
    const { stderr, connectError } = this.#script;
    if (stderr && transport instanceof FakeStdioClientTransport) {
      transport.stderr.write(stderr);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (connectError) throw connectError;
  }

  async listTools(params: { cursor?: string }) {
    const pages = this.#script.toolPages ?? [[APP_TOOL, ACTION_TOOL, MODEL_ONLY_TOOL, PLAIN_TOOL]];
    const index = params.cursor ? Number(params.cursor) : 0;
    this.host.toolListCursors.push(params.cursor);
    const next = index + 1 < pages.length ? String(index + 1) : undefined;
    return { tools: pages[index] ?? [], ...(next && { nextCursor: next }) };
  }

  async readResource(params: { uri: string }): Promise<ReadResourceResult> {
    const resources = this.#script.resources ?? defaultResources();
    const found = resources[params.uri];
    if (found instanceof Error) throw found;
    if (!found) throw new Error(`Resource ${params.uri} not found`);
    return found;
  }

  async callTool(params: { arguments?: Record<string, unknown>; name: string }) {
    this.host.toolCalls.push(params);
    return (this.#script.callTool ?? defaultCallTool)(params);
  }

  async listResources() {
    return { resources: [{ uri: VIEW_URI, name: 'fake-view' }] };
  }

  async listResourceTemplates() {
    return { resourceTemplates: [{ uriTemplate: 'ui://fake/{id}', name: 'fake-template' }] };
  }
}

// ── The view ──────────────────────────────────────────────────────────

/** A scripted element: its text, an input value, and what a click or input does. */
interface FakeElement {
  onClick?: () => unknown;
  onInput?: () => void;
  text: string;
  value?: string;
}

/** How the view behaves once the sandbox delivers its HTML. */
export type ViewMode =
  /** The ext-apps `App` connects and completes `ui/initialize`. */
  | 'app'
  /** The frames exist but the view never connects. */
  | 'silent'
  /** `Page.navigate` attaches no frames at all. */
  | 'no-frames'
  /** The view connects, but the sandbox and view frames are never reported. */
  | 'frameless';

class ViewTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];

  constructor(readonly toHost: (message: JSONRPCMessage) => void) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.toHost(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

/** The view frame: the ext-apps `App` plus an element model the run's expressions read. */
export class FakeView {
  readonly app = new App({ name: 'fake-view', version: '2.0.0' }, {}, { autoResize: false });
  readonly transport: ViewTransport;
  readonly elements = new Map<string, FakeElement>();
  /** Results and errors of the view's own requests, keyed by the control that sent them. */
  readonly outcomes = new Map<string, unknown>();
  focused: string | undefined;
  #partials = 0;
  #clicks = 0;

  constructor(readonly host: FakeHost) {
    this.transport = new ViewTransport((message) => host.fromView(message));
    const app = this.app;
    this.#add('#status', 'loading');
    this.#add('#partials', 'partials: 0');
    this.#add('#input', 'input: (none)');
    this.#add('#result', 'result: (none)');
    app.ontoolinputpartial = () => {
      this.#set('#partials', `partials: ${++this.#partials}`);
    };
    app.ontoolinput = ({ arguments: args }) => {
      this.#set('#input', `input: ${JSON.stringify(args)}`);
    };
    app.ontoolresult = (result) => {
      this.#set('#result', `result: ${JSON.stringify(result.structuredContent)}`);
    };
    app.ontoolcancelled = ({ reason }) => {
      this.#set('#result', `cancelled: ${reason}`);
    };
    const request = (id: string, send: () => Promise<unknown>) =>
      this.#add(id, id, {
        onClick: () =>
          send().then(
            (result) => this.outcomes.set(id, result),
            (err: unknown) => this.outcomes.set(id, err),
          ),
      });
    request('#action', () =>
      app.callServerTool({ name: ACTION_TOOL.name, arguments: { clicks: ++this.#clicks } }),
    );
    request('#model-only', () => app.callServerTool({ name: MODEL_ONLY_TOOL.name, arguments: {} }));
    request('#plain', () => app.callServerTool({ name: PLAIN_TOOL.name, arguments: {} }));
    request('#message', () =>
      app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello host' }] }),
    );
    request('#link', () => app.openLink({ url: 'https://example.com/docs' }));
    request('#download', () =>
      app.downloadFile({
        contents: [{ type: 'resource_link', uri: 'https://example.com/f.txt', name: 'f.txt' }],
      }),
    );
    request('#context', () => app.updateModelContext({ structuredContent: { picked: 1 } }));
    request('#fullscreen', () => app.requestDisplayMode({ mode: 'fullscreen' }));
    request('#pip', () => app.requestDisplayMode({ mode: 'pip' }));
    request('#read', () => app.readServerResource({ uri: VIEW_URI }));
    request('#list', () => app.listServerResources({}));
    request('#templates', () => this.raw('resources/templates/list'));
    request('#grow', () => app.sendSizeChanged({ width: 700, height: 1600.4 }));
    request('#shrink', () => app.sendSizeChanged({ height: 600 }));
    request('#widen', () => app.sendSizeChanged({ width: 900 }));
    this.#add('#throw', 'throw', {
      onClick: () =>
        host.emit('Runtime.exceptionThrown', {
          exceptionDetails: {
            text: 'Uncaught',
            exception: { description: 'Error: thrown on click' },
            executionContextId: CONTEXTS.view,
            url: 'about:blank',
            lineNumber: 41,
            columnNumber: 6,
          },
        }),
    });
    this.#add('#name', '', {
      value: '',
      onInput: () =>
        setTimeout(() => {
          this.#add('#echo', '');
          this.#set('#echo', `echo: ${this.elements.get('#name')?.value ?? ''}`);
        }, 120),
    });
  }

  /** Connect the App over the relay, then report a size when the scene asks for one. */
  async connect(): Promise<void> {
    await this.app.connect(this.transport);
    this.#set('#status', 'connected');
    if (this.host.options.initialSize)
      await this.app.sendSizeChanged(this.host.options.initialSize);
  }

  /** A host message, as the sandbox proxy would post it into the view. */
  deliver(message: JSONRPCMessage): void {
    setImmediate(() => this.transport.onmessage?.(message));
  }

  /** Send a raw JSON-RPC request and resolve with the host's response message. */
  raw(method: string, params: Record<string, unknown> = {}): Promise<JSONRPCMessage> {
    const id = `raw-${method}`;
    const answered = new Promise<JSONRPCMessage>((resolve) => {
      this.host.rawWaiters.set(id, resolve);
    });
    this.host.fromView({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    return answered;
  }

  get text(): string {
    return [...this.elements.values()]
      .map((element) => element.text)
      .filter(Boolean)
      .join('\n');
  }

  /** The point a click on `selector` targets, in view coordinates. */
  pointOf(selector: string): { x: number; y: number } | null {
    const index = [...this.elements.keys()].indexOf(selector);
    return index === -1 ? null : { x: 40, y: 20 + 30 * index };
  }

  /** Dispatch a click like a page does: the handler starts, the input event returns. */
  clickAt(x: number, y: number): void {
    for (const selector of this.elements.keys()) {
      const point = this.pointOf(selector);
      if (point?.x === x && point.y === y) {
        this.host.clicked.push(selector);
        void this.elements.get(selector)?.onClick?.();
        return;
      }
    }
    this.host.clicked.push(`(nothing at ${x},${y})`);
  }

  insertText(text: string): void {
    const element = this.focused ? this.elements.get(this.focused) : undefined;
    if (!element) return;
    element.value = text;
    element.onInput?.();
  }

  /** What an expression evaluated in the view frame returns; throws for an in-page error. */
  evaluate(expression: string): unknown {
    if (expression === 'document.body ? document.body.innerText : ""') return this.text;
    if (expression.includes('requestAnimationFrame')) {
      return this.host.options.framesNeverPaint ? new Promise(() => {}) : true;
    }
    const selector = selectorIn(expression);
    if (selector !== undefined && expression.includes('scrollIntoView'))
      return this.pointOf(selector);
    if (selector !== undefined && expression.includes('el.focus()')) {
      if (!this.elements.has(selector)) throw new Error(`No element matches ${selector}`);
      this.focused = selector;
      return true;
    }
    if (selector !== undefined && expression.startsWith('!!document.querySelector(')) {
      return this.elements.has(selector);
    }
    const custom = this.host.options.evaluate;
    if (custom) return custom(expression, this.host);
    throw new Error(`The fake view cannot evaluate ${expression}`);
  }

  #add(selector: string, text: string, extra: Omit<FakeElement, 'text'> = {}): void {
    if (!this.elements.has(selector)) this.elements.set(selector, { text, ...extra });
  }

  #set(selector: string, text: string): void {
    const element = this.elements.get(selector);
    if (element) element.text = text;
  }
}

function selectorIn(expression: string): string | undefined {
  const match = /document\.querySelector\(("(?:[^"\\]|\\.)*")\)/.exec(expression);
  return match?.[1] ? (JSON.parse(match[1]) as string) : undefined;
}

// ── The browser ───────────────────────────────────────────────────────

/** How one fake run behaves. */
export interface FakeHostOptions {
  /** The launched browser's `close()` rejects with this. */
  closeError?: Error;
  /** Answer `Runtime.evaluate` in the view frame for expressions the element model does not know. */
  evaluate?: (expression: string, host: FakeHost) => unknown;
  /** CDP methods that fail with a protocol error, and the message. */
  failCommands?: Record<string, string>;
  /** Host-world deliveries of these JSON-RPC methods fail in the page. */
  failDeliveries?: string[];
  /** The view's `requestAnimationFrame` evaluation never settles. */
  framesNeverPaint?: boolean;
  /** A size the view reports right after it initializes. */
  initialSize?: { height?: number; width?: number };
  /** `launchBrowser` rejects with this. */
  launchError?: Error;
  server?: ServerScript;
  view?: ViewMode;
}

type Listener = (params: CdpObject, sessionId: string | undefined) => void;

/** The CDP side of the fake browser, shaped like `CdpPipe` where the run uses it. */
export class FakeCdp {
  readonly #host: FakeHost;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(host: FakeHost) {
    this.#host = host;
  }

  on(method: string, listener: Listener): () => void {
    let set = this.#listeners.get(method);
    if (!set) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  emit(method: string, params: CdpObject, sessionId: string | undefined = SESSION): void {
    for (const listener of this.#listeners.get(method) ?? []) listener(params, sessionId);
  }

  async send<R = CdpObject>(
    method: string,
    params: CdpObject = {},
    options: { sessionId?: string | undefined } = {},
  ): Promise<R> {
    this.#host.commands.push({ method, params, sessionId: options.sessionId });
    const failure = this.#host.options.failCommands?.[method];
    if (failure) throw new Error(`${method}: ${failure}`);
    return (await this.#host.answer(method, params)) as R;
  }
}

/** One scripted browser, sandbox, view, and server for one `runAppRender`. */
export class FakeHost {
  readonly cdp: FakeCdp;
  readonly options: FakeHostOptions;
  readonly server: ServerScript;
  readonly commands: { method: string; params: CdpObject; sessionId: string | undefined }[] = [];
  readonly clients: FakeClient[] = [];
  readonly transports: Record<string, unknown>[] = [];
  readonly toolListCursors: (string | undefined)[] = [];
  readonly toolCalls: { arguments?: Record<string, unknown>; name: string }[] = [];
  readonly clicked: string[] = [];
  readonly resizes: number[] = [];
  readonly rawWaiters = new Map<string | number, (message: JSONRPCMessage) => void>();
  readonly close = vi.fn(async () => {
    if (this.options.closeError) throw this.options.closeError;
  });
  /** The `sandbox-resource-ready` params the sandbox received. */
  resourceReady: Record<string, unknown> | undefined;
  view: FakeView | undefined;

  constructor(options: FakeHostOptions = {}) {
    this.options = options;
    this.server = options.server ?? {};
    this.cdp = new FakeCdp(this);
  }

  /** What the mocked `launchBrowser` returns. */
  async launch(executable: string) {
    if (this.options.launchError) throw this.options.launchError;
    return {
      executable,
      profileDir: FAKE_PROFILE,
      process: { cdp: this.cdp, pid: FAKE_PID },
      close: this.close,
    };
  }

  emit(method: string, params: CdpObject, sessionId?: string): void {
    this.cdp.emit(method, params, sessionId ?? SESSION);
  }

  /** A message from the view or the sandbox, relayed through the host page's binding. */
  fromView(message: JSONRPCMessage): void {
    setImmediate(() =>
      this.emit('Runtime.bindingCalled', {
        name: RECEIVE_BINDING,
        payload: JSON.stringify(message),
        executionContextId: CONTEXTS.hostWorld,
      }),
    );
  }

  /** Detach every execution context, as a crashed or navigated-away page would. */
  clearContexts(): void {
    this.emit('Runtime.executionContextsCleared', {});
  }

  /** Emit one of every instrumentation event the run records or must ignore. */
  emitDiagnostics(): void {
    const exception = (details: CdpObject) =>
      this.emit('Runtime.exceptionThrown', { exceptionDetails: details });
    exception({
      text: 'Uncaught',
      exception: { description: 'TypeError: view broke' },
      executionContextId: CONTEXTS.view,
      url: 'about:blank',
      lineNumber: 9,
      columnNumber: 0,
    });
    exception({
      text: 'Uncaught SyntaxError',
      executionContextId: CONTEXTS.sandbox,
      lineNumber: -1,
    });
    exception({ text: 'host error', executionContextId: CONTEXTS.main });
    exception({ text: 'other frame', executionContextId: CONTEXTS.other });
    exception({ text: 'no context' });
    exception({ text: 'unknown context', executionContextId: 99 });
    this.emit('Runtime.consoleAPICalled', {
      type: 'error',
      executionContextId: CONTEXTS.view,
      args: [
        { type: 'string', value: 'failed:' },
        { type: 'number', value: 3 },
        { type: 'object', value: { a: 1 } },
        { type: 'object', description: 'Error: inner' },
        { type: 'number', unserializableValue: 'NaN' },
        { type: 'undefined' },
      ],
      stackTrace: { callFrames: [{ url: 'about:blank', lineNumber: 2, columnNumber: 4 }] },
    });
    this.emit('Runtime.consoleAPICalled', {
      type: 'assert',
      executionContextId: CONTEXTS.sandbox,
      args: [{ type: 'string', value: 'assertion failed' }],
    });
    this.emit('Runtime.consoleAPICalled', {
      type: 'log',
      executionContextId: CONTEXTS.view,
      args: [{ type: 'string', value: 'not an error' }],
    });
    const csp = (details: CdpObject | undefined, code = 'ContentSecurityPolicyIssue') =>
      this.emit('Audits.issueAdded', {
        issue: { code, details: details ? { contentSecurityPolicyIssueDetails: details } : {} },
      });
    csp({
      blockedURL: 'https://undeclared.example.test/pixel.png',
      violatedDirective: 'img-src',
      contentSecurityPolicyViolationType: 'kURLViolation',
      sourceCodeLocation: { url: 'about:blank', lineNumber: 4, columnNumber: 1 },
    });
    csp({
      violatedDirective: 'script-src',
      contentSecurityPolicyViolationType: 'kEvalViolation',
      sourceCodeLocation: { url: '', lineNumber: -1, columnNumber: 0 },
    });
    csp({
      violatedDirective: 'script-src',
      contentSecurityPolicyViolationType: 'kInlineViolation',
    });
    csp({
      violatedDirective: 'script-src',
      contentSecurityPolicyViolationType: 'kWasmEvalViolation',
    });
    csp({
      violatedDirective: 'require-trusted-types-for',
      contentSecurityPolicyViolationType: 'kTrustedTypesSinkViolation',
    });
    csp(undefined);
    csp(
      { violatedDirective: 'img-src', contentSecurityPolicyViolationType: 'kURLViolation' },
      'MixedContentIssue',
    );
    this.emit(
      'Runtime.exceptionThrown',
      { exceptionDetails: { text: 'another page', executionContextId: CONTEXTS.view } },
      'session-elsewhere',
    );
    this.emit('Runtime.bindingCalled', { name: 'someOtherBinding', payload: '{}' });
    this.emit('Runtime.executionContextDestroyed', { executionContextId: CONTEXTS.other });
    exception({ text: 'after destroy', executionContextId: CONTEXTS.other });
  }

  async answer(method: string, params: CdpObject): Promise<unknown> {
    switch (method) {
      case 'Target.createTarget':
        return { targetId: MAIN_FRAME };
      case 'Target.attachToTarget':
        return { sessionId: SESSION };
      case 'Page.navigate':
        setImmediate(() => this.#navigate());
        return { frameId: MAIN_FRAME, loaderId: 'loader' };
      case 'Runtime.evaluate':
        return this.#evaluate(params.expression as string, params.contextId as number);
      case 'Input.dispatchMouseEvent':
        if (params.type === 'mouseReleased') {
          this.view?.clickAt(
            (params.x as number) - SANDBOX_ORIGIN.x - VIEW_ORIGIN.x,
            (params.y as number) - SANDBOX_ORIGIN.y - VIEW_ORIGIN.y,
          );
        }
        return {};
      case 'Input.insertText':
        this.view?.insertText(params.text as string);
        return {};
      case 'Page.captureScreenshot':
        return { data: PNG_BASE64 };
      default:
        return {};
    }
  }

  #navigate(): void {
    const mode = this.options.view ?? 'app';
    if (mode === 'no-frames') return;
    const attach = (frameId: string, parentFrameId: string) =>
      this.emit('Page.frameAttached', { frameId, parentFrameId });
    const context = (id: number, frameId: string | undefined, name = '', isDefault?: boolean) =>
      this.emit('Runtime.executionContextCreated', {
        context: {
          id,
          name,
          origin: '',
          ...(frameId && { auxData: { frameId, ...(isDefault !== undefined && { isDefault }) } }),
        },
      });
    context(CONTEXTS.main, MAIN_FRAME, '', true);
    context(CONTEXTS.hostWorld, MAIN_FRAME, HOST_WORLD);
    if (mode !== 'frameless') {
      attach(SANDBOX_FRAME, MAIN_FRAME);
      attach(VIEW_FRAME, SANDBOX_FRAME);
      attach(OTHER_FRAME, 'frame-unrelated');
      context(CONTEXTS.sandbox, SANDBOX_FRAME, '', true);
      context(CONTEXTS.view, VIEW_FRAME, '', true);
      context(CONTEXTS.other, OTHER_FRAME, '', true);
      context(77, undefined);
    }
    this.fromView({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-proxy-ready',
      params: {},
    } as JSONRPCMessage);
  }

  /** An `Error` thrown in the page carries a description; a thrown primitive only its text. */
  #evaluate(expression: string, contextId: number): unknown {
    try {
      return { result: { value: this.#valueOf(expression, contextId) } };
    } catch (err) {
      return {
        result: {},
        exceptionDetails:
          err instanceof Error
            ? { text: 'Uncaught', exception: { description: err.message } }
            : { text: `Uncaught ${String(err)}` },
      };
    }
  }

  #valueOf(expression: string, contextId: number): unknown {
    if (contextId === CONTEXTS.hostWorld) {
      if (expression.startsWith(`${SEND_FUNCTION}(`)) {
        const json = JSON.parse(expression.slice(SEND_FUNCTION.length + 1, -1)) as string;
        this.#toView(JSON.parse(json) as JSONRPCMessage & { method?: string; params?: CdpObject });
        return undefined;
      }
      if (expression.startsWith(`${RESIZE_FUNCTION}(`)) {
        this.resizes.push(Number(expression.slice(RESIZE_FUNCTION.length + 1, -1)));
        return undefined;
      }
    }
    if (contextId === CONTEXTS.main && expression.includes(JSON.stringify(SANDBOX_FRAME_ID))) {
      return expression.includes('scrollX')
        ? { x: SANDBOX_ORIGIN.x, y: SANDBOX_ORIGIN.y, width: 720, height: 480 }
        : SANDBOX_ORIGIN;
    }
    if (contextId === CONTEXTS.sandbox && expression.includes("document.querySelector('iframe')")) {
      return VIEW_ORIGIN;
    }
    if (contextId === CONTEXTS.view && this.view) return this.view.evaluate(expression);
    throw new Error(`The fake page cannot evaluate in context ${contextId}: ${expression}`);
  }

  #toView(message: JSONRPCMessage & { method?: string; params?: CdpObject }): void {
    if (message.method && this.options.failDeliveries?.includes(message.method)) {
      throw new Error(`delivery of ${message.method} failed`);
    }
    if (message.method === 'ui/notifications/sandbox-resource-ready') {
      this.resourceReady = message.params;
      if (this.options.view !== 'silent') {
        this.view = new FakeView(this);
        void this.view.connect();
      }
      return;
    }
    const id = (message as { id?: string | number }).id;
    const waiter = id === undefined ? undefined : this.rawWaiters.get(id);
    if (waiter && message.method === undefined) {
      waiter(message);
      return;
    }
    this.view?.deliver(message);
  }
}

// ── Module replacements ───────────────────────────────────────────────

let current: FakeHost | undefined;

/** Make `host` the one the mocked modules answer from, and return it. */
export function installFakeHost(host: FakeHost): FakeHost {
  current = host;
  return host;
}

function active(): FakeHost {
  if (!current) throw new Error('No FakeHost installed; call installFakeHost first.');
  return current;
}

/** Replaces `src/testing/apps/browser.ts`. */
export const browserModule = {
  BROWSER_PATH_ENV: 'MCP_APPS_BROWSER_PATH',
  discoverBrowser: vi.fn(async (explicitPath?: string) => explicitPath ?? FAKE_EXECUTABLE),
  launchBrowser: vi.fn((executable: string) => active().launch(executable)),
};

/** Overrides for `@modelcontextprotocol/client`. */
export const clientOverrides = {
  Client: FakeClient,
  StreamableHTTPClientTransport: FakeStreamableHTTPClientTransport,
};

/** Overrides for `@modelcontextprotocol/client/stdio`. */
export const stdioOverrides = { StdioClientTransport: FakeStdioClientTransport };
