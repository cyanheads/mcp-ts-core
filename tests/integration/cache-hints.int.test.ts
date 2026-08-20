/**
 * @fileoverview Wire coverage for the 2026-07-28 cache hints the framework
 * forwards to the SDK (#359).
 *
 * The hint travels on a symbol-keyed property that never reaches the wire; only
 * the 2026-era codec reads it while filling `ttlMs` / `cacheScope` on a
 * cacheable result. So every assertion here is on a real response: modern-era
 * results are read off an HTTP exchange carrying the `_meta` envelope, and the
 * 2025-era invariant is read off a live client session.
 * @module tests/integration/cache-hints.int.test
 */
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { config } from '@/config/index.js';
import type { CacheHints } from '@/mcp-server/cacheHints.js';
import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import {
  type AnyResourceDefinition,
  resource,
} from '@/mcp-server/resources/utils/resourceDefinition.js';
import { createMcpServerInstance } from '@/mcp-server/server.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { defaultServerManifest } from '../helpers/fixtures.js';

/** The conservative values the SDK emits when nothing configures a hint. */
const SDK_DEFAULTS = { ttlMs: 0, cacheScope: 'private' } as const;

const pingTool = tool('cache_ping', {
  description: 'Returns a constant.',
  input: z.object({}),
  output: z.object({ ok: z.boolean().describe('Always true.') }),
  handler: () => ({ ok: true }),
});

const services = () => ({ logger, storage: new StorageService(new InMemoryProvider()) });

/** A `resources/read` handler that returns the same bytes on every call. */
const docResource = resource('cache://doc', {
  name: 'cache_doc',
  description: 'A cacheable document.',
  output: z.object({ body: z.string().describe('Document body.') }),
  handler: () => ({ body: 'stable' }),
});

/** Declares a complete hint of its own. */
const cachedDoc = resource('cache://cached', {
  name: 'cache_cached_doc',
  description: 'A document that declares its own cache lifetime.',
  cacheHint: { ttlMs: 300_000, cacheScope: 'public' },
  output: z.object({ body: z.string().describe('Document body.') }),
  handler: () => ({ body: 'cached' }),
});

/** Declares only a scope, leaving `ttlMs` to fall back. */
const scopeOnlyDoc = resource('cache://scope-only', {
  name: 'cache_scope_only_doc',
  description: 'A document that declares a scope but no lifetime.',
  cacheHint: { cacheScope: 'public' },
  output: z.object({ body: z.string().describe('Document body.') }),
  handler: () => ({ body: 'scope-only' }),
});

/** A templated URI — a separate SDK registration branch from a static one. */
const templatedDoc = resource('cache://item/{itemId}', {
  name: 'cache_item',
  description: 'A cacheable item addressed by ID.',
  cacheHint: { ttlMs: 120_000, cacheScope: 'public' },
  params: z.object({ itemId: z.string().describe('Item identifier.') }),
  output: z.object({ id: z.string().describe('Item identifier.') }),
  handler: (params) => ({ id: params.itemId }),
});

const LEGACY_ENDPOINT = 'http://localhost/mcp';
const LEGACY_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;

