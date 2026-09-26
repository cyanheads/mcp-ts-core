/**
 * @fileoverview Opt-in failed-call payload logging (#291) under real workerd,
 * where no file sink exists: `LOG_TOOL_FAILURE_PAYLOADS` arrives as a Worker
 * binding and the record reaches the logger's OTel Logs API sink, the one
 * observable destination inside the isolate.
 * @module tests/worker/tool-failure-payload.worker.test
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { resetConfig } from '@/config/index.js';
import type { CloudflareBindings } from '@/core/worker.js';
import { type OtelLogRecord, setOtelLogSink } from '@/utils/internal/logger.js';
import worker from '../fixtures/worker-runtime.fixture.js';
import { jsonrpc, MCP_HEADERS, parseSseDataFrames } from './wire-helpers.js';

/** One stateless 2026-07-28 `tools/call` against the fixture, with `bindings` as the Worker env. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  bindings: CloudflareBindings,
): Promise<{ result: Record<string, unknown> }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: jsonrpc(1, 'tools/call', {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'payload-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }),
    }),
    bindings,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  expect(response.status, text).toBe(200);
  return text.startsWith('event:') || text.startsWith('data:')
    ? (parseSseDataFrames(text)[0] as { result: Record<string, unknown> })
    : JSON.parse(text);
}

/** Captures every record the logger writes, for the duration of one call. */
function captureRecords(): OtelLogRecord[] {
  const records: OtelLogRecord[] = [];
  setOtelLogSink({ emit: (record) => records.push(record) });
  // Config is parsed once per isolate; re-read it after the call injects the bindings.
  resetConfig();
  return records;
}

const REJECTED_ARGS = { message: 'workerd payload', auth: { apiKey: 'sk-worker-291' } };

afterEach(() => {
  setOtelLogSink(undefined);
  // `injectEnvVars` sets bindings on `process.env` but never clears them.
  delete process.env.LOG_TOOL_FAILURE_PAYLOADS;
  resetConfig();
});

describe('failed-call payload logging on workerd (#291)', () => {
  it('writes no payload record when the binding is unset', async () => {
    const records = captureRecords();

    const called = await callTool('echo', REJECTED_ARGS, env);

    expect(called.result.isError).toBe(true);
    expect(records.some((r) => r.body.startsWith('Error in tool:echo'))).toBe(true);
    expect(records.filter((r) => r.body.startsWith('Tool failure payload'))).toEqual([]);
    for (const r of records) expect(JSON.stringify(r.attributes)).not.toContain('workerd payload');
  });

  it('writes one redacted payload record from the LOG_TOOL_FAILURE_PAYLOADS binding', async () => {
    const records = captureRecords();

    const called = await callTool('echo', REJECTED_ARGS, {
      ...env,
      LOG_TOOL_FAILURE_PAYLOADS: 'true',
    } as CloudflareBindings);

    expect(called.result.isError).toBe(true);
    const payloads = records.filter((r) => r.body === 'Tool failure payload: echo');
    expect(payloads).toHaveLength(1);
    const { attributes, severityText } = payloads[0]!;
    expect(severityText).toBe('error');
    expect(JSON.parse(attributes.toolInput as string)).toEqual({
      message: 'workerd payload',
      auth: { apiKey: '[REDACTED]' },
    });
    expect(attributes.toolInput).not.toContain('sk-worker-291');
    expect(called.result).toMatchObject(JSON.parse(attributes.toolResult as string));
    expect(attributes).toMatchObject({ toolInputTruncated: false, toolResultTruncated: false });

    const errorRecord = records.find((r) => r.body.startsWith('Error in tool:echo'));
    expect(attributes.requestId).toBe(errorRecord?.attributes.requestId);
  });
});
