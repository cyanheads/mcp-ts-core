/**
 * @fileoverview The record `ErrorHandler.handleError` writes, read back from a
 * real pino instance: the record's one stack is the throw site's, written once
 * (#694), and a stack-free record — `includeStack: false`, or a cancellation —
 * carries none of the record's stack fields and writes every `Error` without
 * its stack, whoever supplied it (#650). pino is the real module with
 * its destination swapped for an in-memory stream, so `formatters.log`,
 * `serializers`, and `redact` run as in production: a stack the log-data walk
 * writes for an `Error` is visible here, where a logger mock never sees it.
 * @module tests/unit/utils/internal/error-handler/errorHandler.writtenRecords.test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { lines, mockConfig } = vi.hoisted(() => ({
  /** Every line the process logger wrote. */
  lines: [] as string[],
  mockConfig: {
    environment: 'testing',
    logRateLimitThreshold: 0,
    logRateLimitWindowMs: 60_000,
    logsPath: undefined as string | undefined,
    mcpServerVersion: '1.0.0-test',
    mcpTransportType: 'stdio',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
}));

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

/** The real pino, writing the process logger's lines to an in-memory stream. */
vi.mock('pino', async (importOriginal) => {
  const real = (await importOriginal<typeof import('pino')>()).default;
  const factory = ({ transport: _transport, ...options }: Record<string, unknown>) =>
    real(options, {
      write: (line: string) => {
        if ('base' in options) lines.push(line);
      },
    });
  return { default: Object.assign(factory, real) };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { databaseError, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { ErrorHandlerOptions } from '@/utils/internal/error-handler/types.js';
import { logger } from '@/utils/internal/logger.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A parsed log line, read by path. */
type Written = Record<string, any>;

beforeAll(async () => {
  mockConfig.logsPath = mkdtempSync(join(tmpdir(), 'mcp-error-records-'));
  await logger.initialize('debug');
});

afterAll(async () => {
  await logger.close();
  if (mockConfig.logsPath) rmSync(mockConfig.logsPath, { recursive: true, force: true });
});

beforeEach(() => {
  lines.length = 0;
});

/** The one process-log line for `operation`, raw and parsed. */
function record(operation: string): { line: string; written: Written } {
  const found = lines.filter((line) => {
    const msg = String((JSON.parse(line) as Written).msg);
    return msg.startsWith(`Error in ${operation}:`) || msg.startsWith(`Cancelled ${operation}:`);
  });
  expect(found).toHaveLength(1);
  const line = found[0] as string;
  return { line, written: JSON.parse(line) as Written };
}

/** `handleError` for `error`, returning what it returned. */
function handle(error: unknown, options: ErrorHandlerOptions): Error {
  return ErrorHandler.handleError(error, {
    ...options,
    context: {
      requestId: 'req-records',
      timestamp: '2026-10-06T00:00:00.000Z',
      ...options.context,
    },
  });
}

/** What `fn` throws. */
function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

/** Throws from a named frame, so the throw site is recognizable in a stack. */
function throwSiteOfTypeError(): never {
  throw new TypeError('boom at the throw site');
}

/** Throws `cause`'s consequence from a named frame of its own. */
function throwSiteWithCause(cause: Error): never {
  throw new TypeError('boom at the throw site', { cause });
}

/** Throws an error factory's result from a named frame. */
function throwSiteOfFactoryError(): never {
  throw databaseError('db down at the throw site');
}

/** How many times `stack` appears in a written JSON line. */
function occurrences(line: string, stack: string | undefined): number {
  const escaped = JSON.stringify(stack).slice(1, -1);
  return line.split(escaped).length - 1;
}

// ---------------------------------------------------------------------------
// #694 — the record's stack is the throw site, once
// ---------------------------------------------------------------------------

describe('the record’s stack (#694)', () => {
  it('is the thrown error’s own stack, written once, with no handleError frame', () => {
    const upstream = thrownBy(throwSiteOfTypeError);
    const thrown = thrownBy(() => throwSiteWithCause(upstream));

    const returned = handle(thrown, { operation: 'stack_once' });

    // The returned McpError carries the throw site's stack verbatim, header
    // line included: it names the class that was thrown.
    expect(returned).toBeInstanceOf(McpError);
    expect(returned.stack).toBe(thrown.stack);
    expect(returned.stack?.startsWith('TypeError: boom at the throw site\n')).toBe(true);
    const { line, written } = record('stack_once');
    expect(written.stack).toBe(thrown.stack);
    expect(written.stack).toContain('throwSiteWithCause');
    expect(written.errorData).not.toHaveProperty('originalStack');
    expect(line).not.toContain('errorHandler.ts');
    // The chain's first node is the thrown error itself: its stack is the record's.
    expect(occurrences(line, thrown.stack)).toBe(1);
    expect(line.split('throwSiteWithCause').length - 1).toBe(1);
    // The cause's own, different stack is still written once, on its node.
    expect(occurrences(line, upstream.stack)).toBe(1);
  });

  it('is written once after a nested tryCatch rebuilt the error', async () => {
    const rethrown = (await ErrorHandler.tryCatch(
      () => ErrorHandler.tryCatch(throwSiteOfTypeError, { operation: 'stack_inner' }),
      { operation: 'stack_outer' },
    ).catch((e: unknown) => e)) as McpError;

    const { line, written } = record('stack_outer');
    expect(written.stack).toBe(rethrown.stack);
    expect(rethrown.stack?.startsWith('TypeError: boom at the throw site\n')).toBe(true);
    // Both nodes — the inner tryCatch's rebuilt McpError and the TypeError it
    // wrapped — carry that same stack; neither repeats it.
    expect(written.errorData.causeChain).toMatchObject([
      { name: 'McpError', message: 'boom at the throw site', depth: 0 },
      { name: 'TypeError', message: 'boom at the throw site', depth: 1 },
    ]);
    for (const node of written.errorData.causeChain) expect(node).not.toHaveProperty('stack');
    expect(occurrences(line, rethrown.stack)).toBe(1);
  });

  it('starts at the caller’s line for an error factory’s error', () => {
    const thrown = thrownBy(throwSiteOfFactoryError);

    const returned = handle(thrown, { operation: 'stack_factory' });

    const { written } = record('stack_factory');
    expect(written.stack).toBe(thrown.stack);
    expect(returned.stack).toBe(thrown.stack);
    const [header, top] = String(written.stack).split('\n');
    expect(header).toBe('McpError: db down at the throw site');
    // The factory's own frame is cut: the top frame is the throw site's.
    expect(top).toContain('throwSiteOfFactoryError');
    expect(top).toContain('errorHandler.writtenRecords.test.ts:');
    expect(written.stack).not.toMatch(/types-global[\\/]errors\.[jt]s/);
  });

  it('is the same stack the error tryCatch rethrows starts with', async () => {
    const rethrown = (await ErrorHandler.tryCatch(throwSiteOfTypeError, {
      operation: 'stack_trycatch',
    }).catch((e: unknown) => e)) as McpError;

    expect(rethrown).toBeInstanceOf(McpError);
    const { written } = record('stack_trycatch');
    expect(rethrown.stack).toBe(written.stack);
    expect(rethrown.stack?.startsWith('TypeError: boom at the throw site\n')).toBe(true);
    /**
     * The top frame is the throw site in this file. It is matched by file, not by
     * function name: called through `tryCatch`'s parameter, JSC names the frame
     * `fn` under coverage instrumentation.
     */
    expect(rethrown.stack?.split('\n')[1]).toContain('errorHandler.writtenRecords.test.ts:');
    // `tryCatch` called the throw site, so it is a frame below it; `handleError` is not.
    expect(rethrown.stack).not.toMatch(/at (ErrorHandler\.)?handleError /);
  });

  it('writes a stack two chain nodes share once, under a wrapper thrown elsewhere', async () => {
    const rethrown = (await ErrorHandler.tryCatch(throwSiteOfTypeError, {
      operation: 'stack_shared_inner',
    }).catch((e: unknown) => e)) as McpError;
    const wrapper = new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream failed',
      undefined,
      {
        cause: rethrown,
      },
    );

    handle(wrapper, { operation: 'stack_shared' });

    const { line, written } = record('stack_shared');
    expect(written.stack).toBe(wrapper.stack);
    // The rebuilt McpError and the TypeError it wraps share the throw site's
    // stack: the first node carrying it writes it, the next does not.
    expect(written.errorData.causeChain).toMatchObject([
      { name: 'McpError', message: 'upstream failed', depth: 0 },
      { name: 'McpError', message: 'boom at the throw site', depth: 1 },
      { name: 'TypeError', message: 'boom at the throw site', depth: 2 },
    ]);
    expect(written.errorData.causeChain[0]).not.toHaveProperty('stack');
    expect(written.errorData.causeChain[1].stack).toBe(rethrown.stack);
    expect(written.errorData.causeChain[2]).not.toHaveProperty('stack');
    expect(occurrences(line, rethrown.stack)).toBe(1);
  });

  it.each([
    ['a string', 'plain failure'],
    ['a plain object', { status: 'down' }],
  ])('is absent for %s, which has no stack of its own', (_label, thrown) => {
    handle(thrown, { operation: 'stack_none' });

    const { line, written } = record('stack_none');
    expect(written).not.toHaveProperty('stack');
    expect(written.errorData).not.toHaveProperty('originalStack');
    expect(line).not.toContain('errorHandler.ts');
  });

  it.each([
    ['a string', 'plain failure'],
    ['a plain object', { status: 'down' }],
  ])('is never a context’s extra.stack, for %s', (_label, thrown) => {
    handle(thrown, {
      operation: 'stack_context',
      context: { extra: { stack: 'CONTEXT_STACK', toolName: 'probe' } },
    });

    const { line, written } = record('stack_context');
    expect(written).not.toHaveProperty('stack');
    expect(line).not.toContain('CONTEXT_STACK');
    expect(written.toolName).toBe('probe');
  });

  it('is the throw site’s, not a context’s extra.stack, for an Error', () => {
    const thrown = thrownBy(throwSiteOfTypeError);

    handle(thrown, {
      operation: 'stack_context_error',
      context: { extra: { stack: 'CONTEXT_STACK' } },
    });

    const { line, written } = record('stack_context_error');
    expect(written.stack).toBe(thrown.stack);
    expect(line).not.toContain('CONTEXT_STACK');
  });

  it('is the throw site under an errorMapper, whose result keeps its own stack', () => {
    const thrown = thrownBy(throwSiteOfTypeError);
    const mapped = new Error('mapped');
    mapped.stack = 'Error: mapped\n    at mapperOwnFrame (mapper.ts:1:1)';

    const returned = handle(thrown, { operation: 'stack_mapped', errorMapper: () => mapped });

    expect(returned).toBe(mapped);
    expect(returned.stack).toBe('Error: mapped\n    at mapperOwnFrame (mapper.ts:1:1)');
    const { written } = record('stack_mapped');
    expect(written.stack).toBe(thrown.stack);
    expect(written.errorData).not.toHaveProperty('originalStack');
  });

  it('keeps each cause’s own stack on its causeChain node under the default includeStack', () => {
    const thrown = new Error('outer', { cause: thrownBy(throwSiteOfTypeError) });

    handle(thrown, { operation: 'stack_chain' });

    const { written } = record('stack_chain');
    expect(written.stack).toBe(thrown.stack);
    expect(written.errorData.causeChain).toHaveLength(2);
    // Node 0 is the thrown error: its stack is the record's `stack`, not repeated.
    expect(written.errorData.causeChain[0]).toMatchObject({ name: 'Error', message: 'outer' });
    expect(written.errorData.causeChain[0]).not.toHaveProperty('stack');
    expect(written.errorData.causeChain[1].stack).toContain('throwSiteOfTypeError');
  });

  it('stays absent from a stack-free record', () => {
    handle(thrownBy(throwSiteOfTypeError), { operation: 'stack_free', includeStack: false });
    handle(new McpError(JsonRpcErrorCode.RequestCancelled, 'gone'), {
      operation: 'stack_cancelled',
    });

    for (const operation of ['stack_free', 'stack_cancelled']) {
      const { line, written } = record(operation);
      expect(written).not.toHaveProperty('stack');
      expect(line).not.toMatch(/"stack"|originalStack/);
    }
  });
});

// ---------------------------------------------------------------------------
// #650 — a stack-free record carries no stack, whoever supplied it
// ---------------------------------------------------------------------------

describe('a stack-free record (#650)', () => {
  /** The `{ type, message }` a stack-free record writes for {@link throwSiteOfTypeError}'s error. */
  const STACKLESS_TYPE_ERROR = { type: 'TypeError', message: 'boom at the throw site' };

  /**
   * An McpError whose own `data` carries every stack field a thrower can set:
   * the record's `originalStack`, a `causeChain` with a node `stack`, a node
   * `data.originalStack`, and an `Error` at the top and inside a node's `data`.
   */
  function carrying(code: JsonRpcErrorCode, cause?: unknown): McpError {
    return new McpError(
      code,
      'carried stacks',
      {
        originalStack: 'CARRIED_ORIGINAL_STACK',
        causeChain: [
          {
            name: 'Error',
            message: 'carried node',
            depth: 0,
            stack: 'CARRIED_NODE_STACK',
            data: {
              originalStack: 'CARRIED_NODE_DATA_STACK',
              upstream: thrownBy(throwSiteOfTypeError),
              pool: 'primary',
            },
          },
        ],
        upstream: thrownBy(throwSiteOfTypeError),
        kept: 'visible',
      },
      cause === undefined ? undefined : { cause },
    );
  }

  /** A context whose `extra` carries a `stack` and an `Error`. */
  const carryingContext = () => ({
    extra: { stack: 'CONTEXT_STACK', upstream: thrownBy(throwSiteOfTypeError), toolName: 'probe' },
  });

  /** An `input` carrying an `Error`, which the input sanitizer clones stack and all. */
  const carryingInput = () => ({ upstream: thrownBy(throwSiteOfTypeError), query: 'kept' });

  /** Asserts the written line holds no stack in any field, and kept every other one. */
  function expectStackFree(operation: string): Written {
    const { line, written } = record(operation);
    expect(line).not.toMatch(/"stack"|originalStack|CARRIED_|CONTEXT_STACK|throwSiteOfTypeError/);
    expect(written.toolName).toBe('probe');
    expect(written.upstream).toEqual(STACKLESS_TYPE_ERROR);
    expect(written.input).toEqual({ upstream: STACKLESS_TYPE_ERROR, query: 'kept' });
    expect(written.errorData).toMatchObject({
      kept: 'visible',
      upstream: STACKLESS_TYPE_ERROR,
      originalErrorName: 'McpError',
      originalMessage: 'carried stacks',
    });
    return written;
  }

  it.each([
    ['a cancellation, includeStack omitted', JsonRpcErrorCode.RequestCancelled, undefined],
    ['a cancellation, includeStack: false', JsonRpcErrorCode.RequestCancelled, false],
    ['an error with no cause, includeStack: false', JsonRpcErrorCode.InternalError, false],
  ] as const)('logs no stack in any field for %s', (_label, code, includeStack) => {
    const thrown = carrying(code);

    const returned = handle(thrown, {
      operation: 'free_carried',
      context: carryingContext(),
      input: carryingInput(),
      ...(includeStack !== undefined && { includeStack }),
    }) as McpError;

    const written = expectStackFree('free_carried');
    // The thrower's chain is kept, every node without a stack.
    expect(written.errorData.causeChain).toEqual([
      {
        name: 'Error',
        message: 'carried node',
        depth: 0,
        data: { upstream: STACKLESS_TYPE_ERROR, pool: 'primary' },
      },
    ]);
    // The returned error's data is the thrower's, untouched.
    expect(returned.data).toEqual({
      ...thrown.data,
      originalErrorName: 'McpError',
      originalMessage: 'carried stacks',
    });
    expect(returned.data?.originalStack).toBe('CARRIED_ORIGINAL_STACK');
    expect((returned.data?.upstream as Error | undefined)?.stack).toContain('throwSiteOfTypeError');
  });

  it('logs no stack in a computed chain whose cause’s data carries them, under includeStack: false', () => {
    const cause = carrying(JsonRpcErrorCode.ServiceUnavailable);
    const thrown = new McpError(
      JsonRpcErrorCode.InternalError,
      'carried stacks',
      {
        upstream: thrownBy(throwSiteOfTypeError),
        kept: 'visible',
      },
      { cause },
    );

    handle(thrown, {
      operation: 'free_computed',
      context: carryingContext(),
      input: carryingInput(),
      includeStack: false,
    });

    const written = expectStackFree('free_computed');
    const [outer, inner] = written.errorData.causeChain as Written[];
    expect(outer).toEqual({
      name: 'McpError',
      message: 'carried stacks',
      depth: 0,
      data: { upstream: STACKLESS_TYPE_ERROR, kept: 'visible' },
    });
    expect(inner?.data).toMatchObject({ kept: 'visible', upstream: STACKLESS_TYPE_ERROR });
    expect(inner?.data).not.toHaveProperty('originalStack');
    expect(inner?.data.causeChain).toEqual([
      {
        name: 'Error',
        message: 'carried node',
        depth: 0,
        data: { upstream: STACKLESS_TYPE_ERROR, pool: 'primary' },
      },
    ]);
  });

  it('keeps every carried stack in a non-cancellation record under the default includeStack', () => {
    const thrown = carrying(JsonRpcErrorCode.InternalError);

    handle(thrown, {
      operation: 'stacked_carried',
      context: carryingContext(),
      input: carryingInput(),
    });

    const { line, written } = record('stacked_carried');
    expect(written.stack).toBe(thrown.stack);
    expect(written.errorData.originalStack).toBe('CARRIED_ORIGINAL_STACK');
    expect(written.errorData.causeChain[0].stack).toBe('CARRIED_NODE_STACK');
    expect(written.errorData.causeChain[0].data.originalStack).toBe('CARRIED_NODE_DATA_STACK');
    expect(written.errorData.upstream.stack).toContain('throwSiteOfTypeError');
    expect(written.upstream.stack).toContain('throwSiteOfTypeError');
    expect(written.input.upstream.stack).toContain('throwSiteOfTypeError');
    expect(line).not.toContain('CONTEXT_STACK');
  });

  /** A `context.extra` that is not a plain object: what spreading it yields is what is written. */
  class ExtraDto {
    readonly toolName = 'probe';
    readonly stack = 'INSTANCE_STACK';
    readonly upstream = thrownBy(throwSiteOfTypeError);
  }

  /** What a spread copies: a class instance's own fields, and nothing of a `Map`. */
  const FROM_INSTANCE = { toolName: 'probe', upstream: STACKLESS_TYPE_ERROR };
  const FROM_MAP = { toolName: undefined, upstream: undefined };

  it.each([
    ['a class instance, includeStack: false', new ExtraDto(), false, FROM_INSTANCE],
    ['a class instance, on a cancellation', new ExtraDto(), undefined, FROM_INSTANCE],
    ['a Map, includeStack: false', new Map([['toolName', 'probe']]), false, FROM_MAP],
    ['a Map, on a cancellation', new Map([['toolName', 'probe']]), undefined, FROM_MAP],
  ] as const)(
    'writes a stack-free record when context.extra is %s',
    (_label, extra, includeStack, kept) => {
      const code =
        includeStack === false ? JsonRpcErrorCode.InternalError : JsonRpcErrorCode.RequestCancelled;

      expect(() =>
        handle(new McpError(code, 'non-plain extra'), {
          operation: 'free_nonplain',
          context: { extra: extra as unknown as Readonly<Record<string, unknown>> },
          ...(includeStack !== undefined && { includeStack }),
        }),
      ).not.toThrow();

      const { line, written } = record('free_nonplain');
      expect(line).not.toMatch(/"stack"|INSTANCE_STACK|throwSiteOfTypeError/);
      expect(written.errorData).toMatchObject({ originalMessage: 'non-plain extra' });
      expect({ toolName: written.toolName, upstream: written.upstream }).toEqual(kept);
    },
  );
});

// ---------------------------------------------------------------------------
// #649 — the handler's own fields come before caller-sized data
// ---------------------------------------------------------------------------

describe('the handler’s fields beside caller-sized data (#649)', () => {
  /**
   * `depth + 1` objects, each referring to the next three times: `3^depth`
   * paths through them, so a walk spends its whole bound on repeated content here.
   */
  function sharedGraph(depth: number): Record<string, unknown> {
    let node: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < depth; i++) node = { a: node, b: node, c: node };
    return node;
  }

  /**
   * A declared failure with a cause, as a service raises it, its `data`
   * carrying `request`: a record the caller may pass in `extra` too, so
   * whichever copy the walk reaches second is the repeat it charges.
   */
  const declaredFailure = (request: object) =>
    new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream down',
      { reason: 'upstream_down', recovery: { hint: 'Retry in a minute or two.' }, request },
      { cause: thrownBy(throwSiteOfTypeError) },
    );

  it.each([
    ['context.extra, the default record', 'extra', undefined],
    ['context.extra, a stack-free record', 'extra', false],
    ['input, the default record', 'input', undefined],
    ['input, a stack-free record', 'input', false],
  ] as const)('writes errorData whole when %s exhausts the walk', (_label, where, includeStack) => {
    const graph = sharedGraph(10);
    const request = { endpoint: 'search', params: { q: 'shared', page: 2 } };

    handle(declaredFailure(request), {
      operation: 'budget_order',
      ...(where === 'extra' ? { context: { extra: { graph, request } } } : { input: { graph } }),
      ...(includeStack !== undefined && { includeStack }),
    });

    const { line, written } = record('budget_order');
    expect(written.errorData).toMatchObject({
      reason: 'upstream_down',
      recovery: { hint: 'Retry in a minute or two.' },
      originalMessage: 'upstream down',
      rootCause: { name: 'TypeError', message: 'boom at the throw site' },
      request: { endpoint: 'search', params: { q: 'shared', page: 2 } },
    });
    expect(written.errorData.causeChain).toHaveLength(2);
    expect(written).toMatchObject({
      errorCode: JsonRpcErrorCode.ServiceUnavailable,
      originalErrorType: 'McpError',
      finalErrorType: 'McpError',
      critical: false,
    });
    // The caller's graph is what the budget cut.
    expect(line).toContain('"[Truncated]"');
    if (includeStack === false) expect(line).not.toMatch(/"stack"/);
  });

  it('keeps data a shared graph fills without writing every path through it', () => {
    // 17 objects, 43 million paths: a JSON.stringify of it takes seconds and gigabytes.
    const graph = sharedGraph(16);
    const started = performance.now();

    const returned = handle(new McpError(JsonRpcErrorCode.Conflict, 'shared data', { v: graph }), {
      operation: 'shared_data',
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect((returned as McpError).data?.v).toBe(graph);
    const { written } = record('shared_data');
    expect(written.errorData.v).toMatchObject({ a: { a: { a: expect.any(Object) } } });
  });

  it('never lets a caller’s extra key replace one of the handler’s fields', () => {
    const thrown = thrownBy(throwSiteOfTypeError);

    handle(thrown, {
      operation: 'budget_keys',
      context: {
        extra: {
          critical: 'CALLER',
          errorCode: 'CALLER',
          originalErrorType: 'CALLER',
          finalErrorType: 'CALLER',
          errorData: 'CALLER',
          toolName: 'probe',
        },
      },
    });

    const { line, written } = record('budget_keys');
    expect(line).not.toContain('CALLER');
    expect(written).toMatchObject({
      critical: false,
      errorCode: JsonRpcErrorCode.InternalError,
      originalErrorType: 'TypeError',
      finalErrorType: 'McpError',
      stack: thrown.stack,
      toolName: 'probe',
    });
    expect(written.errorData).toMatchObject({ originalMessage: 'boom at the throw site' });
  });
});

// ---------------------------------------------------------------------------
// #697 — a thrown error whose fields cannot be read
// ---------------------------------------------------------------------------

describe('a thrown error whose fields cannot be read (#697)', () => {
  /** `error` with an own `key` whose read throws. */
  function unreadable<E extends Error>(error: E, key: string): E {
    return Object.defineProperty(error, key, {
      configurable: true,
      get() {
        throw new Error(`${key} getter`);
      },
    });
  }

  /** An Error whose `cause` is a revoked Proxy: every operation on it throws. */
  function withRevokedCause(): Error {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return new Error('boom', { cause: proxy });
  }

  /** The node an unreadable cause is written as. */
  const UNREADABLE_NODE = { name: '[Unreadable]', message: '[Unreadable]' };

  /** `handleError` for `error`, which must not throw. */
  function handled(error: unknown, options: ErrorHandlerOptions): Error {
    let returned: Error | undefined;
    expect(() => {
      returned = handle(error, options);
    }).not.toThrow();
    expect(returned).toBeInstanceOf(McpError);
    return returned as Error;
  }

  it('writes a stack it cannot read as [Unreadable], and the rebuilt error keeps its own', () => {
    const returned = handled(unreadable(new Error('boom'), 'stack'), {
      operation: 'unreadable_stack',
    });

    const { written } = record('unreadable_stack');
    expect(written.stack).toBe('[Unreadable]');
    expect(written).toMatchObject({ originalErrorType: 'Error', errorCode: -32603 });
    expect(written.errorData).toMatchObject({
      originalErrorName: 'Error',
      originalMessage: 'boom',
    });
    expect(returned.message).toBe('boom');
    expect(returned.stack).toEqual(expect.any(String));
    expect(returned.stack).not.toBe('[Unreadable]');
  });

  it('writes no stack for an unreadable one in a stack-free record', () => {
    handled(unreadable(new Error('boom'), 'stack'), {
      operation: 'unreadable_stack_free',
      includeStack: false,
    });

    const { line } = record('unreadable_stack_free');
    expect(line).not.toMatch(/"stack"|Unreadable/);
  });

  it('writes a message it cannot read as [Unreadable]', () => {
    const returned = handled(unreadable(new Error('boom'), 'message'), {
      operation: 'unreadable_message',
    });

    const { written } = record('unreadable_message');
    expect(written.msg).toBe('Error in unreadable_message: [Unreadable]');
    expect(written.errorData).toMatchObject({
      originalErrorName: 'Error',
      originalMessage: '[Unreadable]',
    });
    expect(returned.message).toBe('[Unreadable]');
  });

  it('writes a name it cannot read as [Unreadable]', () => {
    handled(unreadable(new TypeError('boom'), 'name'), { operation: 'unreadable_name' });

    const { written } = record('unreadable_name');
    expect(written).toMatchObject({
      originalErrorType: '[Unreadable]',
      finalErrorType: 'McpError',
      errorCode: JsonRpcErrorCode.InternalError,
    });
    expect(written.errorData).toMatchObject({
      originalErrorName: '[Unreadable]',
      originalMessage: 'boom',
    });
  });

  it.each([
    ['whose getter throws', () => unreadable(new Error('boom'), 'cause')],
    ['that is a revoked Proxy', withRevokedCause],
  ])('writes a cause %s as an [Unreadable] node ending the chain', (_label, make) => {
    const thrown = make();

    handled(thrown, { operation: 'unreadable_cause' });

    const { written } = record('unreadable_cause');
    expect(written.stack).toBe(thrown.stack);
    expect(written.errorData.rootCause).toEqual(UNREADABLE_NODE);
    expect(written.errorData.causeChain).toEqual([
      { name: 'Error', message: 'boom', depth: 0 },
      { ...UNREADABLE_NODE, depth: 1 },
    ]);
  });

  it('writes each unreadable field of a cause deeper in the chain', () => {
    const inner = unreadable(unreadable(new RangeError('inner'), 'stack'), 'message');
    const middle = withRevokedCause();
    const thrown = new Error('outer', {
      cause: new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'wrapped',
        { pool: 'primary' },
        {
          cause: inner,
        },
      ),
    });

    handled(thrown, { operation: 'unreadable_deep' });
    handled(new Error('outer', { cause: middle }), { operation: 'unreadable_deep_revoked' });

    const deep = record('unreadable_deep').written.errorData;
    expect(deep.causeChain).toMatchObject([
      { name: 'Error', message: 'outer', depth: 0 },
      { name: 'McpError', message: 'wrapped', depth: 1, data: { pool: 'primary' } },
      { name: 'RangeError', message: '[Unreadable]', depth: 2, stack: '[Unreadable]' },
    ]);
    expect(deep.rootCause).toEqual({ name: 'RangeError', message: '[Unreadable]' });
    expect(record('unreadable_deep_revoked').written.errorData.causeChain).toEqual([
      { name: 'Error', message: 'outer', depth: 0 },
      { name: 'Error', message: 'boom', depth: 1, stack: middle.stack },
      { ...UNREADABLE_NODE, depth: 2 },
    ]);
  });

  it('throws nothing out of tryCatch but the rebuilt McpError', async () => {
    const thrown = await ErrorHandler.tryCatch(
      () => {
        throw unreadable(unreadable(withRevokedCause(), 'stack'), 'message');
      },
      { operation: 'unreadable_trycatch' },
    ).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toBe('[Unreadable]');
    const { written } = record('unreadable_trycatch');
    expect(written.stack).toBe('[Unreadable]');
    expect(written.errorData.causeChain).toEqual([
      { name: 'Error', message: '[Unreadable]', depth: 0, stack: '[Unreadable]' },
      { ...UNREADABLE_NODE, depth: 1 },
    ]);
  });

  /** What a service's `tryCatch` throws when its function throws `make()`. */
  async function thrownOutOfTryCatch(operation: string, make: () => unknown): Promise<unknown> {
    return await ErrorHandler.tryCatch(
      () => {
        throw make();
      },
      { operation },
    ).catch((e: unknown) => e);
  }

  it('writes a thrown value that is itself a revoked Proxy as [Unreadable]', async () => {
    const thrown = await thrownOutOfTryCatch('unreadable_value', () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    });

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: '[Unreadable]',
    });
    const { written } = record('unreadable_value');
    expect(written.msg).toBe('Error in unreadable_value: [Unreadable]');
    expect(written).toMatchObject({
      originalErrorType: '[Unreadable]',
      finalErrorType: 'McpError',
      errorCode: JsonRpcErrorCode.InternalError,
    });
    expect(written.errorData).toEqual({
      originalErrorName: '[Unreadable]',
      originalMessage: '[Unreadable]',
    });
    expect(written).not.toHaveProperty('stack');
  });

  it('leaves out a thrown McpError’s data it cannot read, keeping its code', async () => {
    const thrown = await thrownOutOfTryCatch('unreadable_data', () =>
      unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 7 }), 'data'),
    );

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({ code: JsonRpcErrorCode.NotFound, message: 'gone' });
    expect((thrown as McpError).data).toEqual({
      originalErrorName: 'McpError',
      originalMessage: 'gone',
    });
    const { written } = record('unreadable_data');
    expect(written).toMatchObject({
      originalErrorType: 'McpError',
      errorCode: JsonRpcErrorCode.NotFound,
    });
    expect(written.errorData).toEqual({ originalErrorName: 'McpError', originalMessage: 'gone' });
  });

  it('writes the record when an errorMapper returns the unreadable error it was given', () => {
    const thrown = unreadable(
      unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 7 }), 'message'),
      'data',
    );

    const returned = ErrorHandler.handleError(thrown, {
      operation: 'unreadable_mapped',
      errorMapper: (e) => e as Error,
    });

    expect(returned).toBe(thrown);
    const { written } = record('unreadable_mapped');
    expect(written.msg).toBe('Error in unreadable_mapped: [Unreadable]');
    expect(written).toMatchObject({
      errorCode: JsonRpcErrorCode.NotFound,
      finalErrorType: 'McpError',
    });
    expect(written.errorData).toEqual({
      originalErrorName: 'McpError',
      originalMessage: '[Unreadable]',
    });
  });

  it.each([
    [
      'a revoked Proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
    [
      'an object whose ownKeys trap throws',
      () =>
        new Proxy(
          { id: 7 },
          {
            ownKeys() {
              throw new Error('ownKeys trap');
            },
          },
        ),
    ],
  ])(
    'writes the record when an errorMapper returns the error it was given, whose data is %s',
    (_label, make) => {
      const thrown = Object.defineProperty(
        new McpError(JsonRpcErrorCode.NotFound, 'gone'),
        'data',
        {
          configurable: true,
          enumerable: true,
          writable: true,
          value: make(),
        },
      );

      let returned: Error | undefined;
      expect(() => {
        returned = handle(thrown, {
          operation: 'hostile_data_mapped',
          errorMapper: (e) => e as Error,
        });
      }).not.toThrow();

      expect(returned).toBe(thrown);
      const { written } = record('hostile_data_mapped');
      expect(written).toMatchObject({
        msg: 'Error in hostile_data_mapped: gone',
        errorCode: JsonRpcErrorCode.NotFound,
        finalErrorType: 'McpError',
      });
      expect(written.errorData).toEqual({ originalErrorName: 'McpError', originalMessage: 'gone' });
    },
  );

  it('classifies a thrown McpError whose code it cannot read as InternalError', async () => {
    const thrown = await thrownOutOfTryCatch('unreadable_code', () =>
      unreadable(new McpError(JsonRpcErrorCode.NotFound, 'gone'), 'code'),
    );

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({ code: JsonRpcErrorCode.InternalError, message: 'gone' });
    const { written } = record('unreadable_code');
    expect(written).toMatchObject({
      originalErrorType: 'McpError',
      errorCode: JsonRpcErrorCode.InternalError,
    });
  });
});

