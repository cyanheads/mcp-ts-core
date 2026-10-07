/**
 * @fileoverview A tool call whose handler throws an Error it cannot fully read
 * — a `stack`, `message`, `name`, or `cause` getter that throws, or a revoked
 * Proxy on `cause` — driven through the real handler factory, error handler,
 * and `Logger`: the call returns its normal error envelope, the
 * `Error in tool:<name>` record is written with each unreadable field as
 * `'[Unreadable]'`, and a `ctx.log.error` with such an Error still reaches the
 * client (#697). A handler's `throw ctx.fail(…)` record starts its stack at
 * the handler's line (#694). pino is the real module writing to an in-memory
 * stream, so each assertion reads the serialized line.
 * @module tests/unit/mcp-server/tools/utils/toolHandlerFactory.unreadableErrors.test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeServerContext } from '../../../../helpers/server-context.js';

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

import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  createToolHandler,
  type HandlerServices,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { withSpan } from '@/utils/telemetry/trace.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A parsed log line, read by path. */
type Written = Record<string, any>;

const services = { logger, storage: {} } as unknown as HandlerServices;

/** The framework-generated request id every envelope carries (#584). */
const REQUEST_ID = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

beforeAll(async () => {
  mockConfig.logsPath = mkdtempSync(join(tmpdir(), 'mcp-unreadable-errors-'));
  await logger.initialize('debug');
});

afterAll(async () => {
  await logger.close();
  if (mockConfig.logsPath) rmSync(mockConfig.logsPath, { recursive: true, force: true });
});

beforeEach(() => {
  lines.length = 0;
});

/** Drives one `tools/call` through the factory, with `log` as the `notifications/message` sink. */
async function callTool(
  def: unknown,
  log: (level: string, data: unknown) => Promise<void> = async () => {},
): Promise<CallToolResult> {
  const handler = createToolHandler(def as AnyToolDefinition, services, {});
  return (await handler({}, makeServerContext({ log: log as never }))) as CallToolResult;
}

/** The error envelope a failed call published. */
function envelope(result: CallToolResult): {
  code: number;
  data?: Record<string, unknown>;
  message: string;
} {
  return (result.structuredContent as { error: ReturnType<typeof envelope> }).error;
}

/** The call's one `Error in tool:<name>` line, parsed. */
function errorRecord(name: string): Written {
  const found = lines
    .map((line) => JSON.parse(line) as Written)
    .filter((w) => String(w.msg).startsWith(`Error in tool:${name}:`));
  expect(found).toHaveLength(1);
  return found[0] as Written;
}

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

const ok = z.object({ ok: z.boolean().describe('ok') });

/** A tool whose handler throws what `make` builds. */
function throwing(name: string, make: () => unknown) {
  return tool(name, {
    description: 'Throws an error it cannot fully read.',
    input: z.object({}),
    output: ok,
    handler: () => {
      throw make();
    },
  });
}

/** The node an unreadable cause is written as. */
const UNREADABLE_NODE = { name: '[Unreadable]', message: '[Unreadable]' };

// ---------------------------------------------------------------------------
// #697 — the call reports what it can read and returns its envelope
// ---------------------------------------------------------------------------

