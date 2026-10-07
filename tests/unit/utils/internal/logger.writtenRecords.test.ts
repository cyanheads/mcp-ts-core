/**
 * @fileoverview The log records the framework logger writes, read back from a
 * real pino instance: every `Error` in log data written by one allowlist under
 * any key and at any depth (#646); nested data kept through depth 15, with
 * cycles marked and sensitive fields redacted at every depth (#649); the walk's
 * bound on repeated content and guarded reads, on every sink and the client mirror (#695);
 * the adjacent-word key matcher (#696); and every pino path into a written line
 * going through the walk. pino is the real module with its destination swapped
 * for an in-memory stream, so `formatters.log` and `serializers` run as in
 * production; an OTel Logs API sink alongside captures the exported attributes.
 * @module tests/unit/utils/internal/logger.writtenRecords.test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeServerContext } from '../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { lines, mockConfig } = vi.hoisted(() => ({
  /** Every line each pino instance wrote, by sink. */
  lines: { interactions: [] as string[], process: [] as string[] },
  mockConfig: {
    environment: 'testing',
    logRateLimitThreshold: 0,
    logRateLimitWindowMs: 60_000,
    logsPath: undefined as string | undefined,
    logToolFailurePayloadMaxBytes: 16_384,
    logToolFailurePayloads: false,
    mcpAuthDisableScopeChecks: false,
    mcpAuthMode: 'none',
    mcpServerVersion: '1.0.0-test',
    mcpSessionMode: 'auto',
    mcpTransportType: 'stdio',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
}));

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

/**
 * The real pino, writing each line to an in-memory stream instead of its
 * transport. The process logger is the instance built with `base`; the
 * `interactions.log` logger is built without one.
 */
vi.mock('pino', async (importOriginal) => {
  const real = (await importOriginal<typeof import('pino')>()).default;
  const factory = ({ transport: _transport, ...options }: Record<string, unknown>) => {
    const sink = 'base' in options ? lines.process : lines.interactions;
    return real(options, { write: (line: string) => void sink.push(line) });
  };
  return { default: Object.assign(factory, real) };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger, type OtelLogRecord, setOtelLogSink } from '@/utils/internal/logger.js';
import { toLogValue } from '@/utils/internal/logValue.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { sanitization } from '@/utils/security/sanitization.js';
import { DEFAULT_SENSITIVE_FIELDS, setSensitiveNames } from '@/utils/security/sensitiveFields.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A parsed log line, read by path. */
type Written = Record<string, any>;

const IS_BUN = typeof process.versions.bun === 'string';

/** The only keys a written Error may carry. */
const ERROR_KEYS = new Set(['type', 'message', 'stack', 'code', 'data', 'cause', 'errors']);

const exported: OtelLogRecord[] = [];

const services = { logger, storage: {} } as unknown as HandlerServices;

beforeAll(async () => {
  mockConfig.logsPath = mkdtempSync(join(tmpdir(), 'mcp-written-records-'));
  await logger.initialize('debug');
  setOtelLogSink({ emit: (record) => exported.push(record) });
});

afterAll(async () => {
  setOtelLogSink(undefined);
  await logger.close();
  if (mockConfig.logsPath) rmSync(mockConfig.logsPath, { recursive: true, force: true });
});

beforeEach(() => {
  lines.process.length = 0;
  lines.interactions.length = 0;
  exported.length = 0;
});

/** A request context carrying `extra`, which the logger flattens into the record. */
function context(extra: Record<string, unknown> = {}): RequestContext {
  return { requestId: 'req-written', timestamp: '2026-10-06T00:00:00.000Z', extra };
}

/** The one process-log line whose message starts with `prefix`, as written. */
function writtenLine(prefix: string): string {
  const found = lines.process.filter((line) =>
    String((JSON.parse(line) as Written).msg).startsWith(prefix),
  );
  expect(found).toHaveLength(1);
  return found[0] as string;
}

/** The one process-log record whose message starts with `prefix`, parsed. */
function written(prefix: string): Written {
  return JSON.parse(writtenLine(prefix)) as Written;
}

/** The attributes of the one exported OTel record whose body starts with `prefix`. */
function exportedAttributes(prefix: string): Written {
  const found = exported.filter((record) => record.body.startsWith(prefix));
  expect(found).toHaveLength(1);
  return found[0]?.attributes as Written;
}

/** Every key of a written Error tree outside {@link ERROR_KEYS}, as dotted paths. */
function foreignKeys(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => foreignKeys(item, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, child]) => [
    ...(ERROR_KEYS.has(key) ? [] : [`${path}.${key}`]),
    ...(key === 'cause' || key === 'errors' ? foreignKeys(child, `${path}.${key}`) : []),
  ]);
}

/** What `fn` throws. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** The rejection a `fetch` to a closed loopback port settles with, on this runtime. */
async function refusedFetch(): Promise<unknown> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await fetch(`http://127.0.0.1:${port}/sk-test-0000/reverse?api-key=QSECRET-9999`);
  } catch (error) {
    return error;
  }
  throw new Error('expected the fetch to be refused');
}

/** Drives one `tools/call` through the factory, with `wire` as the `notifications/message` sink. */
async function callTool(
  def: unknown,
  args: Record<string, unknown>,
  wire = vi.fn(async () => {}),
): Promise<CallToolResult> {
  const handler = createToolHandler(def as AnyToolDefinition, services, {});
  return (await handler(args, makeServerContext({ log: wire }))) as CallToolResult;
}

const ok = z.object({ ok: z.boolean().describe('ok') });

// ---------------------------------------------------------------------------
// #646 — one serializer for every Error
// ---------------------------------------------------------------------------

