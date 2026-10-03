/**
 * @fileoverview Tests for the two loopback origins of the headless MCP Apps host: both
 * bind 127.0.0.1, the sandbox page carries the view's CSP as a header, both frames carry
 * the view's permissions-policy `allow` value, unknown paths 404, and the relay script is
 * scoped to the sandbox origin.
 * @module tests/unit/testing/apps/host-pages.test
 */

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
