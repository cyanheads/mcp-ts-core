/**
 * @fileoverview Test suite for OAuth authentication strategy
 * @module tests/mcp-server/transports/auth/strategies/oauthStrategy.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OauthStrategy } from '@/mcp-server/transports/auth/strategies/oauthStrategy.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

// Hoist the mock config object so it can be referenced in vi.mock factories
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    mcpAuthMode: 'oauth' as string,
    oauthIssuerUrl: 'https://example.auth0.com/' as string | undefined,
    oauthAudience: 'https://api.example.com' as string | undefined,
    oauthJwksUri: undefined as string | undefined,
    mcpServerResourceIdentifier: undefined as string | undefined,
    oauthJwksCooldownMs: 300000 as number,
    oauthJwksTimeoutMs: 5000 as number,
  },
}));

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

// Mock the jose module with factory function for Bun compatibility
// Vitest auto-mocks with vi.mock('jose') but Bun requires explicit factory
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

// Import mocked jose to get references to mocked functions
import * as jose from 'jose';

describe('OAuth Strategy', () => {
  let strategy: OauthStrategy;

  const mockJWKS = vi.fn();
  const mockCreateRemoteJWKSet = vi.mocked(jose.createRemoteJWKSet);
  const mockJwtVerify = vi.mocked(jose.jwtVerify);

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock config to defaults before each test
    mockConfig.mcpAuthMode = 'oauth';
    mockConfig.oauthIssuerUrl = 'https://example.auth0.com/';
    mockConfig.oauthAudience = 'https://api.example.com';
    mockConfig.oauthJwksUri = undefined;
    mockConfig.mcpServerResourceIdentifier = undefined;
    mockConfig.oauthJwksCooldownMs = 300000;
    mockConfig.oauthJwksTimeoutMs = 5000;

    // Mock createRemoteJWKSet to return mock JWKS function
    mockCreateRemoteJWKSet.mockReturnValue(mockJWKS as any);
  });

  describe('constructor', () => {
    it('should initialize successfully with valid OAuth config', () => {
      strategy = new OauthStrategy(mockConfig as any, logger);

      expect(strategy).toBeInstanceOf(OauthStrategy);
      expect(mockCreateRemoteJWKSet).toHaveBeenCalled();
    });

    it('should throw error when auth mode is not oauth', () => {
      mockConfig.mcpAuthMode = 'jwt';

      expect(() => new OauthStrategy(mockConfig as any, logger)).toThrow(
        'OauthStrategy instantiated for non-oauth auth mode',
      );
    });

    it('should throw McpError when OAUTH_ISSUER_URL is missing', () => {
      mockConfig.oauthIssuerUrl = undefined;

      expect(() => new OauthStrategy(mockConfig as any, logger)).toThrow(McpError);
      expect(() => new OauthStrategy(mockConfig as any, logger)).toThrow(
        /OAUTH_ISSUER_URL and OAUTH_AUDIENCE must be set/,
      );
    });

    it('should throw McpError when OAUTH_AUDIENCE is missing', () => {
      mockConfig.oauthAudience = undefined;

      expect(() => new OauthStrategy(mockConfig as any, logger)).toThrow(McpError);
      expect(() => new OauthStrategy(mockConfig as any, logger)).toThrow(
        /OAUTH_ISSUER_URL and OAUTH_AUDIENCE must be set/,
      );
    });

    it('should initialize JWKS client with custom JWKS URI', () => {
      mockConfig.oauthJwksUri = 'https://custom.example.com/jwks';

      strategy = new OauthStrategy(mockConfig as any, logger);

      expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
        new URL('https://custom.example.com/jwks'),
        expect.any(Object),
      );
    });

    it('should initialize JWKS client with default well-known path', () => {
      mockConfig.oauthJwksUri = undefined;

      strategy = new OauthStrategy(mockConfig as any, logger);

      expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
        new URL('https://example.auth0.com/.well-known/jwks.json'),
        expect.any(Object),
      );
    });

    it('should pass cooldown and timeout options to createRemoteJWKSet', () => {
      mockConfig.oauthJwksCooldownMs = 5000;
      mockConfig.oauthJwksTimeoutMs = 10000;

      strategy = new OauthStrategy(mockConfig as any, logger);

      expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          cooldownDuration: 5000,
          timeoutDuration: 10000,
        }),
      );
    });

    it('should wrap Error-based JWKS initialization failures as service unavailable', () => {
      expect.assertions(1);
      mockCreateRemoteJWKSet.mockImplementation(() => {
        throw new Error('JWKS bootstrap failed');
      });

      try {
        new OauthStrategy(mockConfig as any, logger);
      } catch (error) {
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Could not initialize JWKS client for OAuth strategy.',
          data: expect.objectContaining({
            originalError: 'JWKS bootstrap failed',
          }),
        });
      }
    });

    it('should wrap non-Error JWKS initialization failures as service unavailable', () => {
      expect.assertions(1);
      mockCreateRemoteJWKSet.mockImplementation(() => {
        throw 'jwks exploded';
      });

      try {
        new OauthStrategy(mockConfig as any, logger);
      } catch (error) {
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'Could not initialize JWKS client for OAuth strategy.',
          data: expect.objectContaining({
            originalError: 'Unknown',
          }),
        });
      }
    });
  });

  describe('verify', () => {
    beforeEach(() => {
      strategy = new OauthStrategy(mockConfig as any, logger);
    });

    it('should verify valid OAuth token with all claims', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'tool:read resource:write',
          sub: 'user-123',
          tid: 'tenant-456',
          iss: 'https://example.auth0.com/',
          aud: 'https://api.example.com',
        },
        protectedHeader: { alg: 'RS256', kid: 'key-1' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('test-token');

      expect(authInfo.clientId).toBe('test-client');
      expect(authInfo.scopes).toEqual(['tool:read', 'resource:write']);
      expect(authInfo.subject).toBe('user-123');
      expect(authInfo.tenantId).toBe('tenant-456');
      expect(authInfo.token).toBe('test-token');
    });

    it('should extract client_id from payload', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'oauth-client-id',
          scope: 'read write',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.clientId).toBe('oauth-client-id');
    });

    it('should extract clientId from cid claim', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          cid: 'okta-client',
          scope: 'read write',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');
      expect(authInfo.clientId).toBe('okta-client');
    });

    it('should extract scopes from space-separated string', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'tool:read tool:write resource:list',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.scopes).toEqual(['tool:read', 'tool:write', 'resource:list']);
    });

    it('should extract scopes from scp array claim', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scp: ['tool:read', 'tool:write'],
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');
      expect(authInfo.scopes).toEqual(['tool:read', 'tool:write']);
    });

    it('should handle optional subject and tenantId', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.subject).toBeUndefined();
      expect(authInfo.tenantId).toBeUndefined();
    });

    it('should populate expiresAt from exp claim', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
          exp: futureExp,
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');
      expect(authInfo.expiresAt).toBe(futureExp);
    });

    it('should validate resource indicator when configured', async () => {
      mockConfig.mcpServerResourceIdentifier = 'https://mcp.example.com';

      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
          resource: 'https://mcp.example.com',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.clientId).toBe('test-client');
    });

    it('should allow token when resource matches in array', async () => {
      mockConfig.mcpServerResourceIdentifier = 'https://mcp.example.com';

      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
          resource: ['https://other.example.com', 'https://mcp.example.com'],
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.clientId).toBe('test-client');
    });

    it('should fall back to the aud claim for resource validation when resource is absent', async () => {
      mockConfig.mcpServerResourceIdentifier = 'https://mcp.example.com';

      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
          aud: 'https://mcp.example.com',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.clientId).toBe('test-client');
    });

    it('should reject token with resource mismatch', async () => {
      mockConfig.mcpServerResourceIdentifier = 'https://mcp.example.com';

      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
          resource: 'https://wrong.example.com',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      await expect(strategy.verify('token')).rejects.toThrow(McpError);
      await expect(strategy.verify('token')).rejects.toThrow(/Resource indicator mismatch/);

      try {
        await strategy.verify('token');
      } catch (error) {
        expect((error as McpError).code).toBe(JsonRpcErrorCode.Forbidden);
      }
    });

    it('should skip resource validation when not configured', async () => {
      mockConfig.mcpServerResourceIdentifier = undefined;

      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
          resource: 'https://any.example.com',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      const authInfo = await strategy.verify('token');

      expect(authInfo.clientId).toBe('test-client');
    });

    it('should throw Unauthorized for missing client_id claim', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          scope: 'read write',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      await expect(strategy.verify('token')).rejects.toThrow(McpError);
      await expect(strategy.verify('token')).rejects.toThrow(/missing 'cid' or 'client_id'/);
    });

    it('should throw Unauthorized for missing scope claim', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      await expect(strategy.verify('token')).rejects.toThrow(McpError);
      await expect(strategy.verify('token')).rejects.toThrow(
        /must contain valid, non-empty scopes/,
      );
    });

    it('should reject empty scope string', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: '',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      await expect(strategy.verify('token')).rejects.toThrow(McpError);
      await expect(strategy.verify('token')).rejects.toThrow(/non-empty scopes/);
    });

    it('should throw Unauthorized for expired token', async () => {
      const expiredError = new Error('Token expired');
      expiredError.name = 'JWTExpired';
      mockJwtVerify.mockRejectedValue(expiredError);

      await expect(strategy.verify('token')).rejects.toThrow(McpError);
      await expect(strategy.verify('token')).rejects.toThrow(/Token has expired/);
    });

    it('should throw Unauthorized for invalid signature', async () => {
      const signatureError = new Error('signature verification failed');
      signatureError.name = 'JWSSignatureVerificationFailed';
      mockJwtVerify.mockRejectedValue(signatureError);

      await expect(strategy.verify('token')).rejects.toThrow(McpError);
    });

    it('should re-throw existing McpError instances', async () => {
      const customMcpError = new McpError(JsonRpcErrorCode.Forbidden, 'Custom error');
      mockJwtVerify.mockRejectedValue(customMcpError);

      await expect(strategy.verify('token')).rejects.toThrow(customMcpError);
    });

    it('should normalize non-Error verification failures', async () => {
      mockJwtVerify.mockRejectedValue('oauth exploded');

      await expect(strategy.verify('token')).rejects.toMatchObject({
        code: JsonRpcErrorCode.Unauthorized,
        message: 'OAuth token verification failed.',
      });
    });

    it('should call jwtVerify with correct parameters', async () => {
      mockJwtVerify.mockResolvedValue({
        payload: {
          client_id: 'test-client',
          scope: 'read',
        },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      await strategy.verify('test-token');

      expect(mockJwtVerify).toHaveBeenCalledWith(
        'test-token',
        mockJWKS,
        expect.objectContaining({
          issuer: 'https://example.auth0.com/',
          audience: 'https://api.example.com',
        }),
      );
    });

    it('restricts verification to asymmetric algorithms (blocks HS256 JWKS confusion)', async () => {
      // The JWKS holds public keys. Permitting an HMAC algorithm would let an
      // attacker sign a token with the public key material as the shared secret.
      // The allowlist must contain only asymmetric algorithms — never HS*.
      mockJwtVerify.mockResolvedValue({
        payload: { client_id: 'test-client', scope: 'read' },
        protectedHeader: { alg: 'RS256' },
        key: {} as any,
      } as any);

      await strategy.verify('test-token');

      expect(mockJwtVerify).toHaveBeenCalledWith(
        'test-token',
        mockJWKS,
        expect.objectContaining({ algorithms: ['RS256', 'ES256', 'PS256'] }),
      );
      const options = mockJwtVerify.mock.calls[0]?.[2] as { algorithms: string[] };
      expect(options.algorithms.some((alg) => alg.startsWith('HS'))).toBe(false);
    });
  });
});