describe('an Error in log data (#646)', () => {
  it('writes a plain Error under any key as its type, message, and stack', () => {
    logger.warning('plain failure', context({ error: new Error('plain failure message') }));

    expect(written('plain failure').error).toEqual({
      type: 'Error',
      message: 'plain failure message',
      stack: expect.stringContaining('plain failure message'),
    });
  });

  it('copies no other own property, under err, under another key, or nested', () => {
    const rejection = Object.assign(new TypeError('Unable to connect.'), {
      code: 'ConnectionRefused',
      path: 'http://127.0.0.1:3619/sk-test-0000/reverse?api-key=QSECRET-9999',
      errno: 0,
      input: 'http://exa mple.com/sk-test-0000/x',
      sourceURL: '/srv/app/handler.js',
      line: 36,
    });
    const expected = {
      type: 'TypeError',
      message: 'Unable to connect.',
      stack: expect.any(String),
      code: 'ConnectionRefused',
    };

    logger.warning('own props: data', context({ error: rejection, attempt: { last: rejection } }));
    logger.warning('own props: err key', context({ err: rejection }));
    logger.error('own props: argument', rejection, context());

    for (const prefix of ['own props: data', 'own props: err key', 'own props: argument']) {
      const line = writtenLine(prefix);
      expect(line).not.toContain('sk-test-0000');
      expect(line).not.toContain('/srv/app');
    }
    expect(written('own props: data')).toMatchObject({
      error: expected,
      attempt: { last: expected },
    });
    expect(written('own props: err key').err).toEqual(expected);
    expect(written('own props: argument').err).toEqual(expected);
  });

  it('writes a refused fetch under error, under err, and as the error argument without its URL', async () => {
    const rejection = await refusedFetch();

    logger.warning('refused: data', context({ error: rejection }));
    logger.warning('refused: err key', context({ err: rejection }));
    logger.error('refused: argument', rejection as Error, context());

    for (const [prefix, key] of [
      ['refused: data', 'error'],
      ['refused: err key', 'err'],
      ['refused: argument', 'err'],
    ] as const) {
      const line = writtenLine(prefix);
      expect(line).not.toContain('QSECRET-9999');
      const value = JSON.parse(line)[key] as Written;
      expect(value).toMatchObject({
        type: 'TypeError',
        message: expect.any(String),
        stack: expect.any(String),
      });
      expect(foreignKeys(value)).toEqual([]);
    }
    // The OTLP export writes the same object as the process log.
    expect(exportedAttributes('refused: data').error).toEqual(written('refused: data').error);
  });

  it.runIf(IS_BUN)('keeps Bun’s string code on a refused fetch', async () => {
    const rejection = await refusedFetch();

    logger.warning('refused: bun code', context({ error: rejection }));

    expect(written('refused: bun code').error.code).toBe('ConnectionRefused');
  });

  it.skipIf(IS_BUN)('keeps the cause that explains Node’s fetch failed', async () => {
    const rejection = await refusedFetch();

    logger.warning('refused: node cause', context({ error: rejection }));
    logger.error('refused: node argument', rejection as Error, context());

    const cause = {
      type: 'Error',
      message: expect.stringMatching(/^connect ECONNREFUSED 127\.0\.0\.1:\d+$/),
      stack: expect.any(String),
      code: 'ECONNREFUSED',
    };
    expect(written('refused: node cause').error).toMatchObject({ message: 'fetch failed', cause });
    expect(written('refused: node cause').error.cause).toEqual(cause);
    expect(written('refused: node argument').err.cause).toEqual(cause);
  });

  it('writes the error an unparseable URL throws without its input', () => {
    const invalid = thrownBy(
      () => new URL('http://exa mple.com/sk-test-0000/x?api-key=QSECRET-9999'),
    );

    logger.warning('bad url: data', context({ error: invalid }));
    logger.error('bad url: argument', invalid as Error, context());

    for (const record of [written('bad url: data').error, written('bad url: argument').err]) {
      expect(record).toMatchObject({ type: 'TypeError', code: 'ERR_INVALID_URL' });
      expect(record).not.toHaveProperty('input');
      expect(foreignKeys(record)).toEqual([]);
    }
  });

  it('keeps an McpError’s numeric code and its data, walked like any other value', () => {
    const failure = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'inner', {
      reason: 'upstream_down',
      status: 503,
      apiKey: 'sk-live-1',
      recovery: { hint: 'Retry in a minute.' },
    });

    logger.warning('mcp error', context({ error: failure }));

    expect(written('mcp error').error).toEqual({
      type: 'McpError',
      message: 'inner',
      stack: expect.any(String),
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_down',
        status: 503,
        apiKey: '[REDACTED]',
        recovery: { hint: 'Retry in a minute.' },
      },
    });
  });

  it('writes a cause and an AggregateError’s errors in the same shape', () => {
    const root = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      port: 1,
    });
    const all = new AggregateError(
      [new TypeError('fetch failed', { cause: root }), 'not an error', new RangeError('second')],
      'all attempts failed',
    );
    const loop = new Error('loop');
    loop.cause = loop;

    logger.warning(
      'aggregate',
      context({ failure: all, loop, reason: new Error('x', { cause: 'plain' }) }),
    );

    const record = written('aggregate');
    expect(record.failure).toEqual({
      type: 'AggregateError',
      message: 'all attempts failed',
      stack: expect.any(String),
      errors: [
        {
          type: 'TypeError',
          message: 'fetch failed',
          stack: expect.any(String),
          cause: {
            type: 'Error',
            message: 'connect ECONNREFUSED 127.0.0.1:1',
            stack: expect.any(String),
            code: 'ECONNREFUSED',
          },
        },
        'not an error',
        { type: 'RangeError', message: 'second', stack: expect.any(String) },
      ],
    });
    expect(record.loop).toEqual({
      type: 'Error',
      message: 'loop',
      stack: expect.any(String),
      cause: '[Circular]',
    });
    expect(record.reason.cause).toBe('plain');
  });

  it.each([
    ['an abort reason', () => AbortSignal.abort().reason, 'AbortError'],
    [
      'a constructed timeout',
      () => new DOMException('The operation timed out.', 'TimeoutError'),
      'TimeoutError',
    ],
  ])(
    'writes %s under a non-err key instead of throwing out of the log call',
    (_label, make, type) => {
      expect(() => logger.warning(`dom: ${type}`, context({ error: make() }))).not.toThrow();

      const { error } = written(`dom: ${type}`);
      expect(error).toMatchObject({ type, message: expect.any(String) });
      expect(foreignKeys(error)).toEqual([]);
    },
  );

  it('writes an AbortSignal.timeout reason under a non-err key', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    expect(() => logger.warning('dom: timeout', context({ error: signal.reason }))).not.toThrow();

    expect(written('dom: timeout').error).toMatchObject({ type: 'TimeoutError' });
  });

  it('lets a handler log an abort reason and succeed, mirroring it as { type, message }', async () => {
    const logsAbort = tool('written_logs_abort', {
      description: 'Logs an abort reason.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.warning('aborted', { error: AbortSignal.abort().reason });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    const result = await callTool(logsAbort, {}, wire);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true });
    expect(written('aborted').error).toMatchObject({ type: 'AbortError' });
    expect(wire).toHaveBeenCalledWith('warning', {
      message: 'aborted',
      error: { type: 'AbortError', message: expect.any(String) },
    });
  });

  it('keeps the error argument’s exception.* attributes and the wire error string as they were', async () => {
    const failing = tool('written_logs_error', {
      description: 'Logs an error argument.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.error('upstream failed (error arg)', new TypeError('boom'), { attempt: 2 });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    await callTool(failing, {}, wire);

    expect(wire).toHaveBeenCalledWith('error', {
      message: 'upstream failed (error arg)',
      attempt: 2,
      error: 'boom',
    });
    const attributes = exportedAttributes('upstream failed (error arg)');
    expect(attributes).toMatchObject({
      'exception.type': 'TypeError',
      'exception.message': 'boom',
      'exception.stacktrace': expect.stringContaining('TypeError: boom'),
    });
    expect(attributes).not.toHaveProperty('err');
    expect(written('upstream failed (error arg)').err).toEqual({
      type: 'TypeError',
      message: 'boom',
      stack: expect.stringContaining('TypeError: boom'),
    });
  });
});

// ---------------------------------------------------------------------------
// #649 — nested data, cycles, the depth bound, and redaction
// ---------------------------------------------------------------------------

describe('nested log data (#649)', () => {
  it('keeps nested plain data in the process log and the OTLP export', () => {
    const upstream = { response: { body: { items: [{ id: 1 }] } } };

    logger.info('nested data', context({ upstream }));

    expect(written('nested data').upstream).toEqual(upstream);
    expect(exportedAttributes('nested data').upstream).toEqual(upstream);
  });

  it('keeps a chat transcript’s message content in interactions.log', () => {
    logger.logInteraction('OpenRouterRequest', {
      context: { requestId: 'req-llm' },
      request: {
        model: 'test/model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image.' },
              { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
            ],
          },
        ],
      },
    });
    logger.logInteraction('OpenRouterResponse', {
      context: { requestId: 'req-llm' },
      response: {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'A cat.' }, finish_reason: 'stop' },
        ],
      },
    });

    const [request, response] = lines.interactions.map((line) => JSON.parse(line) as Written);
    expect(request?.request.messages[0].content).toEqual([
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
    ]);
    expect(response?.response.choices[0].message).toEqual({ role: 'assistant', content: 'A cat.' });
  });

  it('writes a cycle once, with [Circular] at the back-reference, and a shared object in full', () => {
    const root: Record<string, unknown> = { name: 'root' };
    root.self = root;
    root.kids = [{ parent: root }];
    const shared = { id: 's' };

    logger.info('cycle', context({ root, pair: [shared, shared] }));

    const record = written('cycle');
    expect(record.root).toEqual({
      name: 'root',
      self: '[Circular]',
      kids: [{ parent: '[Circular]' }],
    });
    expect(record.pair).toEqual([{ id: 's' }, { id: 's' }]);
  });

  it('logs a 20,000-level object without throwing, ending in [MaxDepth] past the bound', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20_000; i++) deep = { n: deep };

    expect(() => logger.info('deep', context({ deep }))).not.toThrow();

    // `deep` sits at depth 1; objects through depth 15 are written, depth 16 is the marker.
    let cursor: unknown = written('deep').deep;
    let objectLevels = 0;
    while (cursor !== null && typeof cursor === 'object') {
      cursor = (cursor as Written).n;
      objectLevels++;
    }
    expect(objectLevels).toBe(15);
    expect(cursor).toBe('[MaxDepth]');
  });

  it('drops an AbortSignal nested at depths 1 to 6 without reading anything off it', () => {
    // Every trap that reads a property or lists keys: a walk that copied the instance, read its
    // `aborted` getter, or looked for a `toJSON` on it would land here. The prototype check does not.
    const reads: PropertyKey[] = [];
    const tracked = new Proxy(new AbortController().signal, {
      get(target, prop) {
        reads.push(prop);
        return Reflect.get(target, prop);
      },
      getOwnPropertyDescriptor(target, prop) {
        reads.push(prop);
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      has(target, prop) {
        reads.push(prop);
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        reads.push('[[OwnPropertyKeys]]');
        return Reflect.ownKeys(target);
      },
    });
    const level = (n: number): Record<string, unknown> =>
      n > 6 ? { end: true } : { kept: n, signal: tracked, child: level(n + 1) };

    logger.info('signals', context(level(1)));

    const record = written('signals');
    let cursor: Written = record;
    for (let n = 1; n <= 6; n++) {
      expect(cursor.kept).toBe(n);
      expect(cursor).not.toHaveProperty('signal');
      cursor = cursor.child;
    }
    expect(cursor).toEqual({ end: true });
    expect(reads).toEqual([]);
  });

  it('redacts a sensitive field past the depths pino’s redact paths reach', () => {
    logger.info(
      'deep secret',
      context({
        a: { b: { c: { token: 'tok-d3', kept: 'visible' } } },
        list: [[{ apiKey: 'key-in-a-list' }]],
      }),
    );

    expect(writtenLine('deep secret')).not.toMatch(/tok-d3|key-in-a-list/);
    expect(written('deep secret')).toMatchObject({
      a: { b: { c: { token: '[REDACTED]', kept: 'visible' } } },
      list: [[{ apiKey: '[REDACTED]' }]],
    });
  });

  it('writes each cause node’s data in a handleError record', () => {
    const inner = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'inner', {
      reason: 'upstream_down',
      status: 503,
      recovery: { hint: 'Retry in a minute.' },
    });
    const outer = new McpError(
      JsonRpcErrorCode.InternalError,
      'outer',
      { reason: 'wrapped' },
      { cause: inner },
    );

    ErrorHandler.handleError(outer, { operation: 'tool:cause_probe', context: context() });

    const { causeChain } = written('Error in tool:cause_probe').errorData;
    expect(causeChain[0].data).toEqual({ reason: 'wrapped' });
    expect(causeChain[1].data).toEqual({
      reason: 'upstream_down',
      status: 503,
      recovery: { hint: 'Retry in a minute.' },
    });
  });

  it('writes each cause node’s data without originalStack under includeStack: false', () => {
    const cause = () =>
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'inner', {
        reason: 'upstream_down',
        originalStack: 'Error: inner\n    at service.ts:1:1',
      });
    const fail = (includeStack: boolean, operation: string) =>
      ErrorHandler.handleError(
        new McpError(
          JsonRpcErrorCode.InternalError,
          'outer',
          { reason: 'wrapped' },
          { cause: cause() },
        ),
        { operation, includeStack, context: context() },
      );

    fail(true, 'stacked');
    fail(false, 'stackless');

    expect(written('Error in stacked').errorData.causeChain[1].data).toEqual({
      reason: 'upstream_down',
      originalStack: 'Error: inner\n    at service.ts:1:1',
    });
    const stackless = written('Error in stackless');
    expect(stackless).not.toHaveProperty('stack');
    expect(stackless.errorData.causeChain).toEqual([
      { name: 'McpError', message: 'outer', depth: 0, data: { reason: 'wrapped' } },
      { name: 'McpError', message: 'inner', depth: 1, data: { reason: 'upstream_down' } },
    ]);
  });

  it('writes an argument rejection’s aliased keys and issue paths as the wire carries them', async () => {
    const search = tool('written_search', {
      description: 'Alias probe.',
      input: z.object({ maxResults: z.number().describe('Max results.') }),
      output: ok,
      handler: () => ({ ok: true }),
    });

    const result = await callTool(search, { max_results: 'ten' });

    const wireData = (result.structuredContent as Written).error.data as Written;
    const { errorData } = written('Error in tool:written_search');
    expect(errorData.input.aliased).toEqual([{ alias: 'max_results', target: 'maxResults' }]);
    expect(errorData.input).toEqual(wireData.input);
    expect(errorData.issues[0].path).toEqual(['maxResults']);
    expect(errorData.issues).toEqual(wireData.issues);
  });

  it('writes a union rejection’s branch errors with their paths', async () => {
    const unionProbe = tool('written_union', {
      description: 'Union probe.',
      input: z.object({
        target: z
          .union([
            z.object({ id: z.number().describe('Numeric id.') }),
            z.object({ name: z.string().describe('Name.') }),
          ])
          .describe('Target.'),
      }),
      output: ok,
      handler: () => ({ ok: true }),
    });

    const result = await callTool(unionProbe, { target: { id: 'x' } });

    const wireData = (result.structuredContent as Written).error.data as Written;
    const [issue] = written('Error in tool:written_union').errorData.issues as Written[];
    expect(issue?.path).toEqual(['target']);
    expect(issue?.errors[0][0].path).toEqual(['id']);
    expect(issue).toEqual(wireData.issues[0]);
  });
});