// ---------------------------------------------------------------------------
// handleError never throws on its context
// ---------------------------------------------------------------------------

describe('a context whose fields cannot be copied', () => {
  /** An object whose own enumerable getter throws when a spread reads it. */
  const withThrowingGetter = () =>
    Object.defineProperty({ toolName: 'probe' }, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter threw');
      },
    });

  /** A `Proxy` whose `ownKeys` trap throws when a spread enumerates it. */
  const withThrowingOwnKeys = () =>
    new Proxy(
      { toolName: 'probe' },
      {
        ownKeys() {
          throw new Error('ownKeys threw');
        },
      },
    );

  const hostile = [
    ['an own getter that throws', withThrowingGetter],
    ['a Proxy whose ownKeys trap throws', withThrowingOwnKeys],
  ] as const;

  /** `[label, code, includeStack, whether the record keeps the throw site's stack]`. */
  const records = [
    ['the default record', JsonRpcErrorCode.InternalError, undefined, true],
    ['includeStack: false', JsonRpcErrorCode.InternalError, false, false],
    ['a cancellation', JsonRpcErrorCode.RequestCancelled, undefined, false],
  ] as const;

  it.each(
    hostile.flatMap(([what, make]) =>
      records.map(
        ([which, code, includeStack, stacked]) =>
          [what, which, make, code, includeStack, stacked] as const,
      ),
    ),
  )(
    'writes context.extra with %s as unreadable, on %s',
    (_what, _which, make, code, includeStack, stacked) => {
      const thrown = thrownBy(() => {
        throw new McpError(code, 'hostile context');
      });

      let returned: Error | undefined;
      expect(() => {
        returned = handle(thrown, {
          operation: 'hostile_extra',
          context: { extra: make() },
          ...(includeStack !== undefined && { includeStack }),
        });
      }).not.toThrow();

      expect(returned).toBeInstanceOf(McpError);
      expect((returned as McpError).code).toBe(code);
      expect(returned?.message).toBe('hostile context');
      const { written } = record('hostile_extra');
      expect(written.extra).toBe('[Unreadable]');
      expect(written).not.toHaveProperty('toolName');
      expect(written.requestId).toBe('req-records');
      expect(written.errorData).toMatchObject({ originalMessage: 'hostile context' });
      expect(written.stack).toBe(stacked ? thrown.stack : undefined);
    },
  );

  it.each(hostile)('writes a context with %s as unreadable', (_what, make) => {
    const thrown = thrownBy(throwSiteOfTypeError);

    expect(() =>
      ErrorHandler.handleError(thrown, {
        operation: 'hostile_context',
        context: Object.assign(make(), { requestId: 'req-hostile' }),
      }),
    ).not.toThrow();

    const { written } = record('hostile_context');
    expect(written.context).toBe('[Unreadable]');
    expect(written.stack).toBe(thrown.stack);
    // Nothing of the context could be read, its request id included.
    expect(written.requestId).toEqual(expect.any(String));
    expect(written.requestId).not.toBe('req-hostile');
  });
});
