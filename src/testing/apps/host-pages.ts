/**
 * @fileoverview The two loopback origins of the headless MCP Apps host. The host origin
 * serves a page holding the sandbox iframe; the sandbox origin serves the sandbox proxy
 * page with the view's CSP as an HTTP header. The proxy announces
 * `ui/notifications/sandbox-proxy-ready`; on `ui/notifications/sandbox-resource-ready` it
 * creates the inner view iframe and writes the view HTML into it (an about:blank child
 * inherits the proxy's origin and CSP); it relays every other message both ways.
 *
 * Both iframes carry the view's permissions-policy `allow` value, set before each frame
 * loads: a frame can only delegate a feature its own frame was granted, and writing the
 * view into the inner frame is not a navigation, so its policy is fixed when it is created.
 *
 * The host-side relay is not part of the host page: it runs in an isolated world
 * ({@link HOST_WORLD}) installed over CDP, and reports through a binding only that world
 * can see, so the view cannot reach the channel to Node.
 * @module src/testing/apps/host-pages
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The isolated world the host relay runs in. */
export const HOST_WORLD = '__mcpAppsHost';
/** Binding the relay calls with each message from the sandbox, as JSON. */
export const RECEIVE_BINDING = '__mcpAppsHostReceive';
/** Function the relay defines in its world; Node calls it with each message for the view. */
export const SEND_FUNCTION = '__mcpAppsHostSend';
/** Function the relay defines to set the sandbox iframe's height in CSS pixels. */
export const RESIZE_FUNCTION = '__mcpAppsHostResize';
/** The id of the sandbox iframe in the host page. */
export const SANDBOX_FRAME_ID = 'mcp-apps-sandbox';

/** Both origins, listening on 127.0.0.1. */
export interface HostPages {
  close(): Promise<void>;
  readonly hostUrl: string;
  /** The relay script, installed in {@link HOST_WORLD} before the host page loads. */
  readonly relayScript: string;
  readonly sandboxOrigin: string;
}

/** Layout and background of the host page, and the view's permissions. */
export interface HostPageOptions {
  /** The iframe `allow` value for the resource's `_meta.ui.permissions`; empty for none. */
  allow: string;
  background: string;
  height: number;
  width: number;
}

/** Start both origins. `csp` is sent with the sandbox page. */
export async function startHostPages(csp: string, options: HostPageOptions): Promise<HostPages> {
  let sandboxOrigin = '';
  let hostOrigin = '';
  const host = await listen((req, res) => {
    if (req.url !== '/') return notFound(res);
    send(res, hostPage(sandboxOrigin, options), {});
  });
  const sandbox = await listen((req, res) => {
    if (req.url !== '/sandbox.html') return notFound(res);
    send(res, sandboxPage(hostOrigin, options.allow), { 'content-security-policy': csp });
  });
  hostOrigin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  sandboxOrigin = `http://127.0.0.1:${(sandbox.address() as AddressInfo).port}`;
  return {
    hostUrl: `${hostOrigin}/`,
    sandboxOrigin,
    relayScript: relayScript(sandboxOrigin),
    close: async () => {
      await Promise.all([stop(host), stop(sandbox)]);
    },
  };
}

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stop(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function send(res: http.ServerResponse, body: string, headers: Record<string, string>): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function hostPage(
  sandboxOrigin: string,
  { allow, background, height, width }: HostPageOptions,
): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Apps host</title>
<style>html,body{margin:0;padding:0;background:${background}}iframe{display:block;border:0}</style>
</head><body>
<iframe id="${SANDBOX_FRAME_ID}" src="${sandboxOrigin}/sandbox.html" sandbox="allow-scripts allow-same-origin allow-forms"${allow ? ` allow="${allow}"` : ''} style="width:${width}px;height:${height}px"></iframe>
</body></html>`;
}

function sandboxPage(hostOrigin: string, allow: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head>
<body><script>
(() => {
  const HOST_ORIGIN = ${JSON.stringify(hostOrigin)};
  const ALLOW = ${JSON.stringify(allow)};
  let inner;
  window.addEventListener('message', (event) => {
    if (event.source === window.parent) {
      if (event.origin !== HOST_ORIGIN) return;
      const data = event.data;
      if (data && data.method === 'ui/notifications/sandbox-resource-ready') {
        inner = document.createElement('iframe');
        inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        if (ALLOW) inner.setAttribute('allow', ALLOW);
        document.body.appendChild(inner);
        const doc = inner.contentDocument;
        doc.open();
        doc.write(String(data.params.html));
        doc.close();
        return;
      }
      if (inner && inner.contentWindow) inner.contentWindow.postMessage(data, '*');
    } else if (inner && event.source === inner.contentWindow) {
      if (event.origin !== location.origin) return;
      window.parent.postMessage(event.data, HOST_ORIGIN);
    }
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, HOST_ORIGIN);
})();
</script></body></html>`;
}

function relayScript(sandboxOrigin: string): string {
  return `(() => {
  if (window.top !== window) return;
  const SANDBOX_ORIGIN = ${JSON.stringify(sandboxOrigin)};
  const frame = () => document.getElementById(${JSON.stringify(SANDBOX_FRAME_ID)});
  window.addEventListener('message', (event) => {
    const sandbox = frame();
    if (!sandbox || event.source !== sandbox.contentWindow || event.origin !== SANDBOX_ORIGIN) return;
    globalThis[${JSON.stringify(RECEIVE_BINDING)}](JSON.stringify(event.data));
  });
  globalThis[${JSON.stringify(SEND_FUNCTION)}] = (json) => {
    frame().contentWindow.postMessage(JSON.parse(json), SANDBOX_ORIGIN);
  };
  globalThis[${JSON.stringify(RESIZE_FUNCTION)}] = (height) => {
    frame().style.height = height + 'px';
  };
})();`;
}
