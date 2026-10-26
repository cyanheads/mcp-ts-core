/**
 * @fileoverview Wire coverage for the `skills` option (#789): a server's
 * published skill tree served over MCP through the SEP-2640 Skills extension.
 * In-process cases compose the real services and read each surface off both
 * protocol eras — raw 2025-11-25 JSON-RPC over an in-memory pair, and
 * 2026-07-28 requests through the framework's HTTP app — with and without the
 * option, so the deltas are exactly what opting in adds. The subprocess case
 * launches the built package over stdio from an unrelated working directory.
 * @module tests/integration/skills.int.test
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resetConfig } from '@/config/index.js';
import { type ComposeOptions, composeServices } from '@/core/app.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { parseLogLines } from '../helpers/stdio-session.js';

type Era = 'legacy' | 'modern';
type Params = Record<string, unknown>;
interface Reply {
  error?: { code: number; message: string };
  result?: Record<string, unknown>;
}

const GUIDE_MD = `---\nname: demo-guide\ndescription: Chain demo_echo calls. Use when an echo is needed.\nmetadata:\n  version: "1.0"\n---\n# Demo guide\n\nSee references/ids.md.\n`;
const IDS_MD = '# IDs\n\nEvery ID comes from demo_echo.\n';
const SKILL_URI = 'skill://demo-guide/SKILL.md';
const IDS_URI = 'skill://demo-guide/references/ids.md';
const SKILL_EXTENSION = { 'io.modelcontextprotocol/skills': { directoryRead: true } };
const VENDOR_EXTENSION = { 'vendor/probe': { on: true } };
const INSTRUCTIONS = 'Echo server orientation.';

const echo = tool('demo_echo', {
  description: 'Echoes the message back.',
  annotations: { readOnlyHint: true },
  input: z.object({ message: z.string().describe('Text to echo') }),
  output: z.object({ message: z.string().describe('The echoed text') }),
  handler: (input) => ({ message: input.message }),
});

const originalEnv = { ...process.env };
const cleanups: Array<() => Promise<void> | void> = [];
let root: string;

/** Writes `files` under `<root>/<dir>`, creating parents, and returns the absolute folder. */
function writeTree(dir: string, files: Record<string, string>): string {
  const base = join(root, dir);
  mkdirSync(base, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
  return base;
}

/** The `uri` of each entry in a reply's `result[key]` list; `undefined` when the reply has none. */
const urisOf = (reply: Reply, key: string) =>
  (reply.result?.[key] as Array<{ uri: string }> | undefined)?.map((entry) => entry.uri);

const guideTree = () =>
  writeTree('skills', {
    'demo-guide/SKILL.md': GUIDE_MD,
    'demo-guide/references/ids.md': IDS_MD,
  });

/** Composes the real services and returns a request function for one era. */
async function open(era: Era, options: ComposeOptions) {
  const composed = await composeServices({
    tools: [echo],
    instructions: INSTRUCTIONS,
    extensions: VENDOR_EXTENSION,
    ...options,
  });
  cleanups.push(() => composed.coreServices.rateLimiter.dispose());
  const request = era === 'legacy' ? await legacyClient(composed) : await modernClient(composed);
  return { composed, request };
}

/** A 2025-11-25 session: `initialize` first, then raw JSON-RPC over an in-memory pair. */
async function legacyClient(composed: Awaited<ReturnType<typeof composeServices>>) {
  const server = await composed.createServer({ era: 'legacy' });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (reply: Reply) => void>();
  client.onmessage = (message: JSONRPCMessage) => {
    const { id, error, result } = message as JSONRPCMessage & Reply & { id?: unknown };
    if (typeof id !== 'number') return;
    pending.get(id)?.(error ? { error } : { result: result as Record<string, unknown> });
    pending.delete(id);
  };
  await server.connect(serverSide);
  await client.start();
  cleanups.push(() => server.close());
  let nextId = 1;
  const request = (method: string, params: Params = {}) =>
    new Promise<Reply>((settle) => {
      const id = nextId++;
      pending.set(id, settle);
      void client.send({ jsonrpc: '2.0', id, method, params });
    });
  const initialize = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'skills-int', version: '0.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return Object.assign(request, { handshake: initialize });
}

/** 2026-07-28 requests through the framework's HTTP app; `server/discover` is the handshake. */
async function modernClient(composed: Awaited<ReturnType<typeof composeServices>>) {
  const { app, close } = await createHttpApp(
    composed.createServer,
    requestContextService.createRequestContext({ operation: 'skills-int' }),
    composed.manifest,
    composed.bus,
  );
  cleanups.push(close);
  const request = async (method: string, params: Params = {}): Promise<Reply> => {
    const name = typeof params.uri === 'string' ? params.uri : undefined;
    const response = await app.request(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
          'Mcp-Method': method,
          ...(name && { 'Mcp-Name': name }),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
              'io.modelcontextprotocol/clientInfo': { name: 'skills-int', version: '0.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );
    const body = await response.text();
    const data = body
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice(5);
    const { error, result } = JSON.parse(data ?? body) as Reply;
    return error ? { error } : { result: result as Record<string, unknown> };
  };
  return Object.assign(request, { handshake: await request('server/discover') });
}

beforeEach(() => {
  process.env = { ...originalEnv, MCP_TRANSPORT_TYPE: 'stdio' };
  resetConfig();
  root = mkdtempSync(join(tmpdir(), 'skills-int-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

describe.each<Era>(['legacy', 'modern'])('skills on the %s era', (era) => {
  it('serves nothing extra without the option', async () => {
    const { request } = await open(era, {});

    expect(request.handshake.result?.capabilities).toMatchObject({
      extensions: VENDOR_EXTENSION,
    });
    expect(request.handshake.result?.capabilities).not.toHaveProperty([
      'extensions',
      'io.modelcontextprotocol/skills',
    ]);
    expect((await request('skills/list')).error?.code).toBe(-32601);
  });

  it('adds the extension, the skills methods, and the skill resources — and nothing else', async () => {
    const without = (await open(era, {})).request;
    const { request } = await open(era, { skills: guideTree() });

    expect(request.handshake.result?.capabilities).toMatchObject({
      extensions: { ...VENDOR_EXTENSION, ...SKILL_EXTENSION },
    });
    expect(request.handshake.result?.instructions).toBe(INSTRUCTIONS);
    expect(without.handshake.result?.instructions).toBe(INSTRUCTIONS);
    expect(await request('tools/list')).toEqual(await without('tools/list'));

    const listed = (await request('resources/list')).result?.resources;
    expect(listed).toEqual([
      expect.objectContaining({ uri: SKILL_URI, name: 'demo-guide', mimeType: 'text/markdown' }),
    ]);
    expect((await without('resources/list')).result?.resources).toEqual([]);
    const templates = (await request('resources/templates/list')).result?.resourceTemplates;
    expect(templates).toEqual([
      expect.objectContaining({
        name: 'io.modelcontextprotocol/skills',
        uriTemplate: 'skill://{+path}',
      }),
    ]);
    expect((await without('resources/templates/list')).result?.resourceTemplates).toEqual([]);

    const skills = (await request('skills/list')).result?.skills as Array<{
      uri: string;
      frontmatter: Record<string, unknown>;
      resources: Array<{ uri: string }>;
    }>;
    expect(skills.map((skill) => [skill.uri, skill.frontmatter.name])).toEqual([
      [SKILL_URI, 'demo-guide'],
    ]);
    expect(skills[0]?.resources.map((file) => file.uri)).toEqual([SKILL_URI, IDS_URI]);
    expect((await request('skills/get', { uri: SKILL_URI })).result?.skill).toMatchObject({
      uri: SKILL_URI,
      frontmatter: { name: 'demo-guide', metadata: { version: '1.0' } },
    });

    expect((await request('resources/read', { uri: SKILL_URI })).result?.contents).toEqual([
      expect.objectContaining({ uri: SKILL_URI, text: GUIDE_MD }),
    ]);
    expect((await request('resources/read', { uri: IDS_URI })).result?.contents).toEqual([
      expect.objectContaining({ uri: IDS_URI, text: IDS_MD }),
    ]);
    const directory = await request('resources/directory/read', { uri: 'skill://demo-guide' });
    expect(urisOf(directory, 'resources')).toEqual([SKILL_URI, 'skill://demo-guide/references']);
  });

  it(`carries ttlMs / cacheScope on skills results only on 2026-07-28 (${era})`, async () => {
    const { request } = await open(era, { skills: guideTree() });

    for (const reply of [
      await request('skills/list'),
      await request('skills/get', { uri: SKILL_URI }),
    ]) {
      if (era === 'modern') {
        expect(reply.result).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
      } else {
        expect(reply.result).not.toHaveProperty('ttlMs');
        expect(reply.result).not.toHaveProperty('cacheScope');
      }
    }
  });
});

describe('the skills option', () => {
  it('skips a skill the SDK rejects, logs a warning naming the file and problem, and serves the rest', async () => {
    const warning = vi.spyOn(logger, 'warning');
    const dir = writeTree('skills', {
      'demo-guide/SKILL.md': GUIDE_MD,
      'foo/SKILL.md': '---\nname: bar\ndescription: Mismatched name.\n---\nBody.\n',
    });

    const { request } = await open('legacy', { skills: dir });

    expect(urisOf(await request('skills/list'), 'skills')).toEqual([SKILL_URI]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(/^Skill problem in foo\/SKILL\.md: frontmatter name "bar" must match/),
      expect.objectContaining({
        extra: expect.objectContaining({ skillPath: 'foo/SKILL.md' }),
      }),
    );
  });

  it('reads the folder once per process, not per server instance', async () => {
    const dir = guideTree();
    const composed = await composeServices({ skills: dir });
    cleanups.push(() => composed.coreServices.rateLimiter.dispose());
    writeTree('skills', {
      'late-guide/SKILL.md': '---\nname: late-guide\ndescription: Added after startup.\n---\n',
    });

    const { request } = await open('modern', { skills: dir });
    const late = await legacyClient(composed);

    expect(composed.skillNames).toEqual(['demo-guide']);
    expect(urisOf(await late('skills/list'), 'skills')).toEqual([SKILL_URI]);
    // A fresh composition does read the folder again — the new skill was on disk.
    expect(urisOf(await request('skills/list'), 'skills')).toEqual([
      SKILL_URI,
      'skill://late-guide/SKILL.md',
    ]);
  });

  it('fails startup with a ConfigurationError naming the resolved path when the folder is missing', async () => {
    const missing = join(root, 'absent');

    const error = await composeServices({ skills: missing }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((error as McpError).message).toContain(missing);
  });

  it('advertises the extension and resources on the server card only when opted in', async () => {
    const plain = await composeServices({ tools: [echo] });
    const opted = await composeServices({ tools: [echo], skills: guideTree() });
    cleanups.push(
      () => plain.coreServices.rateLimiter.dispose(),
      () => opted.coreServices.rateLimiter.dispose(),
    );

    expect(plain.manifest.capabilities.resources).toBe(false);
    expect(plain.manifest.extensions).toBeUndefined();
    expect(opted.manifest.capabilities.resources).toBe(true);
    expect(opted.manifest.extensions).toEqual(SKILL_EXTENSION);
  });
});

describe('a stdio server launched from another working directory', () => {
  /** The built package's entry, imported by a throwaway application with its own manifest. */
  const CORE_ENTRY = pathToFileURL(resolve(process.cwd(), 'dist/core/index.js')).href;

  it('serves its own skills/ and lists them on the startup record', async () => {
    const app = writeTree('app', {
      'package.json': JSON.stringify({ name: 'skills-fixture', version: '0.0.0', type: 'module' }),
      'server.mjs': `import { createApp } from ${JSON.stringify(CORE_ENTRY)};\nawait createApp({ name: 'skills-fixture', version: '0.0.0-test', skills: 'skills' });\n`,
      'skills/demo-guide/SKILL.md': GUIDE_MD,
    });
    // The client's project carries a skills/ tree of its own, which must not be served.
    const elsewhere = writeTree('client-project', {
      'package.json': JSON.stringify({ name: 'client-project', version: '9.9.9' }),
      'skills/wrong-guide/SKILL.md':
        '---\nname: wrong-guide\ndescription: The client project tree.\n---\n',
    });

    const { replies, stderr } = await stdioSession(join(app, 'server.mjs'), elsewhere, [
      'skills/list',
    ]);

    const skills = replies[0]?.result?.skills as Array<{ uri: string }>;
    expect(skills.map((skill) => skill.uri)).toEqual([SKILL_URI]);
    const startup = parseLogLines(stderr).find((record) =>
      String(record.msg).startsWith('Core services constructed'),
    );
    expect(startup?.msg).toBe(
      'Core services constructed — 0 tool(s), 0 resource(s), 0 prompt(s), 1 skill(s). Storage: in-memory.',
    );
    expect(startup).toMatchObject({ skills: ['demo-guide'] });
  });
});

/**
 * Spawns `entry` over stdio from `cwd`, runs `initialize` and each method in
 * turn, then ends stdin and waits for the exit. Killed by its own PID if it
 * outlives the window.
 */
async function stdioSession(entry: string, cwd: string, methods: string[]) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(
        // The runner's NODE_ENV=test silences the logger's stderr sink.
        Object.entries(originalEnv).filter(
          ([key]) =>
            !key.startsWith('MCP_') &&
            !key.startsWith('OTEL_') &&
            key !== 'LOGS_DIR' &&
            key !== 'NODE_ENV',
        ),
      ),
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_LOG_LEVEL: 'info',
      LOGS_DIR: join(root, 'logs'),
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  let buffered = '';
  const waiters = new Map<number, (reply: Reply) => void>();
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Reply & { id?: unknown };
      if (typeof message.id === 'number') waiters.get(message.id)?.(message);
    }
  });
  const exited = new Promise<void>((settle) => child.once('exit', () => settle()));
  const request = (id: number, method: string, params: Params = {}) =>
    new Promise<Reply>((settle, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method}:\n${stderr}`)),
        15_000,
      );
      waiters.set(id, (reply) => {
        clearTimeout(timer);
        settle(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    await request(0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'skills-int', version: '0.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const replies: Reply[] = [];
    for (const [index, method] of methods.entries()) replies.push(await request(index + 1, method));
    child.stdin.end();
    await Promise.race([exited, new Promise((settle) => setTimeout(settle, 10_000))]);
    return { replies, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