describe('a handler that throws an Error whose fields cannot be read (#697)', () => {
  it.each([
    [
      'stack',
      () => unreadable(new Error('boom'), 'stack'),
      'boom',
      (written: Written) => {
        expect(written.stack).toBe('[Unreadable]');
        expect(written.errorData).toMatchObject({
          originalErrorName: 'Error',
          originalMessage: 'boom',
        });
      },
    ],
    [
      'message',
      () => unreadable(new Error('boom'), 'message'),
      '[Unreadable]',
      (written: Written) => {
        expect(written.errorData).toMatchObject({
          originalErrorName: 'Error',
          originalMessage: '[Unreadable]',
        });
      },
    ],
    [
      'name',
      () => unreadable(new TypeError('boom'), 'name'),
      'boom',
      (written: Written) => {
        expect(written.originalErrorType).toBe('[Unreadable]');
        expect(written.errorData).toMatchObject({ originalErrorName: '[Unreadable]' });
      },
    ],
    [
      'cause',
      () => unreadable(new Error('boom'), 'cause'),
      'boom',
      (written: Written) => {
        expect(written.errorData.rootCause).toEqual(UNREADABLE_NODE);
        expect(written.errorData.causeChain).toEqual([
          { name: 'Error', message: 'boom', depth: 0 },
          { ...UNREADABLE_NODE, depth: 1 },
        ]);
      },
    ],
    [
      'cause, a revoked Proxy',
      withRevokedCause,
      'boom',
      (written: Written) => {
        expect(written.errorData.rootCause).toEqual(UNREADABLE_NODE);
        expect(written.errorData.causeChain).toEqual([
          { name: 'Error', message: 'boom', depth: 0 },
          { ...UNREADABLE_NODE, depth: 1 },
        ]);
      },
    ],
  ] as const)(
    'returns the envelope and writes the record for an unreadable %s',
    async (label, make, message, check) => {
      const name = `unreadable_${label.replaceAll(/\W+/g, '_')}`;

      const result = await callTool(throwing(name, make));

      expect(result.isError).toBe(true);
      const error = envelope(result);
      expect(error).toMatchObject({ code: JsonRpcErrorCode.InternalError, message });
      expect(error.data?.requestId).toMatch(REQUEST_ID);
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      expect(text).toBe(`Error: ${message}\n\n(request ${String(error.data?.requestId)})`);

      const written = errorRecord(name);
      expect(written.level).toBe(50);
      expect(written.requestId).toBe(error.data?.requestId);
      expect(written.errorCode).toBe(JsonRpcErrorCode.InternalError);
      check(written);
    },
  );

  it('still mirrors ctx.log.error to the client when the Error’s message cannot be read', async () => {
    const log = vi.fn(async (_level: string, _data: unknown) => {});
    const logs = tool('logs_unreadable_message', {
      description: 'Logs an error it cannot fully read.',
      input: z.object({}),
      output: ok,
      handler: (_input, ctx) => {
        ctx.log.error('upstream failed', unreadable(new Error('boom'), 'message'), { step: 2 });
        return { ok: true };
      },
    });

    const result = await callTool(logs, log);

    expect(result.isError).toBeFalsy();
    expect(log).toHaveBeenCalledWith('error', {
      message: 'upstream failed',
      step: 2,
      error: '[Unreadable]',
    });
  });
});

