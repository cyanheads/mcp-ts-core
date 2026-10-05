/**
 * @fileoverview The `Error in tool:<name>` record a refused call writes, driven
 * through the real handler factory, error handler, auth utilities, and
 * `Logger`: a missing-scope refusal logs at `notice` with no stack (#585), and
 * an argument rejection's record stays bounded whatever the caller sends
 * (#631). Only pino is replaced, by a recording double, and the metrics module,
 * so every record and counter increment is observable in-process; an OTel Logs
 * API sink alongside reports each record's MCP level.
 * @module tests/unit/mcp-server/tools/utils/toolHandlerFactory.rejectionRecords.test
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { makeServerContext } from '../../../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { counterAdds, mockConfig, writes } = vi.hoisted(() => ({
  /** Every counter increment, in emission order. */
  counterAdds: [] as Array<{ attributes: Record<string, unknown>; metric: string }>,
  mockConfig: {
    environment: 'testing',
    logRateLimitThreshold: 0,
    logRateLimitWindowMs: 60_000,
    logsPath: undefined as string | undefined,
    logToolFailurePayloadMaxBytes: 16_384,
    logToolFailurePayloads: false,
    mcpAuthDisableScopeChecks: false,
    mcpAuthMode: 'none' as 'jwt' | 'none',
    mcpServerVersion: '1.0.0-test',
    mcpSessionMode: 'auto',
    mcpTransportType: 'stdio',
    openTelemetry: { serviceName: 'test', serviceVersion: '0.0.0' },
  },
  /** Every record the `Logger` handed pino, in emission order. */
  writes: [] as Array<{ fields: Record<string, unknown>; level: string; msg: string }>,
}));

vi.mock('@/config/index.js', () => ({ config: mockConfig }));

vi.mock('pino', () => {
  const record = (level: string) => (fields: Record<string, unknown>, msg: string) => {
    writes.push({ fields, level, msg });
  };
  const instance = {
    debug: record('debug'),
    error: record('error'),
    fatal: record('fatal'),
    flush: (cb: (err?: Error) => void) => cb(),
    info: record('info'),
    level: 'debug',
    warn: record('warn'),
  };
  return { default: () => instance };
});

