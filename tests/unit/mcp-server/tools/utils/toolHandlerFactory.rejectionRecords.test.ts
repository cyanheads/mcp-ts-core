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

import {
  type CallToolResult,
  type ClientCapabilities,
  inputRequired,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { legacyCapabilityView, makeServerContext } from '../../../../helpers/server-context.js';

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
import { forbidden, invalidParams, JsonRpcErrorCode } from '@/types-global/errors.js';
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

/**
 * Drives one `tools/call` through the factory, inside a validated token's auth
 * context when asked, and on a 2025-era connection declaring `capabilities` when given.
 */
async function callTool(
  def: unknown,
  args: Record<string, unknown>,
  options: { authenticated?: boolean; capabilities?: ClientCapabilities } = {},
): Promise<CallToolResult> {
  const handler = createToolHandler(
    def as AnyToolDefinition,
    services,
    {},
    options.capabilities && legacyCapabilityView(options.capabilities),
  );
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

const relays = tool('records_relays', {
  description: 'Relays an upstream argument rejection from inside the handler.',
  input: z.object({}),
  output: ok,
  handler: () => {
    throw invalidParams(`Upstream rejected: ${'y'.repeat(5_000)}`, {
      reason: 'invalid_arguments',
    });
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
      // The throw site's stack, once (#694).
      expect(record.fields.stack).toEqual(expect.any(String));
      expect(record.fields.stack).not.toMatch(/at (ErrorHandler\.)?handleError /);
      expect(record.fields.errorData).not.toHaveProperty('originalStack');
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
// #651 — a client_capability_missing refusal
// ---------------------------------------------------------------------------

describe('a client_capability_missing refusal (#651)', () => {
  const CAPABILITY_HINT =
    'Reconnect with a client that declares the `elicitation.form` capability.';
  const CAPABILITY_MESSAGE =
    "Cannot request input 'confirm' (elicitation/create): the client on this 2025-era " +
    'connection did not declare the `elicitation.form` capability';

  /** A tool that asks the caller to confirm, declaring `errors` when given. */
  function asks(name: string, errors?: readonly unknown[]): unknown {
    return tool(name, {
      description: 'Asks the caller to confirm.',
      input: z.object({}),
      output: ok,
      ...(errors && { errors: errors as never }),
      handler: (_input, ctx) =>
        ctx.requestInput({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: 'Proceed?',
              requestedSchema: z.object({ yes: z.boolean().describe('Proceed.') }),
            }),
          },
        }),
    });
  }

  it('logs the Error in tool: record at notice, with no stack', async () => {
    await callTool(asks('records_asks'), {}, { capabilities: {} });

    const record = errorRecord();
    expect(record.msg).toBe(`Error in tool:records_asks: ${CAPABILITY_MESSAGE}`);
    expect(levelOf('Error in tool:')).toBe('notice');
    expect(record.fields).not.toHaveProperty('stack');
    expect(record.fields.errorData).not.toHaveProperty('originalStack');
    expect(serialized(record)).not.toMatch(/"stack"|originalStack|inputRequired\.ts/);
    expect(record.fields).toMatchObject({
      errorCode: JsonRpcErrorCode.InvalidRequest,
      errorData: { reason: 'client_capability_missing', recovery: { hint: CAPABILITY_HINT } },
    });
  });

  it('logs at the level an errors[] entry naming the reason declares, still with no stack', async () => {
    const declared = asks('records_asks_declared', [
      {
        reason: 'client_capability_missing',
        code: JsonRpcErrorCode.InvalidRequest,
        when: 'The client connection cannot answer the confirmation.',
        severity: 'warning',
        recovery: 'Reconnect with a client that supports elicitation and retry.',
      },
    ]);

    await callTool(declared, {}, { capabilities: {} });

    const record = errorRecord();
    expect(levelOf('Error in tool:')).toBe('warning');
    expect(record.fields).not.toHaveProperty('stack');
    expect(serialized(record)).not.toMatch(/"stack"|originalStack/);
  });

  it('leaves the wire result and the notice severity on mcp.errors.classified as they were', async () => {
    const result = await callTool(asks('records_asks_wire'), {}, { capabilities: {} });

    const requestId = envelope(result).data?.requestId as string;
    expect(requestId).toMatch(REQUEST_ID);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `Error: ${CAPABILITY_MESSAGE}\n\nRecovery: ${CAPABILITY_HINT}` +
            `\n\n(reason client_capability_missing · request ${requestId})`,
        },
      ],
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InvalidRequest,
          message: CAPABILITY_MESSAGE,
          data: {
            reason: 'client_capability_missing',
            recovery: { hint: CAPABILITY_HINT },
            requestId,
          },
        },
      },
    });
    expect(adds('mcp.errors.classified')).toEqual([
      {
        'mcp.error.classified_code': String(JsonRpcErrorCode.InvalidRequest),
        'mcp.error.category': 'client',
        'mcp.error.severity': 'notice',
        operation: 'tool:records_asks_wire',
      },
    ]);
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

  /**
   * Per-test timeout for the cases that build a 50,000-issue rejection: a
   * second or more alone, several times that under a full parallel run, past
   * the unit project's 5 s default.
   */
  const REPRO_TIMEOUT_MS = 30_000;

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
    REPRO_TIMEOUT_MS,
  );

  it.each(REPRO)(
    'cuts the message and hint the result carries for %s to their first 1,024 characters in the record, with the uncut lengths',
    async (_label, args) => {
      const result = await callTool(search, args);

      const { message, data } = envelope(result);
      const hint = data?.recovery?.hint as string;
      const { fields, msg } = errorRecord();
      expect(msg).toBe(`Error in tool:records_search: ${cut(message)}`);
      expect(fields.errorData).toMatchObject({
        reason: 'invalid_arguments',
        originalMessage: cut(message),
        recovery: { hint: cut(hint) },
      });
      // A length beside each field the record cut, and none beside one it kept whole.
      expect(fields.errorData.originalMessageLength).toBe(
        message.length > 1_024 ? message.length : undefined,
      );
      expect(fields.errorData.recovery.hintLength).toBe(
        hint.length > 1_024 ? hint.length : undefined,
      );
    },
    REPRO_TIMEOUT_MS,
  );

  it.each(REPRO)(
    'bounds the -32602 result for %s: its text under 4 KiB, at most 10 issues (#648)',
    async (_label, args) => {
      const result = await callTool(search, args);

      const [block] = result.content ?? [];
      expect(Buffer.byteLength((block as { text: string }).text)).toBeLessThan(4 * 1_024);
      expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThan(8 * 1_024);
      const issues = envelope(result).data?.issues ?? [];
      expect(issues.length).toBeLessThanOrEqual(10);
    },
    REPRO_TIMEOUT_MS,
  );

  it('names the tool, the reason, and the long key’s first characters', async () => {
    const result = await callTool(search, { query: 'x', [LONG_KEY]: 1 });

    const { fields, msg } = errorRecord();
    expect(msg.startsWith('Error in tool:records_search: ')).toBe(true);
    expect(msg).toContain('k'.repeat(512));
    expect(fields.errorData.reason).toBe('invalid_arguments');
    const zodMessage = `Unrecognized key: "${LONG_KEY}"`;
    const bounded = {
      code: 'unrecognized_keys',
      keys: [cut(LONG_KEY)],
      keysLengths: [200_000],
      path: [],
      message: cut(zodMessage),
      messageLength: zodMessage.length,
    };
    // The result carries the bounded issue (#648), and the record the same one.
    expect(envelope(result).data?.issues).toEqual([bounded]);
    expect(fields.errorData.issues).toEqual([bounded]);
  });

  it('keeps the first 10 of 1,000 unknown keys, with the count', async () => {
    const result = await callTool(search, REPRO[1][1]);

    const keys = Object.keys(REPRO[1][1]).filter((key) => key !== 'query');
    const [issue] = envelope(result).data?.issues ?? [];
    expect(issue).toMatchObject({ keys: keys.slice(0, 10), keysCount: 1_000 });
    expect(issue).not.toHaveProperty('keysLengths');
    const [logged] = errorRecord().fields.errorData.issues as Array<Record<string, unknown>>;
    expect(logged).toEqual(issue);
  });

  it(
    'keeps the first 10 of 50,000 issues, with the count',
    async () => {
      const result = await callTool(search, REPRO[2][1]);

      const zodIssues = search.input.safeParse(REPRO[2][1]).error?.issues ?? [];
      const { data } = envelope(result);
      expect(data?.issues).toEqual(zodIssues.slice(0, 10));
      expect(data?.issuesCount).toBe(50_000);
      const { errorData } = errorRecord().fields;
      expect(errorData.issues).toEqual(zodIssues.slice(0, 10));
      expect(errorData.issuesCount).toBe(50_000);
    },
    REPRO_TIMEOUT_MS,
  );

  it('cuts each input key the pre-validation step reports, with its length', async () => {
    const alias = `Q${'_'.repeat(5_000)}uery`;
    const dropped = `_${'v'.repeat(5_000)}`;

    const result = await callTool(search, { [alias]: true, [dropped]: 1 });

    const bounded = {
      aliased: [{ alias: cut(alias), aliasLength: alias.length, target: 'query' }],
      ignored: [cut(dropped)],
      ignoredLengths: [dropped.length],
    };
    expect(envelope(result).data?.input).toEqual(bounded);
    // Read from the serialized line: `aliased[0]` sits at depth 4 of the record.
    expect(JSON.parse(serialized(errorRecord())).errorData.input).toEqual(bounded);
  });

  describe('caller data a custom issue carries', () => {
    const echoes = tool('records_echoes', {
      description: 'Rejects every payload, echoing it in the issue.',
      input: z.object({ payload: z.unknown().describe('Payload.') }).superRefine((value, ctx) => {
        ctx.addIssue({
          code: 'custom',
          message: 'bad',
          params: value.payload as Record<string, unknown>,
        });
      }),
      output: ok,
      handler: () => ({ ok: true }),
    });

    /** `count` keys named after their index, each holding `value(i)`. */
    const indexed = (count: number, value: (i: number) => unknown = (i) => i) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value(i)]));

    const LONG = 'q'.repeat(100_000);

    it.each([
      ['10,000 keys', indexed(10_000)],
      ['a 100,000-character key', { [LONG]: 1 }],
      ['ten 2,000-character values', indexed(10, () => 'v'.repeat(2_000))],
      ['nested ten-wide objects', { tree: indexed(10, () => indexed(10, () => indexed(10))) }],
    ])(
      'logs the bounded issue the result carries for %s, under 16 KiB',
      async (_label, payload) => {
        const result = await callTool(echoes, { payload });

        // The record re-projects `data`, so the records the result's cut wrote must pass through it.
        const issues = envelope(result).data?.issues;
        const record = errorRecord();
        expect(record.fields.errorData.issues).toEqual(issues);
        expect(JSON.parse(serialized(record)).errorData.issues).toEqual(issues);
        expect(Buffer.byteLength(serialized(record))).toBeLessThan(16 * 1_024);
        expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThan(
          16 * 1_024,
        );
      },
    );

    it('keeps the first 10 of 10,000 keys and a long key’s first 1,024 characters', async () => {
      await callTool(echoes, { payload: { ...indexed(10_000), [LONG]: 1 } });
      const [wide] = errorRecord().fields.errorData.issues as Array<Record<string, unknown>>;
      expect(wide).toMatchObject({ params: indexed(10), paramsCount: 10_001 });

      writes.length = 0;
      await callTool(echoes, { payload: { [LONG]: 1 } });
      const [long] = errorRecord().fields.errorData.issues as Array<Record<string, unknown>>;
      expect(long?.params).toEqual({ [cut(LONG)]: 1, [`${cut(LONG)}KeyLength`]: 100_000 });
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
    'builds the -32602 result for %s from the rejection parseToolArguments throws',
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
    REPRO_TIMEOUT_MS,
  );

  it('keeps a handler throw at error, with the stack and the full message', async () => {
    await callTool(loud, {});

    const record = errorRecord();
    const message = `Upstream said: ${'z'.repeat(5_000)}`;
    expect(levelOf('Error in tool:')).toBe('error');
    expect(record.msg).toBe(`Error in tool:records_loud: ${message}`);
    // The handler's throw site, once (#694).
    expect(record.fields.stack).toEqual(expect.stringContaining(`Error: ${message}\n`));
    expect(record.fields.stack).not.toMatch(/at (ErrorHandler\.)?handleError /);
    expect(record.fields.errorData).toMatchObject({ originalMessage: message });
    expect(record.fields.errorData).not.toHaveProperty('originalStack');
    expect(record.fields.errorData).not.toHaveProperty('originalMessageLength');
  });

  it('keeps an invalid_arguments failure the handler raised whole, with the stack', async () => {
    // Only the schema gate's rejection, raised before the handler ran, is cut:
    // the same reason thrown from inside the handler is a fault worth a stack.
    await callTool(relays, {});

    const record = errorRecord();
    const message = `Upstream rejected: ${'y'.repeat(5_000)}`;
    expect(record.msg).toBe(`Error in tool:records_relays: ${message}`);
    // The handler's throw site, once (#694): the factory's own frame is cut.
    expect(record.fields.stack).toEqual(expect.stringContaining(`McpError: ${message}\n`));
    expect(record.fields.stack).not.toMatch(/at (ErrorHandler\.)?handleError /);
    expect(record.fields.stack).not.toMatch(/types-global[\\/]errors\.[jt]s/);
    expect(record.fields.errorData).toMatchObject({ originalMessage: message });
    expect(record.fields.errorData).not.toHaveProperty('originalStack');
    expect(record.fields.errorData).not.toHaveProperty('originalMessageLength');
  });
});
