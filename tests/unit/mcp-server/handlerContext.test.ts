/**
 * @fileoverview Tests for the handler-context assembly shared by the tool and
 * resource factories: the tenant default `resolveHandlerRequest` derives from
 * parsed config, and the `ctx.tenantId` / `ctx.state` it yields through
 * `buildHandlerContext`.
 * @module tests/unit/mcp-server/handlerContext.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfig } from '@/config/index.js';
import {
  buildHandlerContext,
  type HandlerServices,
  resolveHandlerRequest,
} from '@/mcp-server/handlerContext.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
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
