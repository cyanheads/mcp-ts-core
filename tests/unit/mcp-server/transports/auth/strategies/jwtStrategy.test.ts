/**
 * @fileoverview Unit tests for JWT authentication strategy.
 * @module tests/mcp-server/transports/auth/strategies/jwtStrategy
 */

import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtStrategy } from '@/mcp-server/transports/auth/strategies/jwtStrategy.js';
import { McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    environment: 'production',
    mcpAuthSecretKey: 'test-secret-key-min-32-chars-long-for-hs256',
    devMcpAuthBypass: false,
    devMcpClientId: undefined as string | undefined,
    devMcpScopes: undefined as string[] | undefined,
    mcpJwtExpectedIssuer: undefined as string | undefined,
    mcpJwtExpectedAudience: undefined as string | undefined,
  } as Record<string, unknown>,
}));

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  const testSecret = 'test-secret-key-min-32-chars-long-for-hs256';
  const testSecretBytes = new TextEncoder().encode(testSecret);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to safe production defaults before each test
    mockConfig.environment = 'production';
    mockConfig.mcpAuthSecretKey = testSecret;
    mockConfig.devMcpAuthBypass = false;
    mockConfig.devMcpClientId = undefined;
    mockConfig.devMcpScopes = undefined;
    mockConfig.mcpJwtExpectedIssuer = undefined;
    mockConfig.mcpJwtExpectedAudience = undefined;
  });

  describe('constructor', () => {
    it('should throw error in production without secret key', () => {
      mockConfig.environment = 'production';
      mockConfig.mcpAuthSecretKey = undefined;

      expect(() => new JwtStrategy(mockConfig as never, logger)).toThrow(McpError);
    });

    describe('startup warnings', () => {
      const AUDIENCE_WARNING =
        "MCP_JWT_EXPECTED_AUDIENCE is not set — JWT mode accepts any token signed with MCP_AUTH_SECRET_KEY whatever its aud claim, so a token minted for another service that shares the key is accepted here. Set MCP_JWT_EXPECTED_AUDIENCE (and MCP_JWT_EXPECTED_ISSUER) to the values this server's tokens carry.";
      const BYPASS_WARNING =
        'MCP_AUTH_SECRET_KEY is not set. JWT auth bypassed via DEV_MCP_AUTH_BYPASS=true (environment: development).';
      const ISSUER = 'https://issuer.example.com';
      const AUDIENCE = 'mcp-ts-core-tests';

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each<[string, Record<string, unknown>, string[]]>([
        ['a key and no audience', {}, [AUDIENCE_WARNING]],
        ['a key, an issuer, and no audience', { mcpJwtExpectedIssuer: ISSUER }, [AUDIENCE_WARNING]],
        ['a key, the dev bypass, and no audience', { devMcpAuthBypass: true }, [AUDIENCE_WARNING]],
        ['a key and an audience', { mcpJwtExpectedAudience: AUDIENCE }, []],
        [
          'a key, an issuer, and an audience',
          { mcpJwtExpectedIssuer: ISSUER, mcpJwtExpectedAudience: AUDIENCE },
          [],
        ],
        [
          'the dev bypass and no key',
          { mcpAuthSecretKey: undefined, devMcpAuthBypass: true },
          [BYPASS_WARNING],
        ],
      ])('logs exactly the expected warnings with %s', (_label, overrides, expected) => {
        Object.assign(mockConfig, { environment: 'development', ...overrides });
        const warning = vi.spyOn(logger, 'warning');

        new JwtStrategy(mockConfig as never, logger);

        expect(warning.mock.calls.map(([message]) => message)).toEqual(expected);
        for (const [, context] of warning.mock.calls) {
          expect(context).toMatchObject({ operation: 'JwtStrategy.constructor' });
        }
      });
    });
  });

  describe('verify', () => {
    beforeEach(() => {
      mockConfig.mcpAuthSecretKey = testSecret;
      strategy = new JwtStrategy(mockConfig as never, logger);
    });

    it('should verify valid JWT token with cid claim', async () => {
      const token = await new SignJWT({
        cid: 'test-client',
        scp: ['tool:read', 'resource:write'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(testSecretBytes);

      const authInfo = await strategy.verify(token);

      expect(authInfo.clientId).toBe('test-client');
      expect(authInfo.scopes).toEqual(['tool:read', 'resource:write']);
      expect(authInfo.token).toBe(token);
    });

    it('should throw error for missing client ID claim', async () => {
      const token = await new SignJWT({
        scp: ['tool:read'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(testSecretBytes);

      await expect(strategy.verify(token)).rejects.toThrow(McpError);
      await expect(strategy.verify(token)).rejects.toThrow(/missing 'cid' or 'client_id'/);
    });

    it('should throw error for expired token', async () => {
      const token = await new SignJWT({
        cid: 'test-client',
        scp: ['tool:read'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('0s') // Already expired
        .sign(testSecretBytes);

      // Wait a bit to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(strategy.verify(token)).rejects.toThrow(McpError);
    });

    it('should throw error for invalid signature', async () => {
      const wrongSecret = new TextEncoder().encode('wrong-secret-key');
      const token = await new SignJWT({
        cid: 'test-client',
        scp: ['tool:read'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(wrongSecret);

      await expect(strategy.verify(token)).rejects.toThrow(McpError);
    });

    it('should bypass verification when devMcpAuthBypass is true', async () => {
      mockConfig.environment = 'development';
      mockConfig.mcpAuthSecretKey = undefined;
      mockConfig.devMcpAuthBypass = true;
      mockConfig.devMcpClientId = 'dev-client';
      mockConfig.devMcpScopes = ['dev:read', 'dev:write'];

      const devStrategy = new JwtStrategy(mockConfig as never, logger);

      const authInfo = await devStrategy.verify('any-token');

      expect(authInfo.clientId).toBe('dev-client');
      expect(authInfo.scopes).toEqual(['dev:read', 'dev:write']);
      expect(authInfo.token).toBe('dev-mode-placeholder-token');
    });

    it('should verify issuer and audience when configured', async () => {
      mockConfig.mcpJwtExpectedIssuer = 'https://issuer.example.com';
      mockConfig.mcpJwtExpectedAudience = 'mcp-ts-core-tests';
      strategy = new JwtStrategy(mockConfig as never, logger);

      const token = await new SignJWT({
        cid: 'test-client',
        scp: ['tool:read'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('https://issuer.example.com')
        .setAudience('mcp-ts-core-tests')
        .setExpirationTime('1h')
        .sign(testSecretBytes);

      const authInfo = await strategy.verify(token);

      expect(authInfo.clientId).toBe('test-client');
      expect(authInfo.scopes).toEqual(['tool:read']);
    });

    it('should reject a token with the wrong configured audience', async () => {
      mockConfig.mcpJwtExpectedIssuer = 'https://issuer.example.com';
      mockConfig.mcpJwtExpectedAudience = 'mcp-ts-core-tests';
      strategy = new JwtStrategy(mockConfig as never, logger);

      const token = await new SignJWT({
        cid: 'test-client',
        scp: ['tool:read'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('https://issuer.example.com')
        .setAudience('wrong-audience')
        .setExpirationTime('1h')
        .sign(testSecretBytes);

      await expect(strategy.verify(token)).rejects.toThrow(McpError);
    });

    describe('algorithm and claim security', () => {
      /** Hand-crafts a compact JWS the way an attacker would — jose refuses to
       *  sign with `alg: none`, so we assemble the segments directly. */
      const b64url = (value: object): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');

      it('rejects an unsigned alg:none token (algorithm-confusion bypass)', async () => {
        const header = b64url({ alg: 'none', typ: 'JWT' });
        const payload = b64url({
          cid: 'attacker',
          scp: ['tool:admin'],
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const noneToken = `${header}.${payload}.`;

        await expect(strategy.verify(noneToken)).rejects.toThrow(McpError);
      });

      it('rejects an alg:none token carrying a forged signature segment', async () => {
        const header = b64url({ alg: 'none', typ: 'JWT' });
        const payload = b64url({
          cid: 'attacker',
          scp: ['tool:admin'],
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const forged = `${header}.${payload}.Zm9yZ2Vk`;

        await expect(strategy.verify(forged)).rejects.toThrow(McpError);
      });

      it('rejects a token whose header uses a non-allowlisted algorithm even when signed with the real secret', async () => {
        // HS384 is a valid MAC over the same key, but the strategy pins HS256 —
        // an attacker must not be able to downgrade/substitute the algorithm.
        const token = await new SignJWT({ cid: 'test-client', scp: ['tool:read'] })
          .setProtectedHeader({ alg: 'HS384' })
          .setExpirationTime('1h')
          .sign(testSecretBytes);

        await expect(strategy.verify(token)).rejects.toThrow(McpError);
      });

      it('rejects a token that is not yet valid (nbf in the future)', async () => {
        const token = await new SignJWT({ cid: 'test-client', scp: ['tool:read'] })
          .setProtectedHeader({ alg: 'HS256' })
          .setNotBefore('1h')
          .setExpirationTime('2h')
          .sign(testSecretBytes);

        await expect(strategy.verify(token)).rejects.toThrow(McpError);
      });
    });
  });
});
