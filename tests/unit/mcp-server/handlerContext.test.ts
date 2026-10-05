/**
 * @fileoverview Tests for the handler-context assembly shared by the tool,
 * resource, and prompt factories: the tenant default `resolveHandlerRequest`
 * derives from parsed config, the `ctx.tenantId` / `ctx.state` it yields
 * through `buildHandlerContext`, and the request context `handlerParentContext`
 * seeds — a generated `requestId` with the client's id as `jsonRpcId`.
 * @module tests/unit/mcp-server/handlerContext.test
 */
import type { RequestId } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfig } from '@/config/index.js';
import {
  buildHandlerContext,
  type HandlerServices,
  handlerParentContext,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';
import { makeServerContext } from '../../helpers/server-context.js';

const JWT = { MCP_AUTH_MODE: 'jwt', MCP_AUTH_SECRET_KEY: 'x'.repeat(32) };
const OAUTH = {
  MCP_AUTH_MODE: 'oauth',
  OAUTH_AUDIENCE: 'test-audience',
  OAUTH_ISSUER_URL: 'https://issuer.example.com',
};

/**
 * The literal `${…}` an install-time host forwards when nothing substitutes it,
 * built without a template-shaped string so Biome's noTemplateCurlyInString stays quiet.
 */
const placeholder = (name: string) => ['$', '{', name, '}'].join('');

const spanContext = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  requestId: 'req-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

/**
 * Exports `env` to `process.env` as a host would forward it, parses config from
 * it, then builds a handler context the way the factories do. `exported: false`
 * parses the same values without exporting them.
 */
function contextUnder(
  env: Record<string, string>,
  { appContext = spanContext(), exported = true } = {},
) {
  if (exported) for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetConfig(env);
  const services: HandlerServices = { logger, storage: new StorageService(new InMemoryProvider()) };
  const request = resolveHandlerRequest(makeServerContext(), services, {});
  return { ctx: buildHandlerContext(request, services, appContext, undefined), request };
}

describe('handler context — tenant default from parsed config', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_TRANSPORT_TYPE', undefined);
    vi.stubEnv('MCP_AUTH_MODE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfig();
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['an unsubstituted env placeholder', placeholder('MCP_AUTH_MODE')],
    ['an unsubstituted user_config placeholder', placeholder('user_config.auth_mode')],
    ['none', 'none'],
  ])(
    'HTTP with MCP_AUTH_MODE %s gets the default tenant and working state',
    async (_label, mode) => {
      const { ctx, request } = contextUnder({ MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: mode });

      expect(request.defaultTenantId).toBe('default');
      expect(ctx.tenantId).toBe('default');
      await ctx.state.set('item/1', { ok: true });
      await expect(ctx.state.get('item/1')).resolves.toEqual({ ok: true });
    },
  );

  it.each([
    ['jwt', JWT],
    ['oauth', OAUTH],
  ])('HTTP with %s and no tid claim fails closed on ctx.state', async (_label, auth) => {
    const { ctx, request } = contextUnder({ MCP_TRANSPORT_TYPE: 'http', ...auth });

    expect(request.defaultTenantId).toBeUndefined();
    expect(ctx.tenantId).toBeUndefined();
    await expect(ctx.state.get('item/1')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
    });
  });

  it('fails closed for HTTP + jwt set through resetConfig overrides alone', () => {
    const { ctx } = contextUnder({ MCP_TRANSPORT_TYPE: 'http', ...JWT }, { exported: false });

    expect(process.env.MCP_TRANSPORT_TYPE).toBeUndefined();
    expect(process.env.MCP_AUTH_MODE).toBeUndefined();
    expect(ctx.tenantId).toBeUndefined();
  });

  it.each([
    ['none', { MCP_AUTH_MODE: 'none' }],
    ['jwt', JWT],
    ['oauth', OAUTH],
  ])('stdio under %s gets the default tenant', async (_label, auth) => {
    const { ctx } = contextUnder({ MCP_TRANSPORT_TYPE: 'stdio', ...auth });

    expect(ctx.tenantId).toBe('default');
    await expect(ctx.state.get('item/1')).resolves.toBeNull();
  });

  it.each([
    ['HTTP + jwt', { MCP_TRANSPORT_TYPE: 'http', ...JWT }],
    ['HTTP + none', { MCP_TRANSPORT_TYPE: 'http', MCP_AUTH_MODE: 'none' }],
    ['stdio', { MCP_TRANSPORT_TYPE: 'stdio' }],
  ])('%s keeps a tenant the auth pipeline supplied', (_label, env) => {
    const { ctx } = contextUnder(env, { appContext: spanContext({ tenantId: 'tenant-a' }) });

    expect(ctx.tenantId).toBe('tenant-a');
  });
});

describe('handlerParentContext — a generated requestId, the client id as jsonRpcId (#584)', () => {
  const TOKEN = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

  /** The request context a factory builds for a call sent with JSON-RPC id `id`. */
  const callContext = (id: RequestId, sessionId?: string) =>
    requestContextService.createRequestContext({
      parentContext: handlerParentContext(
        makeServerContext({ requestId: id, ...(sessionId !== undefined && { sessionId }) }),
      ),
      operation: 'HandleToolRequest',
      additionalContext: { toolName: 'probe' },
    });

  it('generates the requestId for a string id and carries the id as jsonRpcId', () => {
    const context = callContext('client-string-id-19');

    expect(context.requestId).toMatch(TOKEN);
    expect(context.extra).toEqual({ jsonRpcId: 'client-string-id-19', toolName: 'probe' });
  });

  it('never adopts a string id shaped like a generated token', () => {
    const context = callContext('AAAAA-BBBBB');

    expect(context.requestId).toMatch(TOKEN);
    expect(context.requestId).not.toBe('AAAAA-BBBBB');
    expect(context.extra?.jsonRpcId).toBe('AAAAA-BBBBB');
  });

  it('carries a numeric id as a number', () => {
    const context = callContext(10);

    expect(context.requestId).toMatch(TOKEN);
    expect(context.extra?.jsonRpcId).toBe(10);
    expect(context.extra).not.toHaveProperty('jsonRpcIdLength');
  });

  it('gives two calls that send the same id two requestIds', () => {
    const first = callContext('1');
    const second = callContext('1');

    expect(first.requestId).not.toBe(second.requestId);
    expect([first.extra?.jsonRpcId, second.extra?.jsonRpcId]).toEqual(['1', '1']);
  });

  it.each([
    [1_024, false],
    [1_025, true],
    [999_000, true],
  ])('a %i-character string id is cut: %s', (length, cut) => {
    const id = 'q'.repeat(length);

    const { extra } = callContext(id);

    expect(extra?.jsonRpcId).toBe(id.slice(0, 1_024));
    if (cut) expect(extra?.jsonRpcIdLength).toBe(length);
    else expect(extra).not.toHaveProperty('jsonRpcIdLength');
  });

  it('carries the SDK session id', () => {
    expect(callContext(1, 'sess-1').sessionId).toBe('sess-1');
  });

  it('carries nothing for a request with no SDK context', () => {
    expect(handlerParentContext(undefined)).toEqual({});
  });
});
