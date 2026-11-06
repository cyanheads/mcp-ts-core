/**
 * @fileoverview Unit tests for authentication strategy factory.
 * @module tests/mcp-server/transports/auth/authFactory
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthStrategy } from '@/mcp-server/transports/auth/authFactory.js';
import { JwtStrategy } from '@/mcp-server/transports/auth/strategies/jwtStrategy.js';
import { OauthStrategy } from '@/mcp-server/transports/auth/strategies/oauthStrategy.js';
import { logger } from '@/utils/internal/logger.js';

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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each<[string, Partial<typeof mockConfig>, number]>([
    ['jwt', { mcpAuthSecretKey: 'test-secret-key-that-is-at-least-32-chars-long' }, 1],
    ['oauth', { oauthIssuerUrl: 'https://example.com', oauthAudience: 'test-audience' }, 0],
    ['none', {}, 0],
  ])(
    'warns about an unset MCP_JWT_EXPECTED_AUDIENCE only in jwt mode (%s)',
    (mode, overrides, expected) => {
      Object.assign(mockConfig, { mcpAuthMode: mode, ...overrides });
      const warning = vi.spyOn(logger, 'warning');

      createAuthStrategy();

      const audienceWarnings = warning.mock.calls.filter(([message]) =>
        String(message).includes('MCP_JWT_EXPECTED_AUDIENCE'),
      );
      expect(audienceWarnings).toHaveLength(expected);
    },
  );
});
