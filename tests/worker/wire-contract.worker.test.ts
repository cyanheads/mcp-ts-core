/**
 * @fileoverview Modern MCP tool, resource, and prompt wire contracts under workerd.
 * @module tests/worker/wire-contract.worker.test
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../fixtures/worker-runtime.fixture.js';
import { jsonrpc, MCP_HEADERS, parseSseDataFrames } from './wire-helpers.js';

async function request(method: string, params: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request('http://example.com/mcp', {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(typeof (params.name ?? params.uri) === 'string' && {
          'Mcp-Name': String(params.name ?? params.uri),
        }),
      },
      body: jsonrpc(1, method, {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'worker-contract-test',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  expect(response.status, text).toBe(200);
  expect(response.headers.get('Mcp-Session-Id')).toBeNull();
  return text.startsWith('event:') || text.startsWith('data:')
    ? parseSseDataFrames(text)[0]
    : JSON.parse(text);
}

describe('modern wire contracts without initialize', () => {
  it('advertises strict tool arguments and returns matching content', async () => {
    const listed = await request('tools/list');
    expect(listed.result.tools).toContainEqual(
      expect.objectContaining({
        name: 'echo',
        inputSchema: expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          required: ['message'],
        }),
      }),
    );
    const called = await request('tools/call', {
      name: 'echo',
      arguments: { message: 'workerd contract' },
    });
    expect(called.result).toMatchObject({
      structuredContent: { echoed: 'workerd contract' },
      content: [{ type: 'text', text: 'workerd contract' }],
    });
    expect(called.result.isError).not.toBe(true);
  });

  it('rejects unknown arguments before the tool handler runs', async () => {
    const called = await request('tools/call', {
      name: 'echo',
      arguments: { message: 'test', typo: true },
    });
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0].text).toContain('typo');
    // #377: SDK input failures currently omit the framework's structured error envelope.
    expect(called.result.structuredContent).toBeUndefined();
  });

  it('lists and reads a resource through the Worker transport', async () => {
    const listed = await request('resources/list');
    expect(listed.result.resources).toContainEqual(
      expect.objectContaining({ uri: 'worker-runtime://caps', mimeType: 'application/json' }),
    );
    const read = await request('resources/read', { uri: 'worker-runtime://caps' });
    expect(read.result.contents).toHaveLength(1);
    expect(read.result.contents[0]).toMatchObject({
      uri: 'worker-runtime://caps',
      mimeType: 'application/json',
    });
    expect(JSON.parse(read.result.contents[0].text)).toMatchObject({ isWorkerLike: true });
  });

  it('lists and renders required prompt arguments', async () => {
    const listed = await request('prompts/list');
    expect(listed.result.prompts).toContainEqual(
      expect.objectContaining({
        name: 'worker_hello',
        arguments: [{ name: 'name', description: 'Name to greet', required: true }],
      }),
    );
    const rendered = await request('prompts/get', {
      name: 'worker_hello',
      arguments: { name: 'Ada' },
    });
    expect(rendered.result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Hello, Ada!' } },
    ]);
  });
});