// ---------------------------------------------------------------------------
// The walk's bounds, unreadable values, and the key matcher (#695, #696)
// ---------------------------------------------------------------------------

/** `levels` levels, each referring to the next three times: `levels + 1` objects, 3^levels paths. */
function sharedGraph(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < levels; i++) node = { a: node, b: node, c: node };
  return node;
}

/** One value of each kind a read throws on, the throwing accessor on an `Error` included. */
function unreadables(): Record<string, unknown> {
  const { proxy: revoked, revoke } = Proxy.revocable({ a: 1 }, {});
  revoke();
  return {
    getter: {
      fine: 1,
      get boom(): never {
        throw new Error('getter threw');
      },
    },
    ownKeysTrap: new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys threw');
        },
      },
    ),
    revoked,
    codeAccessor: Object.defineProperty(new Error('code accessor'), 'code', {
      get() {
        throw new Error('code getter threw');
      },
    }),
    messageAccessor: Object.defineProperty(new TypeError('unused'), 'message', {
      get() {
        throw new Error('message getter threw');
      },
    }),
  };
}

/** The sensitive keys every sink must redact, each holding a value unique to `depth`. */
function secretsAt(depth: number): Record<string, unknown> {
  return {
    accessToken: `SECRET-${depth}-at`,
    Authorization: `SECRET-${depth}-auth`,
    API_KEY: `SECRET-${depth}-api`,
    'x-api-key': `SECRET-${depth}-xak`,
    'X-Api-Key': `SECRET-${depth}-XAK`,
    upstream_private_key: `SECRET-${depth}-upk`,
    kept: `visible-${depth}`,
  };
}

