/**
 * @fileoverview Factory for creating an authentication strategy based on configuration.
 * This module centralizes the logic for selecting and instantiating the correct
 * authentication strategy, promoting loose coupling and easy extensibility.
 * @module src/mcp-server/transports/auth/authFactory
 */
import { config } from '@/config/index.js';
import type { AuthStrategy } from '@/mcp-server/transports/auth/strategies/authStrategy.js';
import { JwtStrategy } from '@/mcp-server/transports/auth/strategies/jwtStrategy.js';
import { OauthStrategy } from '@/mcp-server/transports/auth/strategies/oauthStrategy.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/**
 * Creates and returns an authentication strategy instance based on the
 * application's configuration (`config.mcpAuthMode`).
 *
 * @returns An instance of a class that implements the `AuthStrategy` interface,
 *          or `null` if authentication is disabled (`none`).
 * @throws {Error} If the auth mode is unknown or misconfigured.
 */
export function createAuthStrategy(): AuthStrategy | null {
  const context = requestContextService.createRequestContext({
    operation: 'createAuthStrategy',
    additionalContext: { authMode: config.mcpAuthMode },
  });
  logger.info('Creating authentication strategy...', context);

  if (config.mcpAuthDisableScopeChecks && config.mcpAuthMode !== 'none') {
    logger.warning(
      'MCP_AUTH_DISABLE_SCOPE_CHECKS=true — per-tool and runtime scope enforcement is bypassed for every request. Token signature, audience, issuer, and expiry validation are still applied. Combine with server-side ACLs to avoid granting every authenticated user every tool.',
      context,
    );
  }

  switch (config.mcpAuthMode) {
    case 'jwt':
      logger.debug('Creating JWT strategy.', context);
      return new JwtStrategy(config, logger);
    case 'oauth':
      logger.info(
        'OAuth mode active. Granted scopes are read from `scp` (array), `scope` (space-delimited), and `mcp_tool_scopes` (custom claim, for OIDC providers that cannot inject scopes into `scope` during authorization_code flow — Authentik, Keycloak <26.5, Zitadel). To bypass per-tool enforcement entirely, set MCP_AUTH_DISABLE_SCOPE_CHECKS=true (combine with server-side ACLs).',
        context,
      );
      return new OauthStrategy(config, logger);
    case 'none':
      logger.info("Authentication is disabled ('none' mode).", context);
      return null; // No authentication
    default:
      // This ensures that if a new auth mode is added to the config type
      // but not to this factory, we get a compile-time or runtime error.
      logger.error(`Unknown authentication mode: ${String(config.mcpAuthMode)}`, context);
      throw new Error(`Unknown authentication mode: ${String(config.mcpAuthMode)}`);
  }
}
