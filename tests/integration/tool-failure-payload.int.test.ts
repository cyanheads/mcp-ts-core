/**
 * @fileoverview Black-box coverage for opt-in failed-call payload logging
 * (#291): a real server subprocess over stdio and over HTTP, a failing
 * `tools/call`, and the record read back from stderr and `combined.log` as the
 * real pino transports wrote it — redaction and all.
 * @module tests/integration/tool-failure-payload.int.test
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startServerFromEntrypoint } from '../helpers/server-process.js';
import { parseLogLines, runStdioSession } from '../helpers/stdio-session.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/failure-payload-server.js');
const PAYLOAD_MSG = 'Tool failure payload: payload_probe';
const SENTINEL = 'sentinel-int-291';
const API_KEY = 'sk-int-291';
const ARGS = { query: SENTINEL, auth: { apiKey: API_KEY } };

const tempDirs: string[] = [];

function makeLogsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-failure-payload-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readCombined(logsDir: string): Array<Record<string, unknown>> {
  const file = join(logsDir, 'combined.log');
  return existsSync(file) ? parseLogLines(readFileSync(file, 'utf8')) : [];
}

/** Asserts one payload record in `records`, redacted and matching `result`, and returns it. */
function expectOnePayload(
  records: Array<Record<string, unknown>>,
  result: unknown,
): Record<string, unknown> {
  const payloads = records.filter((record) => record.msg === PAYLOAD_MSG);
  expect(payloads).toHaveLength(1);
  const payload = payloads[0]!;
  expect(payload.level).toBe(50);
  expect(JSON.parse(payload.toolInput as string)).toEqual({
    query: SENTINEL,
    auth: { apiKey: '[REDACTED]' },
  });
  expect(JSON.parse(payload.toolResult as string)).toEqual(result);
  expect(payload).toMatchObject({ toolInputTruncated: false, toolResultTruncated: false });

  const errorRecord = records.find((record) =>
    String(record.msg).startsWith('Error in tool:payload_probe'),
  );
  expect(payload.requestId).toBe(errorRecord?.requestId);
  return payload;
}

describe('failed-call payload logging over stdio (#291)', () => {
  const runStdio = (logsDir: string, env: Record<string, string>) =>
    runStdioSession({
      entry: FIXTURE,
      env: {
        LOGS_DIR: logsDir,
        MCP_LOG_LEVEL: 'info',
        MCP_TRANSPORT_TYPE: 'stdio',
        NODE_ENV: 'production',
        ...env,
      },
      requests: [{ method: 'tools/call', params: { name: 'payload_probe', arguments: ARGS } }],
    });

  it('writes no payload record and no argument value when the flag is unset', async () => {
    const logsDir = makeLogsDir();

    const run = await runStdio(logsDir, { LOG_TOOL_FAILURE_PAYLOADS: '' });

    expect(run.code).toBe(0);
    expect(run.responses[0]?.result).toMatchObject({ isError: true });
    const records = [...parseLogLines(run.stderr), ...readCombined(logsDir)];
    expect(records.some((r) => String(r.msg).startsWith('Error in tool:payload_probe'))).toBe(true);
    expect(records.filter((r) => r.msg === PAYLOAD_MSG)).toEqual([]);
    expect(run.stderr).not.toContain(SENTINEL);
    expect(JSON.stringify(readCombined(logsDir))).not.toContain(SENTINEL);
  });

  it('writes one redacted payload record to stderr and combined.log when the flag is set', async () => {
    const logsDir = makeLogsDir();

    const run = await runStdio(logsDir, { LOG_TOOL_FAILURE_PAYLOADS: 'true' });

    expect(run.code).toBe(0);
    const result = run.responses[0]?.result;
    expect(result).toMatchObject({ isError: true });
    expectOnePayload(parseLogLines(run.stderr), result);
    await expect
      .poll(() => readCombined(logsDir).some((r) => r.msg === PAYLOAD_MSG), { timeout: 5_000 })
      .toBe(true);
    expectOnePayload(readCombined(logsDir), result);
    expect(run.stderr).not.toContain(API_KEY);
    expect(readFileSync(join(logsDir, 'combined.log'), 'utf8')).not.toContain(API_KEY);
  });
});

describe('failed-call payload logging over HTTP (#291)', () => {
  it('writes one redacted payload record to stderr and combined.log when the flag is set', async () => {
    const logsDir = makeLogsDir();
    const server = await startServerFromEntrypoint(FIXTURE, 'http', {
      LOGS_DIR: logsDir,
      LOG_TOOL_FAILURE_PAYLOADS: 'true',
      MCP_LOG_LEVEL: 'info',
      MCP_SESSION_MODE: 'stateless',
      NODE_ENV: 'production',
    });
    let stderr = '';
    server.process.stderr?.setEncoding('utf8');
    server.process.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    let result: unknown;
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'payload_probe',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'payload_probe',
            arguments: ARGS,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'payload-int', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const body =
        text.startsWith('event:') || text.startsWith('data:')
          ? JSON.parse(
              text
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join(''),
            )
          : JSON.parse(text);
      result = body.result;
      expect(result).toMatchObject({ isError: true });

      await expect
        .poll(() => readCombined(logsDir).some((r) => r.msg === PAYLOAD_MSG), { timeout: 10_000 })
        .toBe(true);
    } finally {
      await server.kill();
    }

    // The 2026-07-28 wire adds protocol framing after the handler returns; the
    // record carries the tool result the factory built, which is everything else.
    const { _meta, resultType, ...toolResult } = result as Record<string, unknown>;
    expect(resultType).toBe('complete');
    expect(Object.keys(_meta as object)).toEqual(['io.modelcontextprotocol/serverInfo']);
    expectOnePayload(readCombined(logsDir), toolResult);
    expectOnePayload(parseLogLines(stderr), toolResult);
    expect(stderr).not.toContain(API_KEY);
    expect(readFileSync(join(logsDir, 'combined.log'), 'utf8')).not.toContain(API_KEY);
  });
});
