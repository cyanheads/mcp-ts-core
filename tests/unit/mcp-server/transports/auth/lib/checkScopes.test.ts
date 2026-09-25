/**
 * @fileoverview Unit tests for dynamic scope checking.
 * @module tests/mcp-server/transports/auth/lib/checkScopes.test
 */

import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode } from '@/types-global/errors.js';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    mcpAuthMode: 'none' as string,
    mcpAuthDisableScopeChecks: false,
  },
}));
vi.mock('@/config/index.js', () => ({ config: mockConfig }));

const { createMockContext } = await import('@/testing/index.js');

const { checkScopes } = await import('@/mcp-server/transports/auth/lib/checkScopes.js');

describe('checkScopes', () => {
  it('no-ops when auth is disabled', () => {
    mockConfig.mcpAuthMode = 'none';
    mockConfig.mcpAuthDisableScopeChecks = false;

    const ctx = createMockContext();

    expect(() => checkScopes(ctx as never, ['tool:read'])).not.toThrow();
  });

  it('throws Unauthorized when auth is enabled but no auth context exists', () => {
    mockConfig.mcpAuthMode = 'jwt';
    mockConfig.mcpAuthDisableScopeChecks = false;

    const ctx = createMockContext();

    let error: unknown;
    try {
      checkScopes(ctx as never, ['tool:read']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      message: 'Authentication required but no auth context was established.',
    });
  });

  it('passes when all required scopes are granted', () => {
    mockConfig.mcpAuthMode = 'oauth';
    mockConfig.mcpAuthDisableScopeChecks = false;

    const ctx = createMockContext({
      auth: {
        clientId: 'test-client',
        scopes: ['tool:read', 'tool:write'],
        sub: 'user-1',
        token: 'token-1',
      },
    });

    expect(() => checkScopes(ctx as never, ['tool:read', 'tool:write'])).not.toThrow();
    expect((ctx.log as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('logs the missing scopes server-side and throws Forbidden without leaking scope data', () => {
    mockConfig.mcpAuthMode = 'jwt';
    mockConfig.mcpAuthDisableScopeChecks = false;

    const ctx = createMockContext({
      auth: {
        clientId: 'test-client',
        scopes: ['tool:read'],
        sub: 'user-1',
        token: 'token-1',
      },
    });

    let error: unknown;
    try {
      checkScopes(ctx as never, ['tool:read', 'tool:write']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message: 'Insufficient permissions.',
      data: undefined,
    });
    expect(
      (ctx.log as unknown as { calls: Array<{ level: string; msg: string; data?: unknown }> })
        .calls,
    ).toContainEqual({
      level: 'warning',
      msg: 'Authorization failed: missing required scopes.',
      data: {
        missingScopes: ['tool:write'],
        requiredScopes: ['tool:read', 'tool:write'],
      },
    });
  });

  describe('when MCP_AUTH_DISABLE_SCOPE_CHECKS=true', () => {
    it('still throws Unauthorized when ctx.auth is absent (jwt mode)', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = true;

      const ctx = createMockContext();

      let error: unknown;
      try {
        checkScopes(ctx as never, ['tool:read']);
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        message: 'Authentication required but no auth context was established.',
      });
    });

    it('bypasses runtime-computed scopes under jwt mode when ctx.auth is present', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = true;

      const ctx = createMockContext({
        auth: {
          clientId: 'test-client',
          scopes: ['openid', 'email'],
          sub: 'user-1',
          token: 'token-1',
        },
      });

      expect(() => checkScopes(ctx as never, ['team:foo:write'])).not.toThrow();
      expect((ctx.log as unknown as { calls: unknown[] }).calls).toHaveLength(0);
    });

    it('does not affect MCP_AUTH_MODE=none behavior', () => {
      mockConfig.mcpAuthMode = 'none';
      mockConfig.mcpAuthDisableScopeChecks = true;

      const ctx = createMockContext();

      expect(() => checkScopes(ctx as never, ['tool:read'])).not.toThrow();
    });
  });
});
