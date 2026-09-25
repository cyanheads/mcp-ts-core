/**
 * @fileoverview Wire conformance for MCP Apps: a real fixture server over HTTP,
 * driven by the official SDK client — linked UI metadata in `tools/list`,
 * structured tool output, and the app resource's content-level UI policy.
 * @module tests/integration/mcp-apps.int.test
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_RESOURCE_MIME_TYPE } from '@/mcp-server/apps/appBuilders.js';
import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

describe('MCP Apps — HTTP wire conformance', () => {
  const fixtureEntrypoint = 'tests/fixtures/mcp-app-server.js';
  const resourceUri = 'ui://wire-app/app.html';
  let client: Client;
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startServerFromEntrypoint(fixtureEntrypoint, 'http', {
      MCP_SESSION_MODE: 'stateful',
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.port}/mcp`),
    );
    client = new Client({ name: 'mcp-app-wire-client', version: '1.0.0' });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // Transport may already be closed during failed setup.
    }
    await handle?.kill();
  });

  it('advertises the linked UI resource metadata in tools/list', async () => {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: 'wire_app_search',
      _meta: {
        ui: {
          resourceUri,
          visibility: ['model', 'app'],
        },
        'ui/resourceUri': resourceUri,
      },
    });
  });

  it('returns structured tool output over the official SDK client', async () => {
    const result = await client.callTool({
      name: 'wire_app_search',
      arguments: { query: 'mcp' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ items: ['mcp-one', 'mcp-two'] });
  });

  it('lists and reads the app HTML with content-level UI policy metadata', async () => {
    const listed = await client.listResources();
    expect(listed.resources).toContainEqual(
      expect.objectContaining({
        name: 'wire-app-ui',
        uri: resourceUri,
        mimeType: APP_RESOURCE_MIME_TYPE,
      }),
    );

    const result = await client.readResource({ uri: resourceUri });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: resourceUri,
      mimeType: APP_RESOURCE_MIME_TYPE,
      text: expect.stringContaining('wire-app-sentinel'),
      _meta: {
        ui: {
          csp: { resourceDomains: ['https://cdn.example.test'] },
          permissions: { clipboardWrite: {} },
        },
      },
    });
  });
});
