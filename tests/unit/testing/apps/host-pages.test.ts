/**
 * @fileoverview Tests for the two loopback origins of the headless MCP Apps host: both
 * bind 127.0.0.1, the sandbox page carries the view's CSP as a header, both frames carry
 * the view's permissions-policy `allow` value, unknown paths 404, and the relay script is
 * scoped to the sandbox origin. The sandbox proxy and the host relay also run in a
 * `node:vm` context over a minimal fake window, so their message filters are exercised
 * without a browser.
 * @module tests/unit/testing/apps/host-pages.test
 */

import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOST_WORLD,
  type HostPages,
  RECEIVE_BINDING,
  RESIZE_FUNCTION,
  SANDBOX_FRAME_ID,
  SEND_FUNCTION,
  startHostPages,
} from '@/testing/apps/host-pages.js';
import { exchange } from '../../../helpers/node-http.js';

const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'";
const LAYOUT = { allow: '', width: 720, height: 480, background: '#ffffff' };
const WIDE_DARK = { ...LAYOUT, width: 640, height: 300, background: '#123456' };

function portOf(origin: string): number {
  return Number(new URL(origin).port);
}

describe('startHostPages', () => {
  let pages: HostPages | undefined;

  afterEach(async () => {
    await pages?.close();
    pages = undefined;
  });

  it('serves both origins on 127.0.0.1, on different ports', async () => {
    pages = await startHostPages(CSP, WIDE_DARK);
    const host = new URL(pages.hostUrl);
    const sandbox = new URL(pages.sandboxOrigin);
    expect(host.hostname).toBe('127.0.0.1');
    expect(sandbox.hostname).toBe('127.0.0.1');
    expect(host.pathname).toBe('/');
    expect(host.port).not.toBe(sandbox.port);
  });

  it('serves the host page holding the sandbox iframe at its size and background', async () => {
    pages = await startHostPages(CSP, WIDE_DARK);
    const response = await exchange(portOf(pages.hostUrl), { method: 'GET', path: '/' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.body).toContain(`id="${SANDBOX_FRAME_ID}"`);
    expect(response.body).toContain(`src="${pages.sandboxOrigin}/sandbox.html"`);
    expect(response.body).toContain('sandbox="allow-scripts allow-same-origin allow-forms"');
    expect(response.body).toContain('width:640px;height:300px');
    expect(response.body).toContain('background:#123456');
  });

  it('serves the sandbox proxy with the view CSP as a header, bound to the host origin', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    const response = await exchange(portOf(pages.sandboxOrigin), {
      method: 'GET',
      path: '/sandbox.html',
    });
    const hostOrigin = new URL(pages.hostUrl).origin;
    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toBe(CSP);
    expect(response.body).toContain(`const HOST_ORIGIN = ${JSON.stringify(hostOrigin)}`);
    expect(response.body).toContain('ui/notifications/sandbox-proxy-ready');
    expect(response.body).toContain('ui/notifications/sandbox-resource-ready');
  });

  it('gives both frames the allow value, and neither one an allow attribute without it', async () => {
    const pagesOf = async (allow: string) => {
      pages = await startHostPages(CSP, { ...LAYOUT, allow });
      const [host, sandbox] = await Promise.all([
        exchange(portOf(pages.hostUrl), { method: 'GET', path: '/' }),
        exchange(portOf(pages.sandboxOrigin), { method: 'GET', path: '/sandbox.html' }),
      ]);
      await pages.close();
      pages = undefined;
      return { host: host.body, sandbox: sandbox.body };
    };

    const granted = await pagesOf('microphone; clipboard-write');
    expect(granted.host).toContain('allow="microphone; clipboard-write"');
    expect(granted.sandbox).toContain('const ALLOW = "microphone; clipboard-write"');
    expect(granted.sandbox).toContain("if (ALLOW) inner.setAttribute('allow', ALLOW);");

    const none = await pagesOf('');
    expect(none.host).not.toContain('allow=');
    expect(none.sandbox).toContain('const ALLOW = ""');
  });

  it('answers 404 for every other path on both origins', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    for (const [origin, path] of [
      [pages.hostUrl, '/sandbox.html'],
      [pages.hostUrl, '/favicon.ico'],
      [pages.sandboxOrigin, '/'],
      [pages.sandboxOrigin, '/sandbox.html?x=1'],
    ] as const) {
      const response = await exchange(portOf(origin), { method: 'GET', path });
      expect(response.status).toBe(404);
      expect(response.body).toBe('not found');
      expect(response.headers['content-security-policy']).toBeUndefined();
    }
  });

  it('builds a relay script for the isolated world, scoped to the sandbox origin', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    const { relayScript } = pages;
    expect(relayScript).toContain(`const SANDBOX_ORIGIN = ${JSON.stringify(pages.sandboxOrigin)}`);
    expect(relayScript).toContain(JSON.stringify(RECEIVE_BINDING));
    expect(relayScript).toContain(JSON.stringify(SEND_FUNCTION));
    expect(relayScript).toContain(JSON.stringify(RESIZE_FUNCTION));
    expect(relayScript).toContain('if (window.top !== window) return;');
    expect(HOST_WORLD).toBe('__mcpAppsHost');
  });

  it('stops listening on both origins when closed', async () => {
    const started = await startHostPages(CSP, LAYOUT);
    await exchange(portOf(started.hostUrl), { method: 'GET', path: '/' });
    await started.close();
    await expect(exchange(portOf(started.hostUrl), { method: 'GET', path: '/' })).rejects.toThrow();
    await expect(
      exchange(portOf(started.sandboxOrigin), { method: 'GET', path: '/sandbox.html' }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The in-page scripts, run over a minimal fake window
// ---------------------------------------------------------------------------

/** What a `message` listener reads off its event. */
interface FakeMessageEvent {
  data: unknown;
  origin: string;
  source: unknown;
}

/** A window stand-in whose `postMessage` calls are recorded. */
function fakeWindow() {
  const posted: Array<{ data: unknown; target: string }> = [];
  return {
    posted,
    postMessage: (data: unknown, target: string) => {
      posted.push({ data, target });
    },
  };
}

/** The proxy's inline script, from the page the sandbox origin serves. */
async function sandboxScript(pages: HostPages): Promise<string> {
  const response = await exchange(portOf(pages.sandboxOrigin), {
    method: 'GET',
    path: '/sandbox.html',
  });
  const script = /<script>([\s\S]*)<\/script>/.exec(response.body)?.[1];
  if (!script) throw new Error('The sandbox page carries no inline script.');
  return script;
}

/** Runs the sandbox proxy script with `parent` as the host frame and `origin` as its own. */
function runSandboxProxy(script: string, origin: string) {
  const parent = fakeWindow();
  const view = fakeWindow();
  const written: string[] = [];
  let listener: ((event: FakeMessageEvent) => void) | undefined;
  let inner: { attributes: Record<string, string> } | undefined;
  const document = {
    body: { appendChild: () => {} },
    createElement: () => {
      const attributes: Record<string, string> = {};
      inner = { attributes };
      return {
        contentDocument: {
          close: () => {},
          open: () => {},
          write: (html: string) => written.push(html),
        },
        contentWindow: view,
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
      };
    },
  };
  const window = {
    addEventListener: (_type: string, handler: (event: FakeMessageEvent) => void) => {
      listener = handler;
    },
    parent,
  };
  vm.runInNewContext(script, { document, location: { origin }, window });
  return {
    dispatch: (event: FakeMessageEvent) => listener?.(event),
    inner: () => inner,
    parent,
    view,
    written,
  };
}

/** Runs the relay script as the top-level window (`nested` makes it a child frame). */
function runRelay(script: string, nested = false) {
  const sandbox = fakeWindow();
  const frame = { contentWindow: sandbox, style: { height: '' } };
  const received: unknown[] = [];
  let listener: ((event: FakeMessageEvent) => void) | undefined;
  const context = vm.createContext({
    addEventListener: (_type: string, handler: (event: FakeMessageEvent) => void) => {
      listener = handler;
    },
    document: { getElementById: (id: string) => (id === SANDBOX_FRAME_ID ? frame : null) },
    [RECEIVE_BINDING]: (json: string) => received.push(JSON.parse(json)),
  });
  vm.runInContext(
    `globalThis.window = globalThis; globalThis.top = ${nested ? '{}' : 'globalThis'};`,
    context,
  );
  vm.runInContext(script, context);
  return {
    context: context as Record<string, unknown>,
    dispatch: (event: FakeMessageEvent) => listener?.(event),
    frame,
    received,
    sandbox,
  };
}

const READY = { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} };
const RESOURCE_READY = {
  jsonrpc: '2.0',
  method: 'ui/notifications/sandbox-resource-ready',
  params: { html: '<p>view</p>' },
};
const TOOL_INPUT = { jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: {} };
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} };

describe('sandbox proxy script', () => {
  let pages: HostPages | undefined;

  afterEach(async () => {
    await pages?.close();
    pages = undefined;
  });

  /** A proxy whose host has already delivered the view HTML. */
  async function loadedProxy() {
    pages = await startHostPages(CSP, { ...LAYOUT, allow: 'clipboard-write' });
    const hostOrigin = new URL(pages.hostUrl).origin;
    const proxy = runSandboxProxy(await sandboxScript(pages), pages.sandboxOrigin);
    proxy.dispatch({ source: proxy.parent, origin: hostOrigin, data: RESOURCE_READY });
    return { hostOrigin, proxy, sandboxOrigin: pages.sandboxOrigin };
  }

  it('announces itself to the host origin, then writes the view into a sandboxed frame', async () => {
    const { hostOrigin, proxy } = await loadedProxy();

    expect(proxy.parent.posted).toEqual([{ data: READY, target: hostOrigin }]);
    expect(proxy.written).toEqual(['<p>view</p>']);
    expect(proxy.inner()?.attributes).toEqual({
      sandbox: 'allow-scripts allow-same-origin allow-forms',
      allow: 'clipboard-write',
    });
  });

  it('relays host messages to the view, but never a reserved sandbox notification', async () => {
    const { hostOrigin, proxy } = await loadedProxy();

    proxy.dispatch({ source: proxy.parent, origin: hostOrigin, data: TOOL_INPUT });
    proxy.dispatch({ source: proxy.parent, origin: hostOrigin, data: READY });

    expect(proxy.view.posted).toEqual([{ data: TOOL_INPUT, target: '*' }]);
  });

  it('ignores the parent frame at any origin but the host', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    const proxy = runSandboxProxy(await sandboxScript(pages), pages.sandboxOrigin);

    proxy.dispatch({ source: proxy.parent, origin: 'http://evil.test', data: RESOURCE_READY });

    expect(proxy.inner()).toBeUndefined();
    expect(proxy.written).toEqual([]);
  });

  it('relays view messages to the host origin only from its own origin, never reserved', async () => {
    const { hostOrigin, proxy, sandboxOrigin } = await loadedProxy();
    proxy.parent.posted.length = 0;

    proxy.dispatch({ source: proxy.view, origin: sandboxOrigin, data: INITIALIZE });
    proxy.dispatch({ source: proxy.view, origin: 'http://evil.test', data: INITIALIZE });
    proxy.dispatch({ source: proxy.view, origin: sandboxOrigin, data: READY });
    proxy.dispatch({ source: fakeWindow(), origin: sandboxOrigin, data: INITIALIZE });

    expect(proxy.parent.posted).toEqual([{ data: INITIALIZE, target: hostOrigin }]);
  });
});

