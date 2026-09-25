/**
 * @fileoverview Unit tests for authentication strategy factory.
 * @module tests/mcp-server/transports/auth/authFactory
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthStrategy } from '@/mcp-server/transports/auth/authFactory.js';
import { JwtStrategy } from '@/mcp-server/transports/auth/strategies/jwtStrategy.js';
import { OauthStrategy } from '@/mcp-server/transports/auth/strategies/oauthStrategy.js';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    mcpAuthMode: 'none',
    mcpAuthSecretKey: undefined as string | undefined,
    oauthIssuerUrl: undefined as string | undefined,
    oauthAudience: undefined as string | undefined,
  },
}));

vi.mock('@/config/index.js', () => ({
  config: mockConfig,
}));

describe('createAuthStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.mcpAuthMode = 'none';
    mockConfig.mcpAuthSecretKey = undefined;
    mockConfig.oauthIssuerUrl = undefined;
    mockConfig.oauthAudience = undefined;
  });

  it('should return JwtStrategy when auth mode is "jwt"', () => {
    mockConfig.mcpAuthMode = 'jwt';
    mockConfig.mcpAuthSecretKey = 'test-secret-key-that-is-at-least-32-chars-long';

    const strategy = createAuthStrategy();

    expect(strategy).toBeInstanceOf(JwtStrategy);
  });

  it('should return OauthStrategy when auth mode is "oauth"', () => {
    mockConfig.mcpAuthMode = 'oauth';
    mockConfig.oauthIssuerUrl = 'https://example.com';
    mockConfig.oauthAudience = 'test-audience';

    const strategy = createAuthStrategy();

    expect(strategy).toBeInstanceOf(OauthStrategy);
  });

  it('should return null when auth mode is "none"', () => {
    mockConfig.mcpAuthMode = 'none';

    const strategy = createAuthStrategy();

    expect(strategy).toBeNull();
  });

  it('should throw error for unknown auth mode', () => {
    mockConfig.mcpAuthMode = 'unknown-auth-mode';

    expect(() => createAuthStrategy()).toThrow('Unknown authentication mode: unknown-auth-mode');
  });
});
