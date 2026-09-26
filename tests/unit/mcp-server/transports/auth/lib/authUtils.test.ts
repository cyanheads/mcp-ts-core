/**
 * @fileoverview Unit tests for authorization utilities.
 * @module tests/mcp-server/transports/auth/lib/authUtils.test
 */
import { describe, expect, it, vi } from 'vitest';

import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

// Mutable config mock — tests override mcpAuthMode per scenario.
const mockConfig = {
  mcpAuthMode: 'none' as string,
  mcpAuthDisableScopeChecks: false,
};
vi.mock('@/config/index.js', () => ({ config: mockConfig }));

// Must import after vi.mock so the mock is in place.
const { withRequiredScopes } = await import('@/mcp-server/transports/auth/lib/authUtils.js');
const { logger } = await import('@/utils/internal/logger.js');

describe('withRequiredScopes', () => {
  const createAuthInfo = (scopes: string[]): AuthInfo => ({
    token: 'test-token',
    clientId: 'test-client',
    scopes,
    subject: 'user-123',
  });

  describe('when auth is disabled (MCP_AUTH_MODE=none)', () => {
    it('allows execution when no auth context is present', () => {
      mockConfig.mcpAuthMode = 'none';
      mockConfig.mcpAuthDisableScopeChecks = false;
      expect(() => withRequiredScopes(['scope:read'])).not.toThrow();
    });
  });

  describe('when auth is enabled (MCP_AUTH_MODE=jwt)', () => {
    it('throws Unauthorized when no auth context is present', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = false;
      try {
        withRequiredScopes(['scope:read']);
        throw new Error('Expected withRequiredScopes to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
        expect(mcpError.message).toContain('Authentication required');
      }
    });

    // #548 — the -32006 branch returned its whole context as data, including
    // the required scope names the -32005 branch withholds.
    it('returns no scope names or request metadata on Unauthorized; the log keeps them', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = false;
      const warningSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});
      const parentContext = {
        operation: 'HandleToolRequest',
        requestId: 'req-scope-leak',
        timestamp: '2026-09-25T00:00:00.000Z',
        tenantId: 'tenant-1',
      };

      let caught: unknown;
      try {
        withRequiredScopes(['tool:secret_admin:write'], parentContext);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(McpError);
      const mcpError = caught as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(JSON.stringify(mcpError.data ?? {})).not.toContain('tool:secret_admin:write');
      expect(mcpError.data).toBeUndefined();
      expect(warningSpy).toHaveBeenCalledWith(
        'Auth enabled but no authentication context found. Denying request.',
        expect.objectContaining({
          requestId: 'req-scope-leak',
          extra: expect.objectContaining({ requiredScopes: ['tool:secret_admin:write'] }),
        }),
      );
      warningSpy.mockRestore();
    });

    it('passes when the auth context satisfies all required scopes', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = false;
      authContext.run({ authInfo: createAuthInfo(['scope:read', 'scope:write']) }, () => {
        expect(() => withRequiredScopes(['scope:read'])).not.toThrow();
        expect(() => withRequiredScopes(['scope:read', 'scope:write'])).not.toThrow();
      });
    });

    it('passes when a parent request context is provided', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = false;
      const parentContext = {
        operation: 'parentScopeCheck',
        requestId: 'req-parent',
        timestamp: '2026-03-30T00:00:00.000Z',
      } as never;

      authContext.run({ authInfo: createAuthInfo(['scope:read', 'scope:write']) }, () => {
        expect(() => withRequiredScopes(['scope:read'], parentContext)).not.toThrow();
      });
    });

    it('throws Forbidden when a required scope is missing', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = false;
      authContext.run({ authInfo: createAuthInfo(['scope:read']) }, () => {
        try {
          withRequiredScopes(['scope:read', 'scope:write']);
          throw new Error('Expected withRequiredScopes to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(McpError);
          const mcpError = error as McpError;
          expect(mcpError.code).toBe(JsonRpcErrorCode.Forbidden);
          expect(mcpError.message).toBe('Insufficient permissions.');
          // No auth details should leak to client-facing errors (prevents scope enumeration)
          expect(mcpError.data).toBeUndefined();
        }
      });
    });
  });

  describe('when MCP_AUTH_DISABLE_SCOPE_CHECKS=true', () => {
    it('still throws Unauthorized when no auth context is present (jwt mode)', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = true;
      try {
        withRequiredScopes(['tool:foo:read']);
        throw new Error('Expected withRequiredScopes to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
        expect(mcpError.message).toContain('Authentication required');
      }
    });

    it('bypasses missing-scope enforcement under jwt mode when auth context is present', () => {
      mockConfig.mcpAuthMode = 'jwt';
      mockConfig.mcpAuthDisableScopeChecks = true;
      authContext.run({ authInfo: createAuthInfo(['openid', 'email']) }, () => {
        expect(() => withRequiredScopes(['tool:foo:read'])).not.toThrow();
      });
    });

    it('does not affect MCP_AUTH_MODE=none behavior', () => {
      mockConfig.mcpAuthMode = 'none';
      mockConfig.mcpAuthDisableScopeChecks = true;
      expect(() => withRequiredScopes(['tool:foo:read'])).not.toThrow();
    });
  });
});