function modernRequest(method: string, params: Record<string, unknown> = {}): Request {
  // The modern era validates the headers against the body, so a request that
  // names a target in `params` must repeat it in `Mcp-Name`.
  const name = typeof params.uri === 'string' ? params.uri : undefined;
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
      'Mcp-Method': method,
      ...(name && { 'Mcp-Name': name }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
          'io.modelcontextprotocol/clientInfo': { name: 'cache-hints-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

/** Extracts the single JSON-RPC result from a JSON or SSE response body. */
function resultOf(body: string): Record<string, unknown> {
  const payload = body.startsWith('event:') || body.startsWith('data:') ? sseData(body) : body;
  const message = JSON.parse(payload) as { error?: unknown; result?: Record<string, unknown> };
  if (!message.result) throw new Error(`No result in response: ${body}`);
  return message.result;
}

function sseData(body: string): string {
  const line = body
    .split('\n')
    .find((candidate) => candidate.startsWith('data:') && candidate.includes('"result"'));
  if (!line) throw new Error(`No data frame in SSE body: ${body}`);
  return line.slice(5).trim();
}

interface AppOptions {
  cacheHints?: CacheHints;
  resources?: AnyResourceDefinition[];
}

describe('2026-07-28 cache hints (#359)', () => {
  const teardown: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (teardown.length) await teardown.pop()?.();
  });

  /** Builds a modern-era HTTP app over the framework's own server factory. */
  async function modernApp({ cacheHints, resources = [docResource] }: AppOptions = {}) {
    const factory = async (requestContext: McpRequestContext) =>
      await createMcpServerInstance({
        config,
        era: requestContext.era,
        ...(cacheHints && { cacheHints }),
        promptRegistry: new PromptRegistry([], logger),
        resourceRegistry: new ResourceRegistry(resources, services()),
        toolRegistry: new ToolRegistry([pingTool as AnyToolDefinition], services()),
      });

    const { app, close } = await createHttpApp(
      factory,
      requestContextService.createRequestContext({ operation: 'cache-hints' }),
      defaultServerManifest,
    );
    teardown.push(close);
    return app;
  }

  describe('per-operation hints on createApp', () => {
    it('leaves every cacheable result on the SDK defaults when nothing is configured', async () => {
      const app = await modernApp();

      const list = resultOf(await (await app.request(modernRequest('tools/list'))).text());
      const read = resultOf(
        await (await app.request(modernRequest('resources/read', { uri: 'cache://doc' }))).text(),
      );

      expect(list).toMatchObject(SDK_DEFAULTS);
      expect(read).toMatchObject(SDK_DEFAULTS);
    });

    it("carries a configured hint onto that operation's result", async () => {
      const app = await modernApp({
        cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } },
      });

      const res = await app.request(modernRequest('tools/list'));
      const result = resultOf(await res.text());

      expect(res.status).toBe(200);
      expect(result).toMatchObject({ ttlMs: 60_000, cacheScope: 'public' });
    });

    it('scopes a hint to its own operation', async () => {
      const app = await modernApp({
        cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } },
      });

      const result = resultOf(await (await app.request(modernRequest('prompts/list'))).text());

      expect(result).toMatchObject(SDK_DEFAULTS);
    });

    it('falls back to the SDK default for a field the hint leaves unset', async () => {
      const app = await modernApp({ cacheHints: { 'tools/list': { ttlMs: 60_000 } } });

      const result = resultOf(await (await app.request(modernRequest('tools/list'))).text());

      expect(result).toMatchObject({ ttlMs: 60_000, cacheScope: 'private' });
    });
  });

  describe('per-resource override on resource()', () => {
    it("applies a resource's own hint to its resources/read result", async () => {
      const app = await modernApp({ resources: [cachedDoc] });

      const res = await app.request(modernRequest('resources/read', { uri: 'cache://cached' }));
      const result = resultOf(await res.text());

      expect(res.status).toBe(200);
      expect(result).toMatchObject({ ttlMs: 300_000, cacheScope: 'public' });
    });

    it('combines the per-resource and per-operation hints field by field', async () => {
      // The resource names only a scope; the operation names only a lifetime.
      // Neither alone is a complete hint, so a result carrying both proves the
      // merge happens per field rather than per hint.
      const app = await modernApp({
        cacheHints: { 'resources/read': { ttlMs: 30_000 } },
        resources: [scopeOnlyDoc],
      });

      const result = resultOf(
        await (
          await app.request(modernRequest('resources/read', { uri: 'cache://scope-only' }))
        ).text(),
      );

      expect(result).toMatchObject({ ttlMs: 30_000, cacheScope: 'public' });
    });

    it('falls a hintless resource all the way back to the per-operation hint', async () => {
      const app = await modernApp({
        cacheHints: { 'resources/read': { ttlMs: 30_000, cacheScope: 'public' } },
        resources: [docResource, cachedDoc],
      });

      const plain = resultOf(
        await (await app.request(modernRequest('resources/read', { uri: 'cache://doc' }))).text(),
      );
      // Its neighbour's override must not follow it down the fallback chain.
      const overridden = resultOf(
        await (
          await app.request(modernRequest('resources/read', { uri: 'cache://cached' }))
        ).text(),
      );

      expect(plain).toMatchObject({ ttlMs: 30_000, cacheScope: 'public' });
      expect(overridden).toMatchObject({ ttlMs: 300_000, cacheScope: 'public' });
    });

    it('applies the hint on a templated resource too', async () => {
      // Templated and static URIs take separate SDK registration branches.
      const app = await modernApp({ resources: [templatedDoc] });

      const result = resultOf(
        await (
          await app.request(modernRequest('resources/read', { uri: 'cache://item/42' }))
        ).text(),
      );

      expect(result).toMatchObject({ ttlMs: 120_000, cacheScope: 'public' });
    });
  });

  describe('2025-era responses', () => {
    /**
     * Serves one legacy request over a sessionful HTTP exchange and returns the
     * raw body, with the SSE frame's resumability cursor normalized — it is
     * derived from the session's random UUID, so it differs run to run whatever
     * the cache configuration is.
     */
    async function legacyBody(cacheHints: CacheHints | undefined, request: object) {
      const app = await modernApp({ ...(cacheHints && { cacheHints }), resources: [cachedDoc] });
      const init = await app.request(LEGACY_ENDPOINT, {
        method: 'POST',
        headers: LEGACY_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'cache-hints-legacy', version: '1.0.0' },
          },
        }),
      });
      await init.text();
      const sessionId = init.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const res = await app.request(LEGACY_ENDPOINT, {
        method: 'POST',
        headers: { ...LEGACY_HEADERS, 'mcp-session-id': sessionId as string },
        body: JSON.stringify(request),
      });
      return (await res.text()).replace(/^id: .*$/m, 'id: <event-id>');
    }

    const HINTS: CacheHints = {
      'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
      'resources/read': { ttlMs: 30_000, cacheScope: 'public' },
    };

    it.each([
      ['tools/list', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }],
      [
        'resources/read',
        { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'cache://cached' } },
      ],
    ])('serves %s byte-identically with and without hints configured', async (_label, request) => {
      const without = await legacyBody(undefined, request);
      const withHints = await legacyBody(HINTS, request);

      expect(withHints).toBe(without);
      expect(withHints).not.toContain('ttlMs');
      expect(withHints).not.toContain('cacheScope');
    });
  });
});