vi.mock('@/utils/telemetry/metrics.js', () => {
  const instrument = (metric: string) => ({
    add: (_value: number, attributes: Record<string, unknown> = {}) => {
      counterAdds.push({ attributes, metric });
    },
    record: () => {},
  });
  return {
    getMeter: () => ({}),
    createCounter: (name: string) => instrument(name),
    createUpDownCounter: (name: string) => instrument(name),
    createHistogram: (name: string) => instrument(name),
    createObservableGauge: () => ({}),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  type AnyResourceDefinition,
  resource,
} from '@/mcp-server/resources/utils/resourceDefinition.js';
import { createResourceHandler } from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  classifyAndBuildToolErrorResult,
  createToolHandler,
  type HandlerServices,
  parseToolArguments,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import { checkScopes } from '@/mcp-server/transports/auth/lib/checkScopes.js';
import { forbidden, JsonRpcErrorCode } from '@/types-global/errors.js';
import {
  logger,
  type OtelLogRecord,
  sanitizeLogBindings,
  setOtelLogSink,
} from '@/utils/internal/logger.js';
import { httpErrorFromResponse } from '@/utils/network/httpError.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const exported: OtelLogRecord[] = [];

const services = { logger, storage: {} } as unknown as HandlerServices;

/** A validated token holding none of the scopes the probes require. */
const AUTH_INFO: AuthInfo = {
  token: 'probe-token',
  clientId: 'probe-client',
  scopes: ['other:read'],
  subject: 'probe-user',
};

/** The framework-generated request id every envelope carries (#584). */
const REQUEST_ID = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

beforeAll(async () => {
  await logger.initialize('debug');
  setOtelLogSink({ emit: (record) => exported.push(record) });
});

afterAll(async () => {
  setOtelLogSink(undefined);
  await logger.close();
});

beforeEach(() => {
  writes.length = 0;
  exported.length = 0;
  counterAdds.length = 0;
  mockConfig.logToolFailurePayloads = false;
  mockConfig.mcpAuthMode = 'none';
});

/** Drives one `tools/call` through the factory, inside a validated token's auth context when asked. */
async function callTool(
  def: unknown,
  args: Record<string, unknown>,
  options: { authenticated?: boolean } = {},
): Promise<CallToolResult> {
  const handler = createToolHandler(def as AnyToolDefinition, services, {});
  const run = () => handler(args, makeServerContext());
  return (await (options.authenticated
    ? authContext.run({ authInfo: AUTH_INFO }, run)
    : run())) as CallToolResult;
}

/** The error envelope a failed call published. */
function envelope(result: CallToolResult): {
  code: number;
  data?: Record<string, unknown> & {
    issues?: Array<Record<string, unknown>>;
    recovery?: { hint: string };
    requestId?: string;
  };
  message: string;
} {
  return (result.structuredContent as { error: ReturnType<typeof envelope> }).error;
}

/** The call's own `Error in tool:` record as pino received it. */
function errorRecord(): {
  fields: Record<string, unknown> & { errorData: Record<string, any> };
  level: string;
  msg: string;
} {
  const found = writes.filter((w) => w.msg.startsWith('Error in tool:'));
  expect(found).toHaveLength(1);
  return found[0] as ReturnType<typeof errorRecord>;
}

/** The MCP level (`notice`, `error`, …) a record whose message starts with `prefix` was emitted at. */
function levelOf(prefix: string): string {
  const found = exported.filter((r) => r.body.startsWith(prefix));
  expect(found).toHaveLength(1);
  return found[0]!.severityText;
}

/** The record as the logger serializes it — the line `combined.log` holds, minus pino's own base fields. */
function serialized(record: { fields: Record<string, unknown>; msg: string }): string {
  return JSON.stringify({ ...sanitizeLogBindings(record.fields), msg: record.msg });
}

/** Counter increments recorded for one metric name. */
function adds(metric: string): Array<Record<string, unknown>> {
  return counterAdds.filter((a) => a.metric === metric).map((a) => a.attributes);
}

/** Every record above `debug`, as `[pino level, message]`. */
function nonDebugWrites(): Array<[string, string]> {
  return writes.filter((w) => w.level !== 'debug').map((w) => [w.level, w.msg]);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const ok = z.object({ ok: z.boolean().describe('ok') });

const scoped = tool('records_scoped', {
  description: 'Requires a scope.',
  input: z.object({}),
  output: ok,
  auth: ['tool:records_scoped:read'],
  handler: () => ({ ok: true }),
});

const dynamic = tool('records_dynamic', {
  description: 'Checks a scope at runtime.',
  input: z.object({ team: z.string().describe('Team id.') }),
  output: ok,
  handler: (input, ctx) => {
    checkScopes(ctx, [`team:${input.team}:write`]);
    return { ok: true };
  },
});

const handlerForbids = tool('records_handler_forbids', {
  description: 'Refuses on its own.',
  input: z.object({}),
  output: ok,
  handler: () => {
    throw forbidden('Handler refused.');
  },
});

const upstreamForbids = tool('records_upstream_forbids', {
  description: 'Maps an upstream 403.',
  input: z.object({}),
  output: ok,
  handler: async () => {
    throw await httpErrorFromResponse(new Response('denied', { status: 403 }), {
      service: 'Upstream',
    });
  },
});

const search = tool('records_search', {
  description: 'Strict input.',
  input: z.object({
    query: z.string().describe('Search query.'),
    items: z.array(z.string()).optional().describe('Items.'),
  }),
  output: ok,
  handler: () => ({ ok: true }),
});

const loud = tool('records_loud', {
  description: 'Fails with a long message.',
  input: z.object({}),
  output: ok,
  handler: () => {
    throw new Error(`Upstream said: ${'z'.repeat(5_000)}`);
  },
});

// ---------------------------------------------------------------------------
// #585 — a missing-scope refusal
// ---------------------------------------------------------------------------

describe('a tool refused for a missing scope (#585)', () => {
  beforeEach(() => {
    mockConfig.mcpAuthMode = 'jwt';
  });

  /** The two refusal paths: the inline `auth` check and `checkScopes` in the handler. */
  const REFUSALS = [
    [
      'the inline auth check',
      scoped,
      {},
      'Authorization failed: Missing required scopes.',
      { missingScopes: ['tool:records_scoped:read'], grantedScopes: ['other:read'] },
    ],
    [
      'checkScopes in the handler',
      dynamic,
      { team: 't1' },
      'Authorization failed: missing required scopes.',
      { missingScopes: ['team:t1:write'], requiredScopes: ['team:t1:write'] },
    ],
  ] as const;

  it.each(REFUSALS)(
    'logs the Error in tool: record for %s at notice, with no stack',
    async (_label, def, args) => {
      await callTool(def, args, { authenticated: true });

      const record = errorRecord();
      expect(record.msg).toBe(`Error in tool:${def.name}: Insufficient permissions.`);
      expect(levelOf('Error in tool:')).toBe('notice');
      expect(record.fields).not.toHaveProperty('stack');
      expect(record.fields.errorData).not.toHaveProperty('originalStack');
      expect(record.fields).toMatchObject({
        errorCode: JsonRpcErrorCode.Forbidden,
        errorData: { originalErrorName: 'McpError', originalMessage: 'Insufficient permissions.' },
      });
      expect(writes.filter((w) => w.level === 'error')).toEqual([]);
    },
  );

  it.each(REFUSALS)(
    'keeps the scope check’s warning record for %s, missing scopes included',
    async (_label, def, args, warning, scopes) => {
      await callTool(def, args, { authenticated: true });

      expect(writes.filter((w) => w.level === 'warn').map((w) => w.msg)).toEqual([warning]);
      const record = writes.find((w) => w.msg === warning);
      expect(record?.fields).toMatchObject(scopes);
      expect(levelOf(warning)).toBe('warning');
    },
  );

  it.each(REFUSALS)(
    'counts %s on mcp.errors.classified with mcp.error.severity: notice',
    async (_label, def, args) => {
      await callTool(def, args, { authenticated: true });

      expect(adds('mcp.errors.classified')).toEqual([
        {
          'mcp.error.classified_code': String(JsonRpcErrorCode.Forbidden),
          'mcp.error.category': 'client',
          'mcp.error.severity': 'notice',
          operation: `tool:${def.name}`,
        },
      ]);
    },
  );

  it.each(REFUSALS)('leaves the wire result for %s as it was', async (_label, def, args) => {
    const result = await callTool(def, args, { authenticated: true });

    const requestId = envelope(result).data?.requestId as string;
    expect(requestId).toMatch(REQUEST_ID);
    expect(result).toEqual({
      isError: true,
      content: [
        { type: 'text', text: `Error: Insufficient permissions.\n\n(request ${requestId})` },
      ],
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.Forbidden,
          message: 'Insufficient permissions.',
          data: { requestId },
        },
      },
    });
  });

  it('counts the inline refusal once on mcp.tool.rejections and never as a call', async () => {
    await callTool(scoped, {}, { authenticated: true });

    expect(adds('mcp.tool.rejections')).toEqual([
      {
        'mcp.tool.name': 'records_scoped',
        'mcp.tool.error_code': String(JsonRpcErrorCode.Forbidden),
        'mcp.tool.error_category': 'client',
      },
    ]);
    expect(adds('mcp.tool.calls')).toEqual([]);
    expect(adds('mcp.tool.errors')).toEqual([]);
  });

  it('counts the checkScopes refusal as the failed call it was, never as a rejection', async () => {
    await callTool(dynamic, { team: 't1' }, { authenticated: true });

    expect(adds('mcp.tool.rejections')).toEqual([]);
    expect(adds('mcp.tool.errors')).toEqual([
      {
        'mcp.tool.name': 'records_dynamic',
        'mcp.tool.error_category': 'client',
        'mcp.tool.outcome': 'error',
      },
    ]);
  });

  it.each(REFUSALS)(
    'writes the payload record for %s at notice under LOG_TOOL_FAILURE_PAYLOADS',
    async (_label, def, args) => {
      mockConfig.logToolFailurePayloads = true;

      await callTool(def, args, { authenticated: true });

      expect(levelOf('Error in tool:')).toBe('notice');
      expect(levelOf('Tool failure payload:')).toBe('notice');
      expect(writes.filter((w) => w.level === 'error')).toEqual([]);
    },
  );

  describe('every other refusal keeps error, with the stack', () => {
    it.each([
      ['a handler’s own forbidden()', handlerForbids, {}, true, JsonRpcErrorCode.Forbidden],
      [
        'an upstream 403 from httpErrorFromResponse',
        upstreamForbids,
        {},
        true,
        JsonRpcErrorCode.Forbidden,
      ],
      [
        'a missing auth context at the inline check',
        scoped,
        {},
        false,
        JsonRpcErrorCode.Unauthorized,
      ],
      [
        'a missing auth context at checkScopes',
        dynamic,
        { team: 't1' },
        false,
        JsonRpcErrorCode.Unauthorized,
      ],
    ])('%s', async (_label, def, args, authenticated, code) => {
      const result = await callTool(def, args, { authenticated });

      expect(envelope(result).code).toBe(code);
      expect(levelOf('Error in tool:')).toBe('error');
      const record = errorRecord();
      expect(record.fields.stack).toEqual(expect.any(String));
      expect(record.fields.errorData.originalStack).toEqual(expect.any(String));
      expect(adds('mcp.errors.classified')[0]).not.toHaveProperty('mcp.error.severity');
    });
  });

  it('writes only the scope check’s records for a resource read its auth check refuses', async () => {
    const scopedResource = resource('records://{id}', {
      description: 'Requires a scope.',
      mimeType: 'application/json',
      params: z.object({ id: z.string().describe('Record id.') }),
      auth: ['resource:records:read'],
      handler: () => ({ ok: true }),
    });
    const read = createResourceHandler(scopedResource as AnyResourceDefinition, services, {});

    await expect(
      authContext.run({ authInfo: AUTH_INFO }, () =>
        read(new URL('records://1'), { id: '1' }, makeServerContext({ method: 'resources/read' })),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });

    expect(nonDebugWrites()).toEqual([['warn', 'Authorization failed: Missing required scopes.']]);
    expect(adds('mcp.errors.classified')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #631 — a bounded argument-rejection record
// ---------------------------------------------------------------------------

describe('an argument rejection’s record stays bounded (#631)', () => {
  const LONG_KEY = 'k'.repeat(200_000);

  /** The issue body's three reproduction inputs. */
  const REPRO = [
    ['a 200,000-character key', { query: 'x', [LONG_KEY]: 1 }],
    [
      '1,000 keys of 200 characters',
      {
        query: 'x',
        ...Object.fromEntries(
          Array.from({ length: 1_000 }, (_, i) => [String(i).padEnd(200, 'm'), 1]),
        ),
      },
    ],
    ['50,000 wrong-type items', { query: 'x', items: Array(50_000).fill(true) }],
  ] as const;

  /** The first 1,024 characters of `value`. */
  const cut = (value: string) => value.slice(0, 1_024);

  it.each(REPRO)(
    'serializes the record for %s to under 8 KiB, at notice, with no stack',
    async (_label, args) => {
      await callTool(search, args);

      const record = errorRecord();
      expect(Buffer.byteLength(serialized(record))).toBeLessThan(8 * 1_024);
      expect(levelOf('Error in tool:')).toBe('notice');
      expect(record.fields).not.toHaveProperty('stack');
      expect(record.fields.errorData).not.toHaveProperty('originalStack');
    },
  );

  it.each(REPRO)(
    'cuts the message and hint of the record for %s to their first 1,024 characters, with the uncut lengths',
    async (_label, args) => {
      const result = await callTool(search, args);

      const { message, data } = envelope(result);
      const hint = data?.recovery?.hint as string;
      expect(message.length).toBeGreaterThan(1_024);
      expect(hint.length).toBeGreaterThan(1_024);
      const { fields, msg } = errorRecord();
      expect(msg).toBe(`Error in tool:records_search: ${cut(message)}`);
      expect(fields.errorData).toMatchObject({
        reason: 'invalid_arguments',
        originalMessage: cut(message),
        originalMessageLength: message.length,
        recovery: { hint: cut(hint), hintLength: hint.length },
      });
    },
  );

  it('names the tool, the reason, and the long key’s first characters', async () => {
    const result = await callTool(search, { query: 'x', [LONG_KEY]: 1 });

    const { fields, msg } = errorRecord();
    expect(msg.startsWith('Error in tool:records_search: ')).toBe(true);
    expect(msg).toContain('k'.repeat(512));
    expect(fields.errorData.reason).toBe('invalid_arguments');
    const [issue] = envelope(result).data?.issues ?? [];
    const issueMessage = issue?.message as string;
    expect(fields.errorData.issues).toEqual([
      {
        ...issue,
        keys: [cut(LONG_KEY)],
        keysLengths: [200_000],
        message: cut(issueMessage),
        messageLength: issueMessage.length,
      },
    ]);
  });

  it('keeps the first 10 of 1,000 unknown keys, with the count', async () => {
    const result = await callTool(search, REPRO[1][1]);

    const [issue] = envelope(result).data?.issues ?? [];
    const keys = issue?.keys as string[];
    expect(keys).toHaveLength(1_000);
    const [logged] = errorRecord().fields.errorData.issues as Array<Record<string, unknown>>;
    expect(logged).toMatchObject({ keys: keys.slice(0, 10), keysCount: 1_000 });
    expect(logged).not.toHaveProperty('keysLengths');
  });

  it('keeps the first 10 of 50,000 issues, with the count', async () => {
    const result = await callTool(search, REPRO[2][1]);

    const issues = envelope(result).data?.issues ?? [];
    expect(issues).toHaveLength(50_000);
    const { errorData } = errorRecord().fields;
    expect(errorData.issues).toEqual(issues.slice(0, 10));
    expect(errorData.issuesCount).toBe(50_000);
  });

  it('cuts each input key the pre-validation step reports, with its length', async () => {
    const alias = `Q${'_'.repeat(5_000)}uery`;
    const dropped = `_${'v'.repeat(5_000)}`;

    const result = await callTool(search, { [alias]: true, [dropped]: 1 });

    expect(envelope(result).data?.input).toEqual({
      aliased: [{ alias, target: 'query' }],
      ignored: [dropped],
    });
    expect(errorRecord().fields.errorData.input).toEqual({
      aliased: [{ alias: cut(alias), aliasLength: alias.length, target: 'query' }],
      ignored: [cut(dropped)],
      ignoredLengths: [dropped.length],
    });
  });

  it('logs a rejection within the caps with the same fields as before, minus the stacks', async () => {
    const result = await callTool(search, { query: 'x', salt: true });

    const { message, data } = envelope(result);
    const { requestId: _requestId, ...thrown } = data ?? {};
    const record = errorRecord();
    expect(record.msg).toBe(`Error in tool:records_search: ${message}`);
    expect(record.fields.errorData).toEqual({
      ...thrown,
      originalErrorName: 'McpError',
      originalMessage: message,
    });
    expect(record.fields).not.toHaveProperty('stack');
    expect(levelOf('Error in tool:')).toBe('notice');
  });

  it.each(REPRO)(
    'builds the -32602 result for %s from the uncut rejection',
    async (_label, args) => {
      const result = await callTool(search, args);

      let rejection: unknown;
      try {
        parseToolArguments(search, args);
      } catch (error) {
        rejection = error;
      }
      expect(envelope(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(JSON.stringify(result)).toBe(
        JSON.stringify(
          classifyAndBuildToolErrorResult(rejection, envelope(result).data?.requestId as string),
        ),
      );
    },
  );

  it('keeps a handler throw at error, with the stack and the full message', async () => {
    await callTool(loud, {});

    const record = errorRecord();
    const message = `Upstream said: ${'z'.repeat(5_000)}`;
    expect(levelOf('Error in tool:')).toBe('error');
    expect(record.msg).toBe(`Error in tool:records_loud: ${message}`);
    expect(record.fields.stack).toEqual(expect.any(String));
    expect(record.fields.errorData).toMatchObject({
      originalMessage: message,
      originalStack: expect.any(String),
    });
    expect(record.fields.errorData).not.toHaveProperty('originalMessageLength');
  });
});
