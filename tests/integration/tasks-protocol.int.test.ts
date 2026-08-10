/**
 * @fileoverview Official-SDK black-box conformance for the built package's
 * experimental Tasks protocol over stdio and stateful Streamable HTTP.
 * @module tests/integration/tasks-protocol.int.test
 */

import { resolve } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ResponseMessage, Task } from '@modelcontextprotocol/sdk/experimental/tasks';
import {
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/task-protocol-server.js');
const TASK_TTL_MS = 2_500;
const TASK_ENV = {
  MCP_HEARTBEAT_INTERVAL_MS: '0',
  TASK_STORE_DEFAULT_TTL_MS: String(TASK_TTL_MS),
};

type TransportKind = 'stdio' | 'http';

interface Harness {
  client: Client;
  close(): Promise<void>;
  httpHandle?: ServerHandle;
}

function clientInfo(suffix: string) {
  return { name: `tasks-conformance-${suffix}`, version: '1.0.0' };
}

async function connectHttpClient(port: number, sessionId?: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    sessionId ? { sessionId } : undefined,
  );
  const client = new Client(clientInfo(`http-${crypto.randomUUID()}`));
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return { client, transport };
}

async function createHarness(kind: TransportKind): Promise<Harness> {
  if (kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [FIXTURE],
      env: { ...process.env, ...TASK_ENV, MCP_LOG_LEVEL: 'error', MCP_TRANSPORT_TYPE: 'stdio' },
      stderr: 'pipe',
    });
    const client = new Client(clientInfo('stdio'));
    await client.connect(transport);
    return { client, close: () => client.close() };
  }

  const httpHandle = await startServerFromEntrypoint(FIXTURE, 'http', {
    ...TASK_ENV,
    MCP_SESSION_MODE: 'stateful',
  });
  const { client } = await connectHttpClient(httpHandle.port as number);
  return {
    client,
    httpHandle,
    async close() {
      await client.close().catch(() => undefined);
      await httpHandle.kill();
    },
  };
}

