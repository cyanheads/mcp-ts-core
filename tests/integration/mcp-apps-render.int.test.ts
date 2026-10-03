/**
 * @fileoverview End-to-end tests for the headless MCP Apps host: the app-render fixture
 * server over stdio and Streamable HTTP, rendered in real `chrome-headless-shell` through
 * `renderAppTool`. One case per acceptance criterion of the harness, plus the step types,
 * view-to-host requests, and browser teardown. A missing browser fails the suite with the
 * install command; it is never skipped.
 * @module tests/integration/mcp-apps-render.int.test
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverBrowser } from '@/testing/apps/browser.js';
import {
  type AppRenderMessage,
  type AppRenderReport,
  type AppServerTarget,
  renderAppTool,
} from '@/testing/apps/index.js';
import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

const execFileAsync = promisify(execFile);

const REPO = resolve(import.meta.dirname, '../..');
const FIXTURE = join(REPO, 'tests/fixtures/mcp-app-render-server.js');
const TOOL = 'app_render_probe';
const PEERS = ['@modelcontextprotocol/client', '@modelcontextprotocol/ext-apps'];
const RUN_TIMEOUT_MS = 60_000;

let scratch: string;
let scriptServer: http.Server;
let scriptUrl: string;
let scriptRequests = 0;

/** The fixture over stdio, with only the environment it needs plus `env`. */
function stdioServer(env: Record<string, string> = {}): AppServerTarget {
  return {
    command: process.execPath,
    args: [FIXTURE],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: tmpdir(),
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_LOG_LEVEL: 'error',
      MCP_APP_RENDER_SCRIPT_URL: scriptUrl,
      ...env,
    },
  };
}

function render(options: Partial<Parameters<typeof renderAppTool>[0]> = {}) {
  return renderAppTool({
    server: stdioServer(),
    tool: TOOL,
    arguments: { query: 'probe' },
    outDir: join(scratch, `run-${Math.random().toString(36).slice(2)}`),
    ...options,
  });
}

/** Messages with a method, as `direction:method`, in order. */
function methods(report: AppRenderReport): string[] {
  return report.messages
    .filter((entry) => typeof entry.message.method === 'string')
    .map((entry) => `${entry.direction}:${String(entry.message.method)}`);
}

/** The view request with `method` (and matching `params`), plus the host's answer to it. */
function exchangeFor(
  report: AppRenderReport,
  method: string,
  matches: (params: Record<string, unknown>) => boolean = () => true,
): { request: AppRenderMessage; response: AppRenderMessage } {
  const request = report.messages.find(
    (entry) =>
      entry.direction === 'view-to-host' &&
      entry.message.method === method &&
      matches((entry.message.params ?? {}) as Record<string, unknown>),
  );
  expect(request, `a view-to-host ${method} request`).toBeDefined();
  const response = report.messages.find(
    (entry) =>
      entry.direction === 'host-to-view' &&
      entry.message.method === undefined &&
      entry.message.id === request?.message.id,
  );
  expect(response, `the host's response to ${method}`).toBeDefined();
  return { request: request as AppRenderMessage, response: response as AppRenderMessage };
}

/** Whether `pid` is still a live process, and whether any process still names `profileDir`. */
async function leftovers(
  report: AppRenderReport,
): Promise<{ pidAlive: boolean; profileUsers: string[] }> {
  const pid = await execFileAsync('ps', ['-p', String(report.browser.pid), '-o', 'pid=']).then(
    ({ stdout }) => stdout.trim() !== '',
    () => false,
  );
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command=']);
  const profileUsers = stdout
    .split('\n')
    .filter((line) => line.includes(report.browser.profileDir));
  return { pidAlive: pid, profileUsers };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'mcp-apps-render-int-'));
  scriptServer = http.createServer((req, res) => {
    if (req.url !== '/declared.js') {
      res.writeHead(404).end();
      return;
    }
    scriptRequests += 1;
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    res.end("document.getElementById('declared').textContent = 'declared: loaded';");
  });
  await new Promise<void>((done) => scriptServer.listen(0, '127.0.0.1', done));
  scriptUrl = `http://127.0.0.1:${(scriptServer.address() as AddressInfo).port}/declared.js`;
}, RUN_TIMEOUT_MS);

