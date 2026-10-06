/**
 * @fileoverview Builds a fixture server the way `createApp` does and reads what
 * an MCP client receives from it, byte for byte: 2025-era traffic as raw
 * JSON-RPC over an in-memory transport, 2026-07-28 traffic through the HTTP
 * app's `request()`. Never through the SDK `Client`, whose result parsing drops
 * keys the server put on the wire. Also owns the pin files' names and format.
 * @module tests/contract/harness
 */
import { isDeepStrictEqual } from 'node:util';
import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { expect } from 'vitest';

import { config } from '@/config/index.js';
import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { createMcpServerInstance, type McpServerDeps } from '@/mcp-server/server.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import type { InputHandlingOptions } from '@/mcp-server/tools/utils/inputPrevalidation.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { defaultServerManifest } from '../helpers/fixtures.js';

/** Every pin the lane writes. `pins.test.ts` fails on a file in `pins/` not listed here. */
export const PINS = [
  'calls.templates.json5',
  'eras.2026-07-28.json5',
  'eras.calls.2026-07-28.json5',
  'purpose.2025-11-25.json5',
  'templates.2025-11-25.json5',
  'validation.defaults.json5',
  'validation.switches-off.json5',
] as const;

export type PinName = (typeof PINS)[number];

export const PINS_DIR = new URL('./pins/', import.meta.url).pathname;

/** The 2025 revision a current client negotiates; the lists are pinned there. */
export const LATEST_2025_REVISION = '2025-11-25';

/** The four list methods every client calls on connect. */
export const LIST_METHODS = [
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
] as const;

/** The definitions one fixture server registers, plus its `createApp`-level options. */
export interface FixtureSet {
  prompts: AnyPromptDefinition[];
  resources: AnyResourceDefinition[];
  server?: Pick<
    McpServerDeps,
    'cacheHints' | 'description' | 'extensions' | 'icons' | 'instructions' | 'title' | 'websiteUrl'
  >;
  tools: AnyToolDefinition[];
}

/** A JSON-RPC response with `jsonrpc` and `id` dropped. */
export interface WireResponse {
  error?: { code: number; data?: unknown; message: string };
  result?: Record<string, unknown>;
}

/**
 * Fixed identity, so `serverInfo` never moves with the package version and a
 * release does not rewrite every pin.
 */
const fixtureConfig = { ...config, mcpServerName: 'contract-fixture', mcpServerVersion: '0.0.0' };

function buildServer(set: FixtureSet, era: 'legacy' | 'modern', input?: InputHandlingOptions) {
  const services = {
    logger,
    storage: new StorageService(new InMemoryProvider()),
    ...(input && { input }),
  };
  return createMcpServerInstance({
    config: fixtureConfig,
    era,
    ...set.server,
    toolRegistry: new ToolRegistry(set.tools, services),
    resourceRegistry: new ResourceRegistry(set.resources, services),
    promptRegistry: new PromptRegistry(set.prompts, logger),
  });
}

function stripEnvelope(message: unknown): WireResponse {
  const { error, result } = message as WireResponse;
  return { ...(error !== undefined && { error }), ...(result !== undefined && { result }) };
}

export interface LegacySession {
  close(): Promise<void>;
  /** The `initialize` response the session opened with. */
  initialize: WireResponse;
  request(method: string, params?: Record<string, unknown>): Promise<WireResponse>;
}

/** Opens a 2025-era session: `initialize`, `notifications/initialized`, then raw requests. */
export async function openLegacySession(
  set: FixtureSet,
  options: { input?: InputHandlingOptions; protocolVersion?: string } = {},
): Promise<LegacySession> {
  const server = await buildServer(set, 'legacy', options.input);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: unknown) => void>();
  client.onmessage = (message) => {
    const { id, method } = message as { id?: unknown; method?: unknown };
    if (typeof id !== 'number' || method !== undefined) return;
    pending.get(id)?.(message);
    pending.delete(id);
  };
  await server.connect(serverSide);
  await client.start();

  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<WireResponse>((resolve) => {
      const id = nextId++;
      pending.set(id, (message) => resolve(stripEnvelope(message)));
      void client.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });

  const initialize = await request('initialize', {
    protocolVersion: options.protocolVersion ?? LATEST_2025_REVISION,
    capabilities: {},
    clientInfo: { name: 'contract-client', version: '0.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  return { initialize, request, close: () => server.close() };
}

export interface ModernApp {
  close(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<WireResponse>;
}

/** A 2026-07-28 HTTP app over the same factory `createApp` serves with. */
export async function openModernApp(set: FixtureSet): Promise<ModernApp> {
  const { app, close } = await createHttpApp(
    async (requestContext: McpRequestContext) => await buildServer(set, requestContext.era),
    requestContextService.createRequestContext({ operation: 'contract' }),
    defaultServerManifest,
  );

  const request = async (method: string, params: Record<string, unknown> = {}) => {
    // The 2026-07-28 era checks the routing headers against the body.
    const name = typeof params.uri === 'string' ? params.uri : params.name;
    const res = await app.request(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
          'Mcp-Method': method,
          ...(typeof name === 'string' && { 'Mcp-Name': name }),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
              'io.modelcontextprotocol/clientInfo': { name: 'contract-client', version: '0.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );
    const body = await res.text();
    const data = body
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice(5);
    return stripEnvelope(JSON.parse(data ?? body));
  };

  return { request, close };
}

/** A framework-generated request id; differs on every call, so pins carry a placeholder. */
const REQUEST_ID = /\b[A-Z0-9]{5}-[A-Z0-9]{5}\b/g;

/** Replaces every request id, wherever it appears, with a stable placeholder. */
function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(REQUEST_ID, '<requestId>')) as T;
}

/** Sorts object keys recursively; arrays keep their order, which is meaningful. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/** What `toMatchFileSnapshot` compares: normalized, key-sorted, 2-space JSON. */
function serializePin(value: unknown): string {
  return `${JSON.stringify(sortKeys(normalize(value)), null, 2)}\n`;
}

/** Compares `value` against the committed pin; a missing or different file fails. */
export async function expectPin(name: PinName, value: unknown): Promise<void> {
  await expect(serializePin(value)).toMatchFileSnapshot(`${PINS_DIR}${name}`);
}

/**
 * How one response object differs from another, key by key: `{}` when they
 * match. A changed key carries its whole new value.
 */
export interface KeyDelta {
  added?: Record<string, unknown>;
  changed?: Record<string, unknown>;
  removed?: string[];
}

function keyDelta(base: object, next: object): KeyDelta {
  const before = base as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const added = Object.entries(after).filter(([key]) => !(key in before));
  const changed = Object.entries(after).filter(
    ([key, value]) => key in before && !isDeepStrictEqual(before[key], value),
  );
  const removed = Object.keys(before).filter((key) => !(key in after));
  return {
    ...(added.length > 0 && { added: Object.fromEntries(added) }),
    ...(changed.length > 0 && { changed: Object.fromEntries(changed) }),
    ...(removed.length > 0 && { removed }),
  };
}

/** The delta between two responses: of their results when both succeeded, else of the whole. */
export function responseDelta(base: WireResponse, next: WireResponse): KeyDelta {
  const [before, after] = [normalize(base), normalize(next)];
  return before.result && after.result
    ? keyDelta(before.result, after.result)
    : keyDelta(before, after);
}