/** {@link secretsAt} at depths 1 to 6 of a value logged as the record's data. */
function secretsAtDepths1To6(): Record<string, unknown> {
  let data: Record<string, unknown> = secretsAt(6);
  for (let depth = 5; depth >= 1; depth--) data = { ...secretsAt(depth), child: data };
  return data;
}

/** Checks a written copy of {@link secretsAtDepths1To6}: every key redacted, `kept` intact. */
function expectRedactedAtDepths1To6(written: Written): void {
  let cursor = written;
  for (let depth = 1; depth <= 6; depth++) {
    expect(cursor).toMatchObject({
      accessToken: '[REDACTED]',
      Authorization: '[REDACTED]',
      API_KEY: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      upstream_private_key: '[REDACTED]',
      kept: `visible-${depth}`,
    });
    cursor = cursor.child;
  }
}

/** Token counters a provider reports, which no sink may redact. */
const USAGE = {
  max_tokens: 512,
  maxTokens: 512,
  tokenizer: 'cl100k',
  usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
};

describe('the walk’s bounds and unreadable values (#695)', () => {
  it('logs a 17-object shared-reference graph in well under 250 ms, marked [Truncated] on every sink', async () => {
    const graph = sharedGraph(16);
    const logsGraph = tool('written_logs_graph', {
      description: 'Logs a shared-reference value.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.info('graph', { value: graph });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    const start = process.threadCpuUsage();
    const result = await callTool(logsGraph, {}, wire);
    logger.logInteraction('GraphInteraction', { value: graph });
    const { user, system } = process.threadCpuUsage(start);

    // The four walks take 8–27 ms on Bun and Node, coverage included; unbounded, the call took 20–41 s.
    expect((user + system) / 1000).toBeLessThan(250);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true });
    expect(writtenLine('graph')).toContain('"[Truncated]"');
    expect(JSON.stringify(exportedAttributes('graph'))).toContain('"[Truncated]"');
    expect(lines.interactions.join('\n')).toContain('"[Truncated]"');
    expect(JSON.stringify(wire.mock.calls)).toContain('"[Truncated]"');
  });

  it('logs data that getters build on every read within the walk’s bound on every sink', async () => {
    /** A plain object whose three getters each build a fresh object of the same kind on every read. */
    const built = (): object => {
      const node = {};
      for (const key of ['a', 'b', 'c']) {
        Object.defineProperty(node, key, { enumerable: true, get: built });
      }
      return node;
    };
    const logsBuilt = tool('written_logs_built', {
      description: 'Logs a value built on every read.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.info('built', { value: built() });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    const start = process.threadCpuUsage();
    const result = await callTool(logsBuilt, {}, wire);
    logger.logInteraction('BuiltInteraction', { value: built() });
    const { user, system } = process.threadCpuUsage(start);

    expect((user + system) / 1000).toBeLessThan(250);
    expect(result.structuredContent).toEqual({ ok: true });
    for (const [sink, json] of Object.entries({
      process: writtenLine('built'),
      otlp: JSON.stringify(exportedAttributes('built')),
      interactions: lines.interactions.join('\n'),
      mirror: JSON.stringify(wire.mock.calls),
    })) {
      // 14 million objects at depth 16, each counted ten against the walk's 400,000 reads.
      expect(json, sink).toContain('"[Truncated]"');
      expect(json.length, sink).toBeLessThan(2_000_000);
    }
  });

  it('logs data that getters build with long string fields within 16 MiB of characters on every sink', async () => {
    const text = 'x'.repeat(200);
    /** Three getters each building another like it, beside 50 fields of one 200-character string. */
    const built = (): object => {
      const node: Record<string, unknown> = {};
      for (const key of ['a', 'b', 'c']) {
        Object.defineProperty(node, key, { enumerable: true, get: built });
      }
      for (let i = 0; i < 50; i++) node[`f${i}`] = text;
      return node;
    };
    const logsWide = tool('written_logs_built_wide', {
      description: 'Logs a value with long string fields built on every read.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.info('wide', { value: built() });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    const start = process.threadCpuUsage();
    const result = await callTool(logsWide, {}, wire);
    logger.logInteraction('WideInteraction', { value: built() });
    const { user, system } = process.threadCpuUsage(start);

    // Four walks and three written lines of about 16 MiB each.
    expect((user + system) / 1000).toBeLessThan(1_000);
    expect(result.structuredContent).toEqual({ ok: true });
    for (const [sink, json] of Object.entries({
      process: writtenLine('wide'),
      otlp: JSON.stringify(exportedAttributes('wide')),
      interactions: lines.interactions.join('\n'),
      mirror: JSON.stringify(wire.mock.calls),
    })) {
      // Bounded by the walk's reads alone, each sink wrote 57 MB.
      expect(json, sink).toContain('"[Truncated]"');
      expect(json.length, sink).toBeLessThan(17_000_000);
    }
  });

  it('writes each unreadable value as [Unreadable] on every sink, and the call succeeds', async () => {
    const logsUnreadable = tool('written_logs_unreadable', {
      description: 'Logs values whose reads throw.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.info('unreadable', {
          nested: unreadables(),
          deep: { a: { b: { c: { d: unreadables() } } } },
        });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    const result = await callTool(logsUnreadable, {}, wire);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true });
    const logged = {
      getter: { fine: 1, boom: '[Unreadable]' },
      ownKeysTrap: '[Unreadable]',
      revoked: '[Unreadable]',
      codeAccessor: { type: 'Error', message: 'code accessor', stack: expect.any(String) },
      // Whether `stack` can still be read once `message` throws differs by runtime and stack formatter.
      messageAccessor: expect.objectContaining({ type: 'TypeError', message: '[Unreadable]' }),
    };
    for (const record of [written('unreadable'), exportedAttributes('unreadable')]) {
      expect(record.nested).toEqual(logged);
      expect(record.deep.a.b.c.d).toEqual(logged);
    }
    const mirrored = {
      getter: { fine: 1, boom: '[Unreadable]' },
      ownKeysTrap: '[Unreadable]',
      revoked: '[Unreadable]',
      codeAccessor: { type: 'Error', message: 'code accessor' },
      messageAccessor: { type: 'TypeError', message: '[Unreadable]' },
    };
    expect(wire).toHaveBeenCalledWith('info', {
      message: 'unreadable',
      nested: mirrored,
      deep: { a: { b: { c: { d: mirrored } } } },
    });
  });

  it('writes an unreadable value in interactions.log and under the error argument without throwing', () => {
    expect(() =>
      logger.logInteraction('UnreadableInteraction', { payload: unreadables() }),
    ).not.toThrow();
    const failing = unreadables().codeAccessor as Error;
    expect(() => logger.error('unreadable error arg', failing, context())).not.toThrow();

    const [interaction] = lines.interactions.map((line) => JSON.parse(line) as Written);
    expect(interaction?.payload).toMatchObject({
      getter: { fine: 1, boom: '[Unreadable]' },
      ownKeysTrap: '[Unreadable]',
      revoked: '[Unreadable]',
    });
    expect(written('unreadable error arg').err).toEqual({
      type: 'Error',
      message: 'code accessor',
      stack: expect.any(String),
    });
  });

  it('writes the error argument before caller data, so a line the read ceiling cuts still says what failed', async () => {
    const failure = new Error('the error that must survive');
    /** 250,000 distinct rows: 500,000 reads, past the walk's 400,000. */
    const rows = () => Array.from({ length: 250_000 }, (_, i) => ({ i }));
    const logsCut = tool('written_logs_cut', {
      description: 'Logs an error beside data the walk cuts.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.error('cut: ctx.log', failure, { rows: rows() });
        return { ok: true };
      },
    });

    logger.error('cut: logger', failure, context({ rows: rows() }));
    await callTool(logsCut, {});

    for (const prefix of ['cut: logger', 'cut: ctx.log']) {
      const line = writtenLine(prefix);
      expect(line, prefix).toContain('"[Truncated]"');
      const record = JSON.parse(line) as Written;
      expect(record.err, prefix).toEqual({
        type: 'Error',
        message: 'the error that must survive',
        stack: failure.stack,
      });
      // The walked record opens with it, ahead of the context's own fields.
      expect(Object.keys(record).indexOf('err'), prefix).toBe(5);
    }
  });

  it('writes ctx.log data it cannot read at all as data: [Unreadable] on the process log and the mirror alike', async () => {
    const logsRevoked = tool('written_logs_revoked', {
      description: 'Logs a revoked Proxy as its data.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        ctx.log.info('revoked data', proxy);
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    const result = await callTool(logsRevoked, {}, wire);

    expect(result.structuredContent).toEqual({ ok: true });
    expect(written('revoked data')).toMatchObject({ data: '[Unreadable]' });
    await vi.waitFor(() =>
      expect(wire).toHaveBeenCalledWith('info', { message: 'revoked data', data: '[Unreadable]' }),
    );
  });

  describe('data the logger itself cannot read, passed straight to it', () => {
    const revoked = (): any => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const getterExtra = () => ({
      fine: 1,
      get boom(): never {
        throw new Error('extra getter threw');
      },
    });
    const getterContext = (): any => ({
      timestamp: '2026-10-06T00:00:00.000Z',
      get requestId(): never {
        throw new Error('requestId getter threw');
      },
    });
    /** The one interactions.log record, parsed. */
    const interaction = (): Written => {
      expect(lines.interactions).toHaveLength(1);
      return JSON.parse(lines.interactions[0] as string) as Written;
    };

    it.each<[string, () => void, () => void]>([
      [
        'an extra field whose getter throws',
        () => logger.info('direct: extra getter', context(getterExtra())),
        () => {
          const expected = { requestId: 'req-written', fine: 1, boom: '[Unreadable]' };
          expect(written('direct: extra getter')).toMatchObject(expected);
          expect(exportedAttributes('direct: extra getter')).toMatchObject(expected);
        },
      ],
      [
        'a revoked-Proxy extra',
        () => logger.info('direct: extra revoked', { ...context(), extra: revoked() }),
        () =>
          expect(written('direct: extra revoked')).toMatchObject({
            requestId: 'req-written',
            extra: '[Unreadable]',
          }),
      ],
      [
        'a revoked-Proxy context',
        () => logger.info('direct: context revoked', revoked()),
        () => expect(written('direct: context revoked')).toMatchObject({ context: '[Unreadable]' }),
      ],
      [
        'a context whose requestId getter throws',
        () => logger.warning('direct: context getter', getterContext()),
        () =>
          expect(written('direct: context getter')).toMatchObject({
            requestId: '[Unreadable]',
            timestamp: '2026-10-06T00:00:00.000Z',
          }),
      ],
      [
        'a revoked Proxy in the error-or-context argument',
        () => logger.error('direct: error arg revoked', revoked()),
        () =>
          expect(written('direct: error arg revoked')).toMatchObject({ context: '[Unreadable]' }),
      ],
      [
        'interaction data with a getter that throws',
        () => logger.logInteraction('DirectGetter', getterExtra()),
        () =>
          expect(interaction()).toMatchObject({
            interactionName: 'DirectGetter',
            fine: 1,
            boom: '[Unreadable]',
          }),
      ],
      [
        'revoked-Proxy interaction data',
        () => logger.logInteraction('DirectRevoked', revoked()),
        () =>
          expect(interaction()).toMatchObject({
            interactionName: 'DirectRevoked',
            data: '[Unreadable]',
          }),
      ],
    ])('writes %s as [Unreadable] without throwing', (_label, call, check) => {
      expect(call).not.toThrow();
      check();
    });
  });
});

describe('the OTLP export of an Error whose fields throw on read (#697)', () => {
  it.each([
    ['name', 'exception.type'],
    ['message', 'exception.message'],
    ['stack', 'exception.stacktrace'],
  ])(
    'exports an Error whose %s getter throws as [Unreadable] in %s, and the log call succeeds',
    (field, attribute) => {
      const failing = Object.defineProperty(new TypeError('readable message'), field, {
        get() {
          throw new Error(`${field} getter threw`);
        },
      });

      expect(() => logger.error(`otel unreadable ${field}`, failing, context())).not.toThrow();

      expect(exportedAttributes(`otel unreadable ${field}`)[attribute]).toBe('[Unreadable]');
      expect(written(`otel unreadable ${field}`).err[field === 'name' ? 'type' : field]).toBe(
        '[Unreadable]',
      );
    },
  );

  it('writes the record for a function-shaped Error, which the walk drops, on every sink', () => {
    const shaped = Object.setPrototypeOf(function shaped() {}, Error.prototype) as Error;
    expect(shaped instanceof Error).toBe(true);

    expect(() => logger.error('function-shaped error', shaped, context())).not.toThrow();

    expect(written('function-shaped error')).toMatchObject({ requestId: 'req-written', level: 50 });
    expect(written('function-shaped error')).not.toHaveProperty('err');
    const attributes = exportedAttributes('function-shaped error');
    expect(attributes).toMatchObject({ requestId: 'req-written' });
    expect(Object.keys(attributes).filter((key) => key.startsWith('exception.'))).toEqual([]);
  });
});

describe('a stack an error shares with its parent', () => {
  /** How many times `stack` appears in `text`. */
  const occurrences = (text: string, stack: string) => text.split(JSON.stringify(stack)).length - 1;

  it('writes a rethrown tryCatch error’s stack once, under err, through every nested cause', async () => {
    const throwSite = () => {
      throw new TypeError('at the throw site');
    };
    const rethrown = (await ErrorHandler.tryCatch(
      () => ErrorHandler.tryCatch(throwSite, { operation: 'inner', context: context() }),
      { operation: 'outer', context: context() },
    ).catch((error: unknown) => error)) as Error;
    const stack = rethrown.stack as string;
    // The precondition the rule exists for: each level of the chain carries the throw site's stack.
    expect((rethrown.cause as Error).stack).toBe(stack);
    expect(((rethrown.cause as Error).cause as Error).stack).toBe(stack);

    logger.error('rethrown', rethrown, context());

    const line = writtenLine('rethrown');
    expect(occurrences(line, stack)).toBe(1);
    const { err } = JSON.parse(line) as Written;
    expect(err.stack).toBe(stack);
    expect(err.cause).not.toHaveProperty('stack');
    expect(err.cause.cause).toMatchObject({ type: 'TypeError', message: 'at the throw site' });
    expect(err.cause.cause).not.toHaveProperty('stack');
  });

  it('keeps a cause’s or an AggregateError member’s own distinct stack', () => {
    const inner = new RangeError('inner');
    const outer = new Error('outer', { cause: inner });
    const sameAsParent = new Error('member');
    const aggregate = new AggregateError([sameAsParent, inner], 'aggregate');
    sameAsParent.stack = aggregate.stack as string;

    logger.warning('distinct stacks', context({ outer, aggregate }));

    const record = written('distinct stacks');
    expect(record.outer.stack).toBe(outer.stack);
    expect(record.outer.cause.stack).toBe(inner.stack);
    expect(record.aggregate.stack).toBe(aggregate.stack);
    expect(record.aggregate.errors[0]).toEqual({ type: 'Error', message: 'member' });
    expect(record.aggregate.errors[1].stack).toBe(inner.stack);
  });
});

describe('one key matcher on every sink (#696)', () => {
  it('redacts word-matched and adjacent-word keys at depths 1 to 6, keeping token counters', async () => {
    const logsSecrets = tool('written_logs_secrets', {
      description: 'Logs sensitive keys at depth.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.info('secrets at depth', { ...secretsAtDepths1To6(), ...USAGE });
        return { ok: true };
      },
    });
    const wire = vi.fn(async () => {});

    await callTool(logsSecrets, {}, wire);
    logger.logInteraction('OpenRouterResponse', {
      context: { requestId: 'req-llm' },
      ...secretsAtDepths1To6(),
      ...USAGE,
    });

    const [[, mirrored]] = wire.mock.calls as unknown as [[string, Written]];
    const [interaction] = lines.interactions.map((line) => JSON.parse(line) as Written);
    const sinks = {
      process: written('secrets at depth'),
      otlp: exportedAttributes('secrets at depth'),
      interactions: interaction as Written,
      mirror: mirrored,
    };
    for (const [sink, record] of Object.entries(sinks)) {
      expect(JSON.stringify(record), sink).not.toContain('SECRET-');
      expectRedactedAtDepths1To6(record);
      expect(record, sink).toMatchObject(USAGE);
    }
  });

  it('never redacts the correlation fields a record’s context supplies, whatever setSensitiveFields adds', () => {
    const correlation = {
      operation: 'op-corr',
      requestId: 'req-corr',
      sessionId: 'sess-corr',
      spanId: 'b'.repeat(16),
      tenantId: 'tenant-corr',
      timestamp: '2026-10-06T00:00:00.000Z',
      traceId: 'a'.repeat(32),
    };
    const nested = { sessionId: 'S-nested', requestId: 'R-nested', operation: 'O-nested' };
    const redacted = { sessionId: '[REDACTED]', requestId: '[REDACTED]', operation: '[REDACTED]' };
    // `session_id` is the JSDoc's old example; `id` alone matches every `…Id` field.
    sanitization.setSensitiveFields(['session_id', 'id', 'timestamp', 'operation']);
    try {
      logger.info('correlated', { ...correlation, extra: { upstream: nested } });
      logger.logInteraction('CorrelatedInteraction', { ...correlation, upstream: nested });
    } finally {
      setSensitiveNames(DEFAULT_SENSITIVE_FIELDS);
    }

    for (const [sink, record] of Object.entries({
      process: written('correlated'),
      otlp: exportedAttributes('correlated'),
    })) {
      expect(record, sink).toMatchObject(correlation);
      expect(record.upstream, sink).toEqual(redacted);
    }
    // interactions.log has no record context: every key in it is the caller's, matched like any other.
    const [interaction] = lines.interactions.map((line) => JSON.parse(line) as Written);
    expect(interaction).toMatchObject({ ...redacted, upstream: redacted });
    expect(JSON.stringify(interaction)).not.toMatch(/sess-corr|req-corr|op-corr/);
  });

  it('matches a caller’s own correlation-named key like any other when the context does not supply it', () => {
    const callers = { sessionId: 'S-caller', traceId: 'T-caller', tenantId: 'N-caller' };
    const redacted = { sessionId: '[REDACTED]', traceId: '[REDACTED]', tenantId: '[REDACTED]' };
    sanitization.setSensitiveFields(['session_id', 'trace_id', 'tenant_id']);
    try {
      // The context supplies requestId and timestamp only, as a stdio request with telemetry off does.
      logger.info('caller correlation', context(callers));
      logger.logInteraction('CallerCorrelation', callers);
    } finally {
      setSensitiveNames(DEFAULT_SENSITIVE_FIELDS);
    }

    const [interaction] = lines.interactions.map((line) => JSON.parse(line) as Written);
    for (const [sink, record] of Object.entries({
      process: written('caller correlation'),
      otlp: exportedAttributes('caller correlation'),
      interactions: interaction as Written,
    })) {
      expect(JSON.stringify(record), sink).not.toMatch(/S-caller|T-caller|N-caller/);
      expect(record, sink).toMatchObject(redacted);
    }
    expect(written('caller correlation')).toMatchObject({ requestId: 'req-written' });
  });
});

// ---------------------------------------------------------------------------
// #698 — a record key named after a field pino writes itself
// ---------------------------------------------------------------------------

describe('a record key named after a pino core field (#698)', () => {
  /** How many times `"key":` appears as a key in a written line. */
  const keyCount = (line: string, key: string) => line.split(`"${key}":`).length - 1;
  const colliding = { level: 'high', time: 'noon', msg: 'caller msg', pid: 7, hostname: 'h-1' };
  const renamed = {
    data_level: 'high',
    data_time: 'noon',
    data_msg: 'caller msg',
    data_pid: 7,
    data_hostname: 'h-1',
  };

  it('writes the process log line with one level, time, msg, and pid — its own — and the caller’s under data_*', () => {
    logger.info('core: process', context({ ...colliding, routed: 'by its own level' }));
    logger.info('core: numeric level', context({ level: 60 }));

    const line = writtenLine('core: process');
    for (const key of ['level', 'time', 'msg', 'pid']) expect(keyCount(line, key), key).toBe(1);
    expect(keyCount(line, 'hostname')).toBe(0);
    expect(JSON.parse(line)).toMatchObject({
      level: 30,
      time: expect.any(Number),
      msg: 'core: process',
      pid: process.pid,
      routed: 'by its own level',
      ...renamed,
    });
    // An info record is filed at 30, never at the 60 a transport would route to error.log.
    const numeric = writtenLine('core: numeric level');
    expect(keyCount(numeric, 'level')).toBe(1);
    expect(JSON.parse(numeric)).toMatchObject({ level: 30, data_level: 60 });
    expect(exportedAttributes('core: process')).toMatchObject(renamed);
    expect(exportedAttributes('core: process')).not.toHaveProperty('level');
  });

  it('writes the interactions.log line with one of each core field, the caller’s under data_*', () => {
    logger.logInteraction('CoreCollision', colliding);

    const [line] = lines.interactions as [string];
    for (const key of ['level', 'time', 'msg', 'pid', 'hostname']) {
      expect(keyCount(line, key), key).toBe(key === 'msg' ? 0 : 1);
    }
    expect(JSON.parse(line)).toMatchObject({
      level: 30,
      pid: process.pid,
      interactionName: 'CoreCollision',
      ...renamed,
    });
  });

  it('writes a caller key named after a base field (env, version) under data_*, keeping the server’s', () => {
    logger.info('core: base', context({ env: 'staging', version: '2.0' }));
    logger.logInteraction('BaseCollision', { env: 'staging', version: '2.0' });

    const line = writtenLine('core: base');
    for (const key of ['env', 'version']) expect(keyCount(line, key), key).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      env: 'testing',
      version: '1.0.0-test',
      data_env: 'staging',
      data_version: '2.0',
    });
    expect(exportedAttributes('core: base')).toMatchObject({
      data_env: 'staging',
      data_version: '2.0',
    });
    const [interaction] = lines.interactions as [string];
    expect(JSON.parse(interaction)).toMatchObject({ data_env: 'staging', data_version: '2.0' });
  });

  it('keeps a caller key already named data_level, moving the colliding one past it', () => {
    logger.info('core: both', context({ level: 'caller', data_level: 'also caller' }));

    expect(written('core: both')).toMatchObject({
      level: 30,
      data_level: 'also caller',
      data_data_level: 'caller',
    });
  });

  it('writes a caller’s err as data_err on a line that carries the error argument, on the process log and OTLP', () => {
    logger.error('core: err', new TypeError('boom'), context({ err: 'caller err' }));

    const line = writtenLine('core: err');
    expect(keyCount(line, 'err')).toBe(1);
    expect(JSON.parse(line)).toMatchObject({
      err: { type: 'TypeError', message: 'boom' },
      data_err: 'caller err',
    });
    const attributes = exportedAttributes('core: err');
    expect(attributes).toMatchObject({ 'exception.type': 'TypeError', data_err: 'caller err' });
    expect(attributes).not.toHaveProperty('err');
  });

  it('keeps a caller’s err as written on a line without an error argument, where it is the only one', () => {
    const failure = new RangeError('passed as data');
    logger.warning('core: err as data', context({ err: failure }));
    logger.logInteraction('ErrAsData', { err: 'caller err' });

    expect(written('core: err as data')).toMatchObject({
      err: { type: 'RangeError', message: 'passed as data' },
    });
    expect(written('core: err as data')).not.toHaveProperty('data_err');
    expect(exportedAttributes('core: err as data')).toMatchObject({ err: { type: 'RangeError' } });
    const [interaction] = lines.interactions as [string];
    expect(JSON.parse(interaction)).toMatchObject({ err: 'caller err' });
  });
});

