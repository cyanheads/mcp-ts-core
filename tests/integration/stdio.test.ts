/**
 * @fileoverview Integration tests for the stdio transport. Spawns a real server
 * subprocess and drives it via the official MCP SDK client over stdio pipes.
 * @module tests/integration/stdio
 */
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  expectDefaultServerCapabilities,
  expectDefaultServerDiscoverySurface,
  expectDefaultServerLoggingSurface,
  expectDefaultServerProtocolErrors,
  expectDefaultServerSubscriptionSurface,
} from '../helpers/default-server-mcp.js';

const DIST_INDEX = resolve(process.cwd(), 'dist/index.js');

describe('Stdio transport integration', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX],
      env: {
        ...process.env,
        MCP_LOG_LEVEL: 'error',
        MCP_TRANSPORT_TYPE: 'stdio',
      },
    });

    client = new Client({ name: 'stdio-integration', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // Client may already be closed or process exited
    }
  });

  it('completes the MCP handshake and reports server info', () => {
    const version = client.getServerVersion();
    expect(version).toBeDefined();
    expect(version?.name).toBeTruthy();
  });

  it('responds to ping', async () => {
    // Core server has no tools — just verify the transport is functional
    const result = await client.ping();
    expect(result).toBeDefined();
  });

  it('advertises the expected MCP capabilities', () => {
    expectDefaultServerCapabilities(client);
  });

  it('returns empty tool, resource, and prompt lists for the default server', async () => {
    await expectDefaultServerDiscoverySurface(client);
  });

  it('returns MCP not-found behavior for missing tools, resources, and prompts', async () => {
    await expectDefaultServerProtocolErrors(client);
  });

  it('resolves logging and resource-subscription operations', async () => {
    await expectDefaultServerLoggingSurface(client);
    await expectDefaultServerSubscriptionSurface(client);
  });

  it('shuts down cleanly without hanging', async () => {
    // Closing should resolve without throwing or timing out.
    // The afterAll hook handles the actual close — this test verifies
    // a second close is also safe (idempotent).
    await expect(client.close()).resolves.toBeUndefined();
  });
});
