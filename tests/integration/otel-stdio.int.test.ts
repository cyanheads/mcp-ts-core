/**
 * @fileoverview Black-box tests for OpenTelemetry under the stdio transport,
 * against the real `NodeSDK` and a local OTLP/HTTP collector: where the OTel
 * diagnostic logger writes and at what level (#545), and opt-in export of the
 * framework's own log records (#547).
 * @module tests/integration/otel-stdio.int.test
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runStdioSession, type StdioSessionResult } from '../helpers/stdio-session.js';

const DIST_INDEX = resolve(process.cwd(), 'dist/index.js');
const SERVER_FIXTURE = resolve(process.cwd(), 'tests/fixtures/stdio-log-server.js');

/** One request the collector received. */
interface CollectedExport {
  body: Record<string, unknown>;
  path: string;
}

let collector: Server;
let collectorUrl: string;
const received: CollectedExport[] = [];
let logsDir: string;

beforeAll(async () => {
  collector = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      received.push({ body: JSON.parse(raw || '{}'), path: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((listening) => collector.listen(0, '127.0.0.1', listening));
  collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  logsDir = mkdtempSync(join(tmpdir(), 'mcp-otel-stdio-'));
});

afterAll(async () => {
  await new Promise<void>((closed) => collector.close(() => closed()));
  rmSync(logsDir, { recursive: true, force: true });
});

beforeEach(() => {
  received.length = 0;
});

/** Boots `entry` over stdio with OTel on, runs `requests`, and ends it with stdin EOF. */
function runWithOtel(
  env: Record<string, string>,
  { entry = DIST_INDEX, requests = [{ method: 'tools/list' }] } = {},
): Promise<StdioSessionResult> {
  return runStdioSession({
    entry,
    env: {
      LOGS_DIR: logsDir,
      MCP_LOG_LEVEL: 'info',
      MCP_TRANSPORT_TYPE: 'stdio',
      NODE_ENV: 'development',
      OTEL_ENABLED: 'true',
      ...env,
    },
    requests,
  });
}

/** Every non-JSON-RPC line on stdout — must be empty under stdio. */
function nonJsonRpcLines(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    try {
      return (JSON.parse(line) as { jsonrpc?: string }).jsonrpc !== '2.0';
    } catch {
      return true;
    }
  });
}

const TRACES_EXPORTER_LINE = 'Using OTLP exporter for traces';

describe('OTel diagnostic logger (#545)', () => {
  it.each([
    ['unset', undefined, true],
    ['WARN', 'WARN', false],
    ['INFO', 'INFO', true],
    ['DEBUG', 'DEBUG', true],
    ['warning', 'warning', false],
    ['err', 'err', false],
    ['information', 'information', true],
  ] as const)(
    'OTEL_LOG_LEVEL=%s: one stderr-only diag logger at the mapped level',
    async (_label, level, infoVisible) => {
      const run = await runWithOtel({
        OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
        ...(level && { OTEL_LOG_LEVEL: level }),
      });
      const output = `${run.stdoutLines.join('\n')}\n${run.stderr}`;

      expect(run.code).toBe(0);
      expect(run.responses[0]?.result).toBeDefined();
      expect(nonJsonRpcLines(run.stdoutLines)).toEqual([]);
      expect(output).not.toContain('Current logger will');
      expect(output).not.toContain('Unknown log level');
      expect(output).not.toMatch(/Timeout of \d+ exceeds the interval/);
      // A diag.info line appears, on stderr, exactly when the resolved level admits info.
      expect(run.stderr.includes(TRACES_EXPORTER_LINE)).toBe(infoVisible);
    },
  );
});

/** OTLP/JSON log records the collector received, flattened. */
function collectedLogRecords(): Array<Record<string, any>> {
  return received
    .filter((entry) => entry.path === '/v1/logs')
    .flatMap((entry) => (entry.body.resourceLogs as any[]) ?? [])
    .flatMap((resourceLogs) => resourceLogs.scopeLogs ?? [])
    .flatMap((scopeLogs) => scopeLogs.logRecords ?? []);
}

/** OTLP/JSON spans the collector received, flattened. */
function collectedSpans(): Array<Record<string, any>> {
  return received
    .filter((entry) => entry.path === '/v1/traces')
    .flatMap((entry) => (entry.body.resourceSpans as any[]) ?? [])
    .flatMap((resourceSpans) => resourceSpans.scopeSpans ?? [])
    .flatMap((scopeSpans) => scopeSpans.spans ?? []);
}

const ECHO_CALL = {
  method: 'tools/call',
  params: { name: 'echo_logged', arguments: { message: 'exported' } },
};

describe('OTLP log export (#547)', () => {
  it('exports the framework records, with severity and the tool call trace context, when the logs endpoint is set', async () => {
    const run = await runWithOtel(
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collectorUrl}/v1/logs`,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collectorUrl}/v1/traces`,
      },
      { entry: SERVER_FIXTURE, requests: [ECHO_CALL] },
    );

    expect(run.code).toBe(0);
    expect(run.responses[0]?.result).toMatchObject({ structuredContent: { message: 'exported' } });

    const records = collectedLogRecords();
    const bodies = records.map((record) => record.body?.stringValue);
    expect(bodies).toContain('Logger initialized. MCP level: info.');
    // Debug records are below MCP_LOG_LEVEL=info and never reach the exporter.
    expect(records.every((record) => record.severityNumber >= 9)).toBe(true);

    const handlerRecord = records.find(
      (record) => record.body?.stringValue === 'echo_logged handler ran',
    );
    expect(handlerRecord).toMatchObject({ severityNumber: 9, severityText: 'info' });
    expect(handlerRecord?.traceId).toMatch(/^[0-9a-f]{32}$/);

    const toolSpan = collectedSpans().find((span) => span.name === 'tool_execution:echo_logged');
    expect(toolSpan).toBeDefined();
    expect(handlerRecord?.traceId).toBe(toolSpan?.traceId);
  });

  it('sends no /v1/logs request when only the base endpoint is set', async () => {
    const run = await runWithOtel(
      { OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl },
      { entry: SERVER_FIXTURE, requests: [ECHO_CALL] },
    );

    expect(run.code).toBe(0);
    // The collector was reachable and received the call's trace...
    expect(received.some((entry) => entry.path === '/v1/traces')).toBe(true);
    // ...but no log export, because the base endpoint does not enable it.
    expect(received.some((entry) => entry.path === '/v1/logs')).toBe(false);
  });
});
