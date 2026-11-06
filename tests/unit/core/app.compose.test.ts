/**
 * @fileoverview `composeServices` against the real config module and real
 * registries: the `createApp` name/version overrides beating the environment,
 * the `input` option reaching the argument pre-validation a live client call
 * runs through, the `decodeResourceParams` option reaching the read path, and
 * the one server description every surface reports. Each case connects a real
 * `Client` over an in-memory pair, so what is asserted is what a client and the
 * server card would see.
 * @module tests/unit/core/app.compose.test
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resetAppRootCache } from '@/config/appRoot.js';
import { config, resetConfig } from '@/config/index.js';
import { type CreateAppOptions, composeServices } from '@/core/app.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import frameworkPackage from '../../../package.json' with { type: 'json' };
import { initializeBody, MCP_HEADERS } from '../../helpers/http-helpers.js';

const originalEnv = { ...process.env };

/** Teardown for every client/server pair and rate limiter a case opened. */
const cleanups: Array<() => Promise<void> | void> = [];

/** Composes services and connects a 2025-era client to one server instance. */
async function composeAndConnect(options: CreateAppOptions = {}) {
  const composed = await composeServices(options);
  cleanups.push(() => composed.coreServices.rateLimiter.dispose());
  const server = await composed.createServer({ era: 'legacy' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'compose-test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, createServer: composed.createServer, manifest: composed.manifest };
}

const search = tool('compose_search', {
  description: 'Searches.',
  input: z.object({
    query: z.string().describe('Search query.'),
    maxResults: z.number().optional().describe('Maximum results.'),
  }),
  output: z.object({ query: z.string().describe('The query that ran.') }),
  handler: (input) => ({ query: input.query }),
});

describe('composeServices with the real config', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MCP_TRANSPORT_TYPE = 'stdio';
    resetConfig();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    process.env = { ...originalEnv };
    resetConfig();
  });

  describe('identity precedence', () => {
    it('lets the createApp name and version win over MCP_SERVER_NAME and MCP_SERVER_VERSION', async () => {
      process.env.MCP_SERVER_NAME = 'env-named-server';
      process.env.MCP_SERVER_VERSION = '9.9.9-env';
      resetConfig();

      const { client, manifest } = await composeAndConnect({
        name: 'option-named-server',
        version: '1.2.3-option',
      });

      expect(config.mcpServerName).toBe('option-named-server');
      expect(config.mcpServerVersion).toBe('1.2.3-option');
      expect(manifest.server).toMatchObject({
        name: 'option-named-server',
        version: '1.2.3-option',
      });
      expect(client.getServerVersion()).toMatchObject({
        name: 'option-named-server',
        version: '1.2.3-option',
      });
    });
  });

  describe('input option', () => {
    /** Calls the search tool with a snake_case spelling of a declared camelCase key. */
    const callWithSnakeCaseKey = (client: Client) =>
      client.callTool({ name: 'compose_search', arguments: { query: 'x', max_results: 5 } });

    it('rewrites a case-style variant of a declared key when nothing is configured', async () => {
      const { client } = await composeAndConnect({ tools: [search] });

      const result = await callWithSnakeCaseKey(client);

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ query: 'x' });
    });

    it('reaches the call path, so caseStyleAliases: false rejects that variant by name', async () => {
      const { client } = await composeAndConnect({
        tools: [search],
        input: { caseStyleAliases: false },
      });

      const result = await callWithSnakeCaseKey(client);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain(
        'Unrecognized key: \\"max_results\\"',
      );
    });
  });

  describe('decodeResourceParams option', () => {
    /** Values each completion call handed the `id` callback. */
    const completed: string[] = [];

    const section = resource('statute://section/{id}', {
      name: 'compose-section',
      description: 'Reads a statute section.',
      params: z.object({ id: z.string().describe('Section identifier.') }),
      handler: (params) => ({ id: params.id }),
      complete: {
        id: (value) => {
          completed.push(value);
          return [value];
        },
      },
    });

    /** The `id` the handler received for a read of `§ 141.61`, sent encoded. */
    async function readSectionId(client: Client): Promise<unknown> {
      const result = await client.readResource({ uri: 'statute://section/%C2%A7%20141.61' });
      return JSON.parse((result.contents[0] as { text: string }).text).id;
    }

    it('hands the handler the raw capture when unset', async () => {
      const { client } = await composeAndConnect({ resources: [section] });

      expect(await readSectionId(client)).toBe('%C2%A7%20141.61');
    });

    it('reaches the read path, so decodeResourceParams: true decodes the capture once', async () => {
      const { client } = await composeAndConnect({
        resources: [section],
        decodeResourceParams: true,
      });

      expect(await readSectionId(client)).toBe('§ 141.61');
    });

    it('leaves completion arguments as the client sent them', async () => {
      completed.length = 0;
      const { client } = await composeAndConnect({
        resources: [section],
        decodeResourceParams: true,
      });

      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'statute://section/{id}' },
        argument: { name: 'id', value: '%C2%A7 1' },
      });

      expect(completed).toEqual(['%C2%A7 1']);
      expect(result.completion.values).toEqual(['%C2%A7 1']);
    });
  });

  describe('server description', () => {
    const originalArgv1 = process.argv[1] ?? '';
    let appRoot: string;

    /** Makes a fresh package holding `manifest` the application root. */
    function serveFrom(manifest: Record<string, unknown>): void {
      writeFileSync(join(appRoot, 'package.json'), JSON.stringify(manifest));
      mkdirSync(join(appRoot, 'dist'));
      process.argv[1] = join(appRoot, 'dist', 'index.js');
      writeFileSync(process.argv[1], '');
      resetAppRootCache();
      resetConfig();
    }

    /** Parses a JSON-RPC response sent as JSON or as one SSE `data:` frame. */
    async function rpcResult(response: Response): Promise<Record<string, any>> {
      const text = await response.text();
      const data = response.headers.get('content-type')?.includes('text/event-stream')
        ? text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6)
        : text;
      return (JSON.parse(data ?? '{}') as { result: Record<string, any> }).result;
    }

    /** The description each surface reports for one app composed with `options`. */
    async function describedAs(options: CreateAppOptions = {}) {
      // `client` is connected to the instance a stdio transport connects.
      const { client, createServer, manifest } = await composeAndConnect(options);

      const { app, close } = await createHttpApp(
        createServer,
        { requestId: 'compose-test', timestamp: new Date().toISOString() },
        manifest,
      );
      cleanups.push(close);
      const initialize = await rpcResult(
        await app.request('http://localhost/mcp', {
          method: 'POST',
          headers: MCP_HEADERS,
          body: initializeBody(),
        }),
      );
      const card = (await (await app.request('http://localhost/.well-known/mcp.json')).json()) as {
        server_description?: string;
      };
      const status = (await (await app.request('http://localhost/mcp')).json()) as {
        server: { description?: string };
      };

      return {
        stdioInitialize: client.getServerVersion()?.description,
        httpInitialize: initialize.serverInfo?.description as string | undefined,
        card: card.server_description,
        status: status.server.description,
        landing: await (await app.request('http://localhost/')).text(),
      };
    }

    beforeEach(() => {
      appRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-compose-description-')));
      process.env.MCP_AUTH_MODE = 'none';
      process.env.MCP_SESSION_MODE = 'stateless';
      delete process.env.MCP_SERVER_DESCRIPTION;
      delete process.env.PACKAGE_DESCRIPTION;
    });

    afterEach(() => {
      process.argv[1] = originalArgv1;
      resetAppRootCache();
      rmSync(appRoot, { force: true, recursive: true });
    });

    it.each([
      ['the createApp option', 'Option description', 'Option description'],
      ['MCP_SERVER_DESCRIPTION', undefined, 'Env description'],
      ['package.json', undefined, 'Package description'],
    ])('reports the description from %s on every surface', async (source, option, expected) => {
      serveFrom({ name: 'probe-pkg', version: '9.9.9', description: 'Package description' });
      if (source !== 'package.json') process.env.MCP_SERVER_DESCRIPTION = 'Env description';
      resetConfig();

      const surfaces = await describedAs(option === undefined ? {} : { description: option });

      expect(surfaces).toMatchObject({
        stdioInitialize: expected,
        httpInitialize: expected,
        card: expected,
        status: expected,
      });
      expect(surfaces.landing).toContain(`<meta name="description" content="${expected}" />`);
    });

    it('reports no description on any surface when no source has one', async () => {
      serveFrom({ name: 'probe-nodesc', version: '8.8.8' });

      const surfaces = await describedAs();

      expect(config.mcpServerDescription).toBeUndefined();
      expect(surfaces).toMatchObject({
        stdioInitialize: undefined,
        httpInitialize: undefined,
        card: undefined,
        status: undefined,
      });
      expect(surfaces.landing).toContain(
        '<meta name="description" content="MCP server: probe-nodesc" />',
      );
      expect(surfaces.landing).not.toContain(frameworkPackage.description);
    });
  });
});