describe('a declared failure whose fields cannot be read (#697)', () => {
  const RECOVERY = 'Search for the item again before retrying the call.';

  /** A tool whose handler throws its declared `gone` failure with `key` unreadable. */
  function declared(name: string, key: string) {
    return tool(name, {
      description: 'Fails through its contract with an error it cannot fully read.',
      input: z.object({}),
      output: ok,
      errors: [
        {
          reason: 'gone',
          code: JsonRpcErrorCode.NotFound,
          when: 'The item is gone.',
          recovery: RECOVERY,
        },
      ],
      handler: (_input, ctx) => {
        throw unreadable(ctx.fail('gone'), key);
      },
    });
  }

  it.each([
    [
      'stack',
      'The item is gone.',
      (written: Written) => {
        expect(written.stack).toBe('[Unreadable]');
      },
    ],
    [
      'message',
      '[Unreadable]',
      (written: Written) => {
        expect(written.msg).toBe('Error in tool:declared_unreadable_message: [Unreadable]');
        expect(written.errorData.originalMessage).toBe('[Unreadable]');
      },
    ],
    [
      'name',
      'The item is gone.',
      (written: Written) => {
        expect(written.originalErrorType).toBe('[Unreadable]');
        expect(written.errorData.originalErrorName).toBe('[Unreadable]');
      },
    ],
    [
      'cause',
      'The item is gone.',
      (written: Written) => {
        expect(written.errorData.rootCause).toEqual(UNREADABLE_NODE);
        expect(written.errorData.causeChain).toEqual([
          {
            name: 'McpError',
            message: 'The item is gone.',
            depth: 0,
            data: { reason: 'gone', recovery: { hint: RECOVERY } },
          },
          { ...UNREADABLE_NODE, depth: 1 },
        ]);
      },
    ],
  ] as const)(
    'fills the declared recovery and writes the record for an unreadable %s',
    async (key, message, check) => {
      const name = `declared_unreadable_${key}`;

      const result = await callTool(declared(name, key));

      expect(result.isError).toBe(true);
      const error = envelope(result);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message,
        data: { reason: 'gone', recovery: { hint: RECOVERY } },
      });
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      expect(text).toMatch(new RegExp(`^Error: ${message.replace(/[[\].]/g, '\\$&')}\\n`));
      expect(text).toContain(`Recovery: ${RECOVERY}`);

      const written = errorRecord(name);
      expect(written.level).toBe(50);
      expect(written.requestId).toBe(error.data?.requestId);
      expect(written).toMatchObject({
        errorCode: JsonRpcErrorCode.NotFound,
        errorData: { reason: 'gone', recovery: { hint: RECOVERY } },
      });
      check(written);
    },
  );
});

describe('an Error whose message or name is not a string', () => {
  const RECOVERY = 'Search for the item again before retrying the call.';

  /** `error` with an own `key` holding `value`. */
  function withField<E extends Error>(error: E, key: string, value: unknown): E {
    return Object.defineProperty(error, key, { configurable: true, writable: true, value });
  }

  /** An object whose conversion to a string throws. */
  const unconvertible = {
    toString(): string {
      throw new Error('toString trap');
    },
  };

  it.each([
    [
      'a Symbol message',
      () => withField(new Error('x'), 'message', Symbol('sym-msg')),
      JsonRpcErrorCode.InternalError,
      'Symbol(sym-msg)',
    ],
    [
      'a number message',
      () => withField(new Error('x'), 'message', 404),
      JsonRpcErrorCode.InternalError,
      '404',
    ],
    [
      'a message whose toString throws',
      () => withField(new Error('x'), 'message', unconvertible),
      JsonRpcErrorCode.InternalError,
      '[Unreadable]',
    ],
    [
      'a Symbol name',
      () => withField(new Error('boom'), 'name', Symbol('sym-name')),
      JsonRpcErrorCode.InternalError,
      'boom',
    ],
    [
      'an undeclared McpError with a Symbol message',
      () =>
        withField(
          new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 7 }),
          'message',
          Symbol('sym-msg'),
        ),
      JsonRpcErrorCode.NotFound,
      'Symbol(sym-msg)',
    ],
  ] as const)(
    'returns the envelope with a string message for %s',
    async (label, make, code, message) => {
      const name = `non_string_${label.replaceAll(/\W+/g, '_')}`;

      const result = await callTool(throwing(name, make));

      expect(result.isError).toBe(true);
      const error = envelope(result);
      expect(error).toMatchObject({ code, message });
      expect(error.data?.requestId).toMatch(REQUEST_ID);
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      expect(text).toBe(`Error: ${message}\n\n(request ${String(error.data?.requestId)})`);
      expect(errorRecord(name).requestId).toBe(error.data?.requestId);
    },
  );

  it('returns the envelope for an McpError with a Symbol message thrown through tryCatch with an identity errorMapper', async () => {
    const mapped = tool('non_string_identity_mapper', {
      description: 'Fails through tryCatch with a Symbol message.',
      input: z.object({}),
      output: ok,
      handler: async () => {
        await ErrorHandler.tryCatch(
          () => {
            throw withField(
              new McpError(JsonRpcErrorCode.NotFound, 'gone'),
              'message',
              Symbol('sym-msg'),
            );
          },
          { operation: 'lookup', errorMapper: (e) => e as Error },
        );
        return { ok: true };
      },
    });

    const result = await callTool(mapped);

    expect(envelope(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Symbol(sym-msg)',
    });
    expect(
      lines
        .map((line) => (JSON.parse(line) as Written).msg)
        .filter((msg) => msg === 'Error in lookup: Symbol(sym-msg)'),
    ).toHaveLength(1);
  });

  it('fills the declared recovery for a declared failure with a Symbol message', async () => {
    const symbolMessage = tool('non_string_declared', {
      description: 'Fails through its contract with a Symbol message.',
      input: z.object({}),
      output: ok,
      errors: [
        {
          reason: 'gone',
          code: JsonRpcErrorCode.NotFound,
          when: 'The item is gone.',
          recovery: RECOVERY,
        },
      ],
      handler: (_input, ctx) => {
        throw withField(ctx.fail('gone'), 'message', Symbol('sym-msg'));
      },
    });

    const result = await callTool(symbolMessage);

    const error = envelope(result);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Symbol(sym-msg)',
      data: {
        reason: 'gone',
        recovery: { hint: RECOVERY },
        requestId: expect.stringMatching(REQUEST_ID),
      },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text;
    expect(text).toContain(`Recovery: ${RECOVERY}`);
  });
});