afterAll(async () => {
  scriptServer?.closeAllConnections();
  await new Promise<void>((done) => (scriptServer ? scriptServer.close(() => done()) : done()));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/**
 * Runs first. With no browser it fails here with the install command, and every render
 * below fails its hook with the same error.
 */
it('finds a chrome-headless-shell executable to drive', async () => {
  const executable = await discoverBrowser();
  expect(existsSync(executable)).toBe(true);
});

describe('headless MCP Apps host — acceptance criteria', () => {
  const args = { query: 'probe-with-a-longer-query-to-stream' };
  let report: AppRenderReport;

  beforeAll(async () => {
    report = await render({
      arguments: args,
      host: { streamInput: true },
      steps: [{ click: '#action' }, { screenshot: 'after-click' }, { click: '#throw' }],
    });
  }, RUN_TIMEOUT_MS);

  it('initializes a view built on the ext-apps App class, delivers input and result, and reports text and a screenshot', async () => {
    expect(report.failure).toBeUndefined();
    expect(report.initialized).toBe(true);
    expect(report.appInfo).toEqual({ name: 'app-render-fixture-view', version: '1.0.0' });
    expect(report.toolResult).toMatchObject({
      structuredContent: { query: args.query, items: [`${args.query}-one`, `${args.query}-two`] },
    });
    expect(report.text).toContain(`input: ${JSON.stringify(args)}`);
    expect(report.text).toContain(
      `result: ${JSON.stringify({ query: args.query, items: [`${args.query}-one`, `${args.query}-two`] })}`,
    );
    expect(report.screenshots.map((file) => file.split('/').at(-1))).toEqual([
      'after-click.png',
      'final.png',
    ]);
    for (const file of report.screenshots) {
      const png = await readFile(file);
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(png.length).toBeGreaterThan(1_000);
    }
  });

  it('runs the inline script, blocks eval and an undeclared origin, and loads a declared resourceDomains origin', () => {
    expect(report.text).toContain('connected');
    expect(report.text).toContain('eval: blocked (EvalError)');
    expect(report.cspViolations).toContainEqual(
      expect.objectContaining({
        blockedURI: 'eval',
        directive: expect.stringContaining('script-src'),
        sourceURL: expect.stringContaining('app-render-view.js'),
      }),
    );
    expect(report.cspViolations).toContainEqual(
      expect.objectContaining({
        blockedURI: 'https://undeclared.example.invalid/pixel.png',
        directive: expect.stringContaining('img-src'),
      }),
    );
    const declaredOrigin = new URL(scriptUrl).origin;
    expect(report.csp).toContain(`script-src 'self' 'unsafe-inline' ${declaredOrigin}`);
    expect(report.text).toContain('declared: loaded');
    expect(scriptRequests).toBeGreaterThan(0);
    expect(
      report.cspViolations.some((violation) => violation.blockedURI.startsWith(declaredOrigin)),
    ).toBe(false);
  });

  it('sends a view tools/call to the server and returns its result to the view', () => {
    const { request, response } = exchangeFor(report, 'tools/call');
    expect(request.message.params).toMatchObject({
      name: 'app_render_action',
      arguments: { clicks: 1 },
    });
    expect(response.message.result).toMatchObject({ structuredContent: { echoed: 1 } });
    expect(report.text).toContain('action: {"echoed":1}');
  });

  it('reports an uncaught exception in the view in errors', () => {
    expect(report.errors).toContainEqual(
      expect.objectContaining({
        source: 'exception',
        frame: 'view',
        message: expect.stringContaining('app-render fixture: thrown on click'),
      }),
    );
  });

  it('streams at least one tool-input-partial, each a valid JSON object, before tool-input', () => {
    const toView = methods(report).filter((entry) =>
      entry.startsWith('host-to-view:ui/notifications/tool-input'),
    );
    const partials = report.messages.filter(
      (entry) => entry.message.method === 'ui/notifications/tool-input-partial',
    );
    expect(partials.length).toBeGreaterThan(0);
    expect(toView.at(-1)).toBe('host-to-view:ui/notifications/tool-input');
    expect(toView.slice(0, -1).every((entry) => entry.endsWith('tool-input-partial'))).toBe(true);
    for (const partial of partials) {
      const sent = (partial.message.params as { arguments: unknown }).arguments;
      expect(sent).toBeTypeOf('object');
      expect(sent).not.toBeNull();
      expect(Array.isArray(sent)).toBe(false);
      expect(JSON.parse(JSON.stringify(sent))).toEqual(sent);
    }
    expect(report.text).toContain(`partials: ${partials.length}`);
  });

  it('triggers the view handler from a click step, visible in messages', () => {
    expect(report.steps.map((step) => step.ok)).toEqual([true, true, true]);
    const result = report.messages.find(
      (entry) => entry.message.method === 'ui/notifications/tool-result',
    );
    const { request } = exchangeFor(report, 'tools/call');
    expect(request.at).toBeGreaterThanOrEqual(result?.at ?? Number.POSITIVE_INFINITY);
  });

  it(
    'imports the subpath without either optional peer; renderAppTool then names the missing package',
    async () => {
      const root = await mkdtemp(join(scratch, 'no-peers-'));
      await cp(join(REPO, 'dist'), join(root, 'dist'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        '{"name":"no-peers","type":"module","private":true}\n',
      );
      const modules = join(root, 'node_modules');
      await mkdir(modules);
      for (const entry of await readdir(join(REPO, 'node_modules'))) {
        if (entry.startsWith('.')) continue;
        if (!entry.startsWith('@')) {
          await symlink(join(REPO, 'node_modules', entry), join(modules, entry));
          continue;
        }
        await mkdir(join(modules, entry));
        for (const name of await readdir(join(REPO, 'node_modules', entry))) {
          if (PEERS.includes(`${entry}/${name}`)) continue;
          await symlink(join(REPO, 'node_modules', entry, name), join(modules, entry, name));
        }
      }
      await writeFile(
        join(root, 'probe.mjs'),
        `const peers = ${JSON.stringify(PEERS)};
const absent = peers.filter((peer) => { try { import.meta.resolve(peer); return false; } catch { return true; } });
const module = await import('./dist/testing/apps/index.js');
const error = await module.renderAppTool({ server: { command: 'unused' }, tool: 'unused' }).then(() => undefined, (e) => e);
console.log(JSON.stringify({ absent, exports: Object.keys(module), message: error?.message, data: error?.data }));
`,
      );
      const probe = async () =>
        JSON.parse(
          (await execFileAsync(process.execPath, ['probe.mjs'], { cwd: root })).stdout,
        ) as {
          absent: string[];
          data?: Record<string, unknown>;
          exports: string[];
          message?: string;
        };

      const neither = await probe();
      expect(neither.absent).toEqual(PEERS);
      expect(neither.exports).toEqual(['renderAppTool']);
      expect(neither.data).toEqual({
        reason: 'missing_peer',
        package: '@modelcontextprotocol/client',
      });
      expect(neither.message).toContain('bun add -d @modelcontextprotocol/client');

      await symlink(
        join(REPO, 'node_modules/@modelcontextprotocol/client'),
        join(modules, '@modelcontextprotocol/client'),
      );
      const withoutBridge = await probe();
      expect(withoutBridge.absent).toEqual(['@modelcontextprotocol/ext-apps']);
      expect(withoutBridge.data).toEqual({
        reason: 'missing_peer',
        package: '@modelcontextprotocol/ext-apps',
      });
      expect(withoutBridge.message).toContain('bun add -d @modelcontextprotocol/ext-apps');
    },
    RUN_TIMEOUT_MS,
  );

  it('fails on an explicit browser path that is not an executable, without falling back to the cache', async () => {
    const notExecutable = join(scratch, 'chrome-headless-shell');
    await writeFile(notExecutable, '#!/bin/sh\nexit 0\n');
    await chmod(notExecutable, 0o644);
    const directory = join(scratch, 'a-browser-directory');
    await mkdir(directory);

    for (const [browserPath, problem] of [
      [notExecutable, 'is not executable.'],
      [directory, 'is not a file.'],
      [join(scratch, 'missing-browser'), 'does not exist.'],
    ] as const) {
      await expect(render({ browserPath })).rejects.toMatchObject({
        message: expect.stringContaining(`The browser path ${browserPath} ${problem}`),
        data: { reason: 'browser_unavailable' },
      });
    }
  });

  it(
    'leaves no browser process or profile directory behind, after a passing run and after a failed one',
    async () => {
      expect(existsSync(report.browser.profileDir)).toBe(false);
      expect(await leftovers(report)).toEqual({ pidAlive: false, profileUsers: [] });

      const failed = await render({ timeoutMs: 1 });
      expect(failed.failure).toBe('The view did not complete ui/initialize within 1 ms.');
      expect(failed.browser.pid).not.toBe(report.browser.pid);
      expect(existsSync(failed.browser.profileDir)).toBe(false);
      expect(await leftovers(failed)).toEqual({ pidAlive: false, profileUsers: [] });
    },
    RUN_TIMEOUT_MS,
  );
});

describe('headless MCP Apps host — steps and view requests', () => {
  let report: AppRenderReport;

  beforeAll(async () => {
    report = await render({
      host: { availableDisplayModes: ['inline', 'fullscreen'] },
      steps: [
        { fill: '#name', value: 'Ada Lovelace' },
        { waitFor: '#echo', timeoutMs: 5_000 },
        { evaluate: "document.getElementById('name').value" },
        { click: '#message' },
        { click: '#open-link' },
        { click: '#fullscreen' },
      ],
    });
  }, RUN_TIMEOUT_MS);

  it('fills an input, waits for the element it reveals, and evaluates in the view', () => {
    expect(report.failure).toBeUndefined();
    expect(report.steps.slice(0, 3)).toEqual([
      { step: { fill: '#name', value: 'Ada Lovelace' }, ok: true },
      { step: { waitFor: '#echo', timeoutMs: 5_000 }, ok: true },
      {
        step: { evaluate: "document.getElementById('name').value" },
        ok: true,
        value: 'Ada Lovelace',
      },
    ]);
    expect(report.text).toContain('echo: Ada Lovelace');
  });

  it('records and acknowledges a view-sent ui/message', () => {
    expect(report.steps[3]).toMatchObject({ ok: true });
    const { request, response } = exchangeFor(report, 'ui/message');
    expect(request.message.params).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello from the view' }],
    });
    expect(response.message.result).toEqual({});
    expect(report.text).toContain('message: {}');
  });

  it('records and acknowledges a view-sent ui/open-link without navigating', () => {
    const { request, response } = exchangeFor(report, 'ui/open-link');
    expect(request.message.params).toEqual({ url: 'https://example.com/docs' });
    expect(response.message.result).toEqual({});
    expect(report.text).toContain('link: {}');
  });

  it('records and grants a display-mode request for an offered mode', () => {
    const { request, response } = exchangeFor(report, 'ui/request-display-mode');
    expect(request.message.params).toEqual({ mode: 'fullscreen' });
    expect(response.message.result).toEqual({ mode: 'fullscreen' });
    expect(report.text).toContain('mode: fullscreen');
  });
});

describe('headless MCP Apps host — permissions', () => {
  it(
    'grants a permission the resource declares in _meta.ui.permissions, and withholds it otherwise',
    async () => {
      const [declared, undeclared] = await Promise.all([
        render({ server: stdioServer({ MCP_APP_RENDER_CLIPBOARD_WRITE: '1' }) }),
        render(),
      ]);
      expect(declared.initialized).toBe(true);
      expect(declared.text).toContain('clipboard-write: true');
      expect(undeclared.initialized).toBe(true);
      expect(undeclared.text).toContain('clipboard-write: false');
    },
    RUN_TIMEOUT_MS,
  );
});

describe('headless MCP Apps host — Streamable HTTP target', () => {
  let handle: ServerHandle | undefined;

  afterAll(async () => {
    await handle?.kill();
  });

  it(
    'renders the view from a server reached over Streamable HTTP on a loopback port',
    async () => {
      handle = await startServerFromEntrypoint(FIXTURE, 'http', {
        MCP_HTTP_HOST: '127.0.0.1',
        MCP_SESSION_MODE: 'stateful',
        MCP_APP_RENDER_SCRIPT_URL: scriptUrl,
      });
      const report = await render({ server: { url: `http://127.0.0.1:${handle.port}/mcp` } });
      expect(report.failure).toBeUndefined();
      expect(report.initialized).toBe(true);
      expect(report.toolResult).toMatchObject({ structuredContent: { query: 'probe' } });
      expect(report.text).toContain('result: {"query":"probe","items":["probe-one","probe-two"]}');
      expect(report.text).toContain('declared: loaded');
    },
    RUN_TIMEOUT_MS,
  );
});