describe('host relay script', () => {
  let pages: HostPages | undefined;

  afterEach(async () => {
    await pages?.close();
    pages = undefined;
  });

  it('hands only sandbox-frame messages at the sandbox origin to the binding', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    const relay = runRelay(pages.relayScript);

    relay.dispatch({ source: relay.sandbox, origin: pages.sandboxOrigin, data: INITIALIZE });
    relay.dispatch({ source: relay.sandbox, origin: 'http://evil.test', data: TOOL_INPUT });
    relay.dispatch({ source: fakeWindow(), origin: pages.sandboxOrigin, data: TOOL_INPUT });

    expect(relay.received).toEqual([INITIALIZE]);
  });

  it('posts to the sandbox origin and resizes the sandbox frame', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    const relay = runRelay(pages.relayScript);

    (relay.context[SEND_FUNCTION] as (json: string) => void)(JSON.stringify(TOOL_INPUT));
    (relay.context[RESIZE_FUNCTION] as (height: number) => void)(640);

    expect(relay.sandbox.posted).toEqual([{ data: TOOL_INPUT, target: pages.sandboxOrigin }]);
    expect(relay.frame.style.height).toBe('640px');
  });

  it('installs nothing when it runs in a child frame', async () => {
    pages = await startHostPages(CSP, LAYOUT);
    const relay = runRelay(pages.relayScript, true);

    relay.dispatch({ source: relay.sandbox, origin: pages.sandboxOrigin, data: INITIALIZE });

    expect(relay.context[SEND_FUNCTION]).toBeUndefined();
    expect(relay.received).toEqual([]);
  });
});