describe('a thrown McpError or value the factory cannot read (#697)', () => {
  /** The tool's undeclared `McpError(NotFound, 'gone', { id: 7 })`. */
  const gone = () => new McpError(JsonRpcErrorCode.NotFound, 'gone', { id: 7 });

  /** `error` carrying `data`, assigned after construction as a service might. */
  function withData(error: McpError, data: unknown): McpError {
    return Object.defineProperty(error, 'data', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: data,
    });
  }

  /** A revoked Proxy: every operation on it, `instanceof` and a `then` lookup included, throws. */
  function revoked(): object {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }

  /** An object whose `ownKeys` trap throws, so copying its fields throws. */
  const keyless = () =>
    new Proxy(
      { id: 7 },
      {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      },
    );

  /** A tool whose async handler fails with what `run` rejects with. */
  function failing(name: string, run: () => Promise<unknown>) {
    return tool(name, {
      description: 'Fails with an error it cannot fully read.',
      input: z.object({}),
      output: ok,
      handler: async () => {
        await run();
        return { ok: true };
      },
    });
  }

  /**
   * Asserts the call's envelope — `expected` plus the framework's request id —
   * its text, and its one `Error in tool:<name>` record, and returns the record.
   */
  function expectEnvelope(
    name: string,
    result: CallToolResult,
    expected: { code: JsonRpcErrorCode; message: string; data: Record<string, unknown> },
  ): Written {
    expect(result.isError).toBe(true);
    const error = envelope(result);
    const requestId = error.data?.requestId;
    expect(requestId).toMatch(REQUEST_ID);
    expect(error).toEqual({ ...expected, data: { ...expected.data, requestId } });
    const text = (result.content as Array<{ text: string }>)[0]?.text;
    expect(text).toBe(`Error: ${expected.message}\n\n(request ${String(requestId)})`);

    const written = errorRecord(name);
    expect(written.level).toBe(50);
    expect(written.requestId).toBe(requestId);
    expect(written.errorCode).toBe(expected.code);
    return written;
  }

  it.each([
    [
      'directly',
      async () => {
        throw unreadable(gone(), 'message');
      },
    ],
    [
      'through withSpan',
      () =>
        withSpan('lookup', async () => {
          throw unreadable(gone(), 'message');
        }),
    ],
    [
      'through tryCatch with an identity errorMapper',
      () =>
        ErrorHandler.tryCatch(
          () => {
            throw unreadable(gone(), 'message');
          },
          { operation: 'lookup', errorMapper: (e) => e as Error },
        ),
    ],
  ])(
    'returns the NotFound envelope for an undeclared McpError whose message cannot be read, thrown %s',
    async (route, run) => {
      const name = `undeclared_message_${route.replaceAll(/\W+/g, '_')}`;

      const result = await callTool(failing(name, run));

      const written = expectEnvelope(name, result, {
        code: JsonRpcErrorCode.NotFound,
        message: '[Unreadable]',
        data: { id: 7 },
      });
      expect(written.msg).toBe(`Error in tool:${name}: [Unreadable]`);
    },
  );

  it.each([
    ['code', () => unreadable(gone(), 'code'), JsonRpcErrorCode.InternalError, { id: 7 }],
    ['data', () => unreadable(gone(), 'data'), JsonRpcErrorCode.NotFound, {}],
    ['data, a revoked Proxy', () => withData(gone(), revoked()), JsonRpcErrorCode.NotFound, {}],
    [
      'data, whose ownKeys trap throws',
      () => withData(gone(), keyless()),
      JsonRpcErrorCode.NotFound,
      {},
    ],
    [
      'isInputRequiredSignal',
      () => unreadable(gone(), 'isInputRequiredSignal'),
      JsonRpcErrorCode.NotFound,
      { id: 7 },
    ],
    ['then', () => unreadable(gone(), 'then'), JsonRpcErrorCode.NotFound, { id: 7 }],
    ['name', () => unreadable(gone(), 'name'), JsonRpcErrorCode.NotFound, { id: 7 }],
    ['stack', () => unreadable(gone(), 'stack'), JsonRpcErrorCode.NotFound, { id: 7 }],
    ['cause', () => unreadable(gone(), 'cause'), JsonRpcErrorCode.NotFound, { id: 7 }],
  ] as const)(
    'returns the envelope for an undeclared McpError whose %s cannot be read, with the code it can read',
    async (label, make, code, data) => {
      const name = `undeclared_${label.replaceAll(/\W+/g, '_')}`;

      const result = await callTool(throwing(name, make));

      const written = expectEnvelope(name, result, { code, message: 'gone', data });
      expect(written.msg).toBe(`Error in tool:${name}: gone`);
    },
  );

  it('returns the InternalError envelope for a thrown revoked Proxy', async () => {
    const result = await callTool(throwing('revoked_value', revoked));

    const written = expectEnvelope('revoked_value', result, {
      code: JsonRpcErrorCode.InternalError,
      message: '[Unreadable]',
      data: {},
    });
    expect(written).toMatchObject({
      msg: 'Error in tool:revoked_value: [Unreadable]',
      originalErrorType: '[Unreadable]',
      errorData: { originalErrorName: '[Unreadable]', originalMessage: '[Unreadable]' },
    });
  });
});

// ---------------------------------------------------------------------------
// #694 — `throw ctx.fail(…)` starts the record's stack at the handler's line
// ---------------------------------------------------------------------------

describe('a handler’s ctx.fail (#694)', () => {
  it('writes a record whose stack starts at the handler’s throw, with no framework frame on top', async () => {
    const failing = tool('records_ctx_fail', {
      description: 'Fails through its contract.',
      input: z.object({}),
      output: ok,
      errors: [
        {
          reason: 'gone',
          code: JsonRpcErrorCode.NotFound,
          when: 'The item is gone.',
          recovery: 'Search for the item again before retrying the call.',
        },
      ],
      handler: (_input, ctx) => {
        throw ctx.fail('gone');
      },
    });

    const result = await callTool(failing);

    expect(envelope(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'gone' },
    });
    const { stack } = errorRecord('records_ctx_fail');
    const [header, top] = String(stack).split('\n');
    expect(header).toBe('McpError: The item is gone.');
    // Matched by file: under coverage JSC renames frames, so a function name is not stable.
    expect(top).toContain('toolHandlerFactory.unreadableErrors.test.ts:');
    expect(stack).not.toMatch(/core[\\/]context\.[jt]s/);
  });
});