async function collectTaskStream(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ResponseMessage<CallToolResult>[]> {
  const messages: ResponseMessage<CallToolResult>[] = [];
  const stream = client.experimental.tasks.callToolStream(
    { name, arguments: args },
    CallToolResultSchema,
    { task: { ttl: TASK_TTL_MS }, timeout: 10_000 },
  );
  for await (const message of stream) messages.push(message);
  return messages;
}

async function createTaskOnly(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Task> {
  const stream = client.experimental.tasks.callToolStream(
    { name, arguments: args },
    CallToolResultSchema,
    { task: { ttl: TASK_TTL_MS }, timeout: 10_000 },
  );
  const first = await stream.next();
  await stream.return();
  if (first.done || first.value.type !== 'taskCreated') {
    throw new Error(
      `Expected taskCreated, received ${first.done ? 'end-of-stream' : first.value.type}`,
    );
  }
  return first.value.task;
}

async function waitForTaskStatus(
  client: Client,
  taskId: string,
  status: Task['status'],
  timeoutMs = 5_000,
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await client.experimental.tasks.getTask(taskId);
    if (task.status === status) return task;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Task ${taskId} did not reach ${status} within ${timeoutMs}ms`);
}

async function readProbe(client: Client): Promise<Record<string, number>> {
  const result = await client.callTool({ name: 'task_probe', arguments: {} });
  return result.structuredContent as Record<string, number>;
}

async function waitForProbeIncrease(
  client: Client,
  field: 'cancellations' | 'timeouts',
  baseline: number,
  timeoutMs = 5_000,
): Promise<Record<string, number>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await readProbe(client);
    if ((probe[field] ?? 0) > baseline) return probe;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Probe field ${field} did not increase within ${timeoutMs}ms`);
}

async function waitForTaskEviction(client: Client, taskId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.experimental.tasks.getTask(taskId);
    } catch (error) {
      return error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Task ${taskId} was not evicted within ${timeoutMs}ms`);
}

async function listAllTasks(client: Client): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.experimental.tasks.listTasks(cursor);
    tasks.push(...page.tasks);
    cursor = page.nextCursor;
  } while (cursor);
  return tasks;
}

describe.each<TransportKind>(['stdio', 'http'])('Tasks protocol over %s', (kind) => {
  let harness: Harness;
  let closed = false;

  beforeAll(async () => {
    harness = await createHarness(kind);
  });

  afterAll(async () => {
    if (!closed) await harness?.close();
  });

  it('truthfully advertises task capabilities and tool execution metadata', async () => {
    expect(harness.client.getServerCapabilities()?.tasks).toEqual({
      cancel: {},
      list: {},
      requests: { tools: { call: {} } },
    });

    const listed = await harness.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('auto_echo')?.execution).toEqual({ taskSupport: 'optional' });
    expect(byName.get('delayed_echo')?.execution).toEqual({ taskSupport: 'optional' });
    expect(byName.get('long_control')?.execution).toEqual({ taskSupport: 'optional' });
    expect(byName.get('task_probe')?.execution).toEqual({ taskSupport: 'forbidden' });
  });

  it('streams creation, working/completed status, and structured final output via callToolStream', async () => {
    const messages = await collectTaskStream(harness.client, 'delayed_echo', {
      delayMs: 100,
      value: `${kind}-stream`,
    });
    const created = messages.find((message) => message.type === 'taskCreated');
    const statuses = messages.filter((message) => message.type === 'taskStatus');
    const result = messages.find((message) => message.type === 'result');

    expect(created?.type).toBe('taskCreated');
    if (created?.type !== 'taskCreated') throw new Error('taskCreated message missing');
    expect(created.task.ttl).toBe(TASK_TTL_MS);
    expect(statuses.some((message) => message.task.status === 'working')).toBe(true);
    expect(statuses.at(-1)?.task.status).toBe('completed');
    expect(result?.type === 'result' ? result.result.structuredContent : undefined).toEqual({
      echoed: `${kind}-stream`,
    });

    const directStatus = await harness.client.experimental.tasks.getTask(created.task.taskId);
    const directResult = await harness.client.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    );
    expect(directStatus.status).toBe('completed');
    expect(directResult.structuredContent).toEqual({ echoed: `${kind}-stream` });
  });

  it('preserves the task failure envelope for direct result retrieval', async () => {
    const messages = await collectTaskStream(harness.client, 'auto_echo', {
      fail: true,
      value: `${kind}-failure`,
    });
    const created = messages.find((message) => message.type === 'taskCreated');
    expect(created?.type).toBe('taskCreated');
    if (created?.type !== 'taskCreated') throw new Error('taskCreated message missing');
    expect(messages.at(-1)?.type).toBe('error');

    const failed = await harness.client.experimental.tasks.getTask(created.task.taskId);
    const envelope = await harness.client.experimental.tasks.getTaskResult(
      created.task.taskId,
      CallToolResultSchema,
    );
    expect(failed.status).toBe('failed');
    expect(envelope.isError).toBe(true);
    expect(envelope.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(`intentional task failure: ${kind}-failure`),
    });
    expect(envelope.structuredContent).toMatchObject({
      error: { code: expect.any(Number), message: expect.any(String) },
    });
  });

  it('lists tasks through every official pagination cursor without duplicates', async () => {
    const createdIds = new Set<string>();
    for (let index = 0; index < 11; index += 1) {
      const task = await createTaskOnly(harness.client, 'auto_echo', {
        value: `${kind}-page-${index}`,
      });
      createdIds.add(task.taskId);
    }

    const listedIds: string[] = [];
    let cursor: string | undefined;
    let sawCursor = false;
    do {
      const page = await harness.client.experimental.tasks.listTasks(cursor);
      expect(page.tasks.length).toBeLessThanOrEqual(10);
      listedIds.push(...page.tasks.map((task) => task.taskId));
      cursor = page.nextCursor;
      sawCursor ||= cursor !== undefined;
    } while (cursor);

    expect(sawCursor).toBe(true);
    expect(new Set(listedIds).size).toBe(listedIds.length);
    expect([...createdIds].every((taskId) => listedIds.includes(taskId))).toBe(true);
  });

  if (kind === 'http') {
    it('isolates task status, result, and list access by stateful HTTP session', async () => {
      const ownerTask = await createTaskOnly(harness.client, 'auto_echo', {
        value: 'owner-session',
      });
      const { client: otherClient } = await connectHttpClient(harness.httpHandle?.port as number);
      try {
        const otherTask = await createTaskOnly(otherClient, 'auto_echo', {
          value: 'other-session',
        });
        const otherList = await listAllTasks(otherClient);
        expect(otherList.map((task) => task.taskId)).toContain(otherTask.taskId);
        expect(otherList.map((task) => task.taskId)).not.toContain(ownerTask.taskId);
        await expect(
          otherClient.experimental.tasks.getTask(ownerTask.taskId),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
        });
        await expect(
          otherClient.experimental.tasks.getTaskResult(ownerTask.taskId, CallToolResultSchema),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
        await expect(
          harness.client.experimental.tasks.getTask(otherTask.taskId),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
      } finally {
        await otherClient.close();
      }
    });

    it('restores task ownership on reconnect and rejects a terminated session', async () => {
      const port = harness.httpHandle?.port as number;
      const first = await connectHttpClient(port);
      const task = await createTaskOnly(first.client, 'auto_echo', { value: 'reconnect' });
      const sessionId = first.transport.sessionId;
      expect(sessionId).toBeTruthy();
      await first.client.close();

      const reconnected = await connectHttpClient(port, sessionId);
      await expect(
        reconnected.client.experimental.tasks.getTask(task.taskId),
      ).resolves.toMatchObject({
        taskId: task.taskId,
      });
      await expect(reconnected.transport.terminateSession()).resolves.toBeUndefined();
      await expect(
        reconnected.client.experimental.tasks.getTask(task.taskId),
      ).rejects.toBeDefined();
      await reconnected.client.close().catch(() => undefined);
    });
  }

  it('propagates client cancellation into the long-running handler signal', async () => {
    const before = await readProbe(harness.client);
    const task = await createTaskOnly(harness.client, 'long_control', { mode: 'cancel' });
    const cancelled = await harness.client.experimental.tasks.cancelTask(task.taskId);
    expect(cancelled.status).toBe('cancelled');
    expect((await harness.client.experimental.tasks.getTask(task.taskId)).status).toBe('cancelled');

    const after = await waitForProbeIncrease(
      harness.client,
      'cancellations',
      before.cancellations ?? 0,
    );
    expect(after.cancellations).toBe((before.cancellations ?? 0) + 1);
    expect(after.activeLongTasks).toBe(0);
  });

  it('aborts timed-out handlers and evicts completed and timed-out task state at TTL', async () => {
    const completed = await createTaskOnly(harness.client, 'auto_echo', { value: 'ttl-complete' });
    await waitForTaskStatus(harness.client, completed.taskId, 'completed');
    const completedEviction = await waitForTaskEviction(harness.client, completed.taskId);
    expect(completedEviction).toMatchObject({ code: ErrorCode.InvalidParams });

    const before = await readProbe(harness.client);
    const timedOut = await createTaskOnly(harness.client, 'long_control', { mode: 'timeout' });
    const after = await waitForProbeIncrease(harness.client, 'timeouts', before.timeouts ?? 0);
    expect(after.timeouts).toBe((before.timeouts ?? 0) + 1);
    expect(after.activeLongTasks).toBe(0);
    const timedOutEviction = await waitForTaskEviction(harness.client, timedOut.taskId);
    expect(timedOutEviction).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('resolves close() cleanly for the client and subprocess', async () => {
    await expect(harness.close()).resolves.toBeUndefined();
    closed = true;
  });
});