// ---------------------------------------------------------------------------
// Every pino path into a written line goes through the walk
// ---------------------------------------------------------------------------

describe('pino write paths', () => {
  const data = {
    password: 'P-0',
    a: { token: 'T-1', b: { apiKey: 'K-2', c: { secret: 'S-3', kept: 'visible' } } },
  };

  it('writes the process log line as pino’s fixed fields around the walked record, nothing else', () => {
    logger.info('paths: process', context(data));
    logger.error('paths: error arg', new TypeError('boom'), context(data));

    const bindings = { requestId: 'req-written', timestamp: '2026-10-06T00:00:00.000Z', ...data };
    for (const [prefix, walked] of [
      ['paths: process', toLogValue(bindings)],
      // The error argument leads the walked record.
      ['paths: error arg', toLogValue({ err: new TypeError('boom'), ...bindings })],
    ] as const) {
      const line = writtenLine(prefix);
      expect(line).not.toMatch(/P-0|T-1|K-2|S-3/);
      const record = JSON.parse(line) as Written;
      // `level` and `time` from pino, `env`/`version`/`pid` from `base`, then the walked record, then `msg`.
      expect(Object.keys(record)).toEqual([
        'level',
        'time',
        'env',
        'version',
        'pid',
        ...Object.keys(walked as Written),
        'msg',
      ]);
      expect(record).toEqual({
        level: prefix === 'paths: process' ? 30 : 50,
        time: expect.any(Number),
        env: 'testing',
        version: '1.0.0-test',
        pid: process.pid,
        ...(walked as Written),
        ...(prefix === 'paths: error arg'
          ? { err: expect.objectContaining({ type: 'TypeError' }) }
          : {}),
        msg: prefix,
      });
    }
  });

  it('writes the interactions.log line as pino’s fixed fields around the walked record, nothing else', () => {
    logger.logInteraction('PathsInteraction', data);

    const [line] = lines.interactions;
    expect(line).not.toMatch(/P-0|T-1|K-2|S-3/);
    const record = JSON.parse(line as string) as Written;
    const walked = toLogValue({ interactionName: 'PathsInteraction', ...data }) as Written;
    expect(Object.keys(record)).toEqual([
      'level',
      'time',
      'pid',
      'hostname',
      ...Object.keys(walked),
    ]);
    expect(record).toEqual({
      level: 30,
      time: expect.any(Number),
      pid: process.pid,
      hostname: expect.any(String),
      ...walked,
    });
  });
});
