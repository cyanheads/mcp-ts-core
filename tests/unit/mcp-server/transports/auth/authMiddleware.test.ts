/**
 * @fileoverview Tests for authentication middleware.
 * @module tests/mcp-server/transports/auth/authMiddleware.test.ts
 */

import type { Context, Next } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthMiddleware } from '@/mcp-server/transports/auth/authMiddleware.js';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import type { AuthStrategy } from '@/mcp-server/transports/auth/strategies/authStrategy.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

describe('Auth Middleware', () => {
  let mockStrategy: AuthStrategy;
  let mockContext: Context;
  let mockNext: Next;

  beforeEach(() => {
    // Create mock authentication strategy
    mockStrategy = {
      verify: vi.fn(
        async (token: string): Promise<AuthInfo> => ({
          token,
          clientId: 'test-client',
          subject: 'test-user',
          scopes: ['read', 'write'],
          tenantId: 'test-tenant',
        }),
      ),
    };

    // Create mock Hono context
    mockContext = {
      req: {
        header: vi.fn((name?: string) => {
          if (name === 'Authorization') {
            return 'Bearer valid-token';
          }
          if (name === undefined) {
            return { Authorization: 'Bearer valid-token' };
          }
          return;
        }) as any,
        method: 'POST',
        path: '/mcp',
      },
    } as unknown as Context;

    // Create mock next function
    mockNext = vi.fn(async () => {});
  });

  describe('createAuthMiddleware', () => {
    it('should successfully authenticate with valid Bearer token', async () => {
      const middleware = createAuthMiddleware(mockStrategy);

      await middleware(mockContext, mockNext);

      expect(mockStrategy.verify).toHaveBeenCalledTimes(1);
      expect(mockStrategy.verify).toHaveBeenCalledWith('valid-token');
      expect(mockNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('Authorization Header Validation', () => {
    it('should reject missing Authorization header', async () => {
      mockContext.req.header = vi.fn((name?: string) => {
        if (name === undefined) {
          return {};
        }
        return;
      }) as any;

      const middleware = createAuthMiddleware(mockStrategy);

      await expect(middleware(mockContext, mockNext)).rejects.toThrow(McpError);
      await expect(middleware(mockContext, mockNext)).rejects.toThrow(
        'Missing or invalid Authorization header',
      );

      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject Authorization header without Bearer scheme', async () => {
      mockContext.req.header = vi.fn((name?: string) => {
        if (name === 'Authorization') {
          return 'Basic dGVzdDp0ZXN0';
        }
        if (name === undefined) {
          return { Authorization: 'Basic dGVzdDp0ZXN0' };
        }
        return;
      }) as any;

      const middleware = createAuthMiddleware(mockStrategy);

      await expect(middleware(mockContext, mockNext)).rejects.toThrow(McpError);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject empty Bearer token', async () => {
      mockContext.req.header = vi.fn((name?: string) => {
        if (name === 'Authorization') {
          return 'Bearer ';
        }
        if (name === undefined) {
          return { Authorization: 'Bearer ' };
        }
        return;
      }) as any;

      const middleware = createAuthMiddleware(mockStrategy);

      await expect(middleware(mockContext, mockNext)).rejects.toThrow(McpError);
      await expect(middleware(mockContext, mockNext)).rejects.toThrow('token is missing');
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Token Verification', () => {
    it('should handle verification failure', async () => {
      mockStrategy.verify = vi.fn(async () => {
        throw new McpError(JsonRpcErrorCode.Unauthorized, 'Invalid token');
      });

      const middleware = createAuthMiddleware(mockStrategy);

      await expect(middleware(mockContext, mockNext)).rejects.toThrow('Invalid token');
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('AuthInfo Propagation', () => {
    it('runs next inside authContext with the verified authInfo', async () => {
      const authInfo: AuthInfo = {
        token: 'test-token',
        clientId: 'test-client',
        subject: 'test-user',
        scopes: ['read', 'write', 'admin'],
        tenantId: 'tenant-123',
      };
      mockStrategy.verify = vi.fn(async () => authInfo);

      let storeSeenByNext: ReturnType<typeof authContext.getStore>;
      mockNext = vi.fn(async () => {
        storeSeenByNext = authContext.getStore();
      });

      const middleware = createAuthMiddleware(mockStrategy);

      await middleware(mockContext, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(storeSeenByNext).toEqual({ authInfo });
      // The store is scoped to the downstream chain, not leaked to the caller.
      expect(authContext.getStore()).toBeUndefined();
    });
  });
});
