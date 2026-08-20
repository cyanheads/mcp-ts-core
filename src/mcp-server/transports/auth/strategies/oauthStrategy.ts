/**
 * @fileoverview Implements the OAuth 2.1 authentication strategy.
 * This module provides a concrete implementation of the AuthStrategy for validating
 * JWTs against a remote JSON Web Key Set (JWKS), as is common in OAuth 2.1 flows.
 * @module src/mcp-server/transports/auth/strategies/OauthStrategy
 */
import { createRemoteJWKSet, type JWTVerifyResult, jwtVerify } from 'jose';

import type { config as ConfigType } from '@/config/index.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import {
  buildAuthInfoFromClaims,
  handleJoseVerifyError,
} from '@/mcp-server/transports/auth/lib/claimParser.js';
import type { AuthStrategy } from '@/mcp-server/transports/auth/strategies/authStrategy.js';
import { configurationError, forbidden, serviceUnavailable } from '@/types-global/errors.js';
import type { logger as LoggerType } from '@/utils/internal/logger.js';
import { requestContextService, withExtra } from '@/utils/internal/requestContext.js';

export class OauthStrategy implements AuthStrategy {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuerUrl: string;
  private readonly audience: string;

  constructor(
    private config: typeof ConfigType,
    private logger: typeof LoggerType,
  ) {
    const context = requestContextService.createRequestContext({
      operation: 'OauthStrategy.constructor',
    });
    this.logger.debug('Initializing OauthStrategy...', context);

    if (this.config.mcpAuthMode !== 'oauth') {
      throw new Error('OauthStrategy instantiated for non-oauth auth mode.');
    }
    if (!this.config.oauthIssuerUrl || !this.config.oauthAudience) {
      this.logger.fatal(
        'CRITICAL: OAUTH_ISSUER_URL and OAUTH_AUDIENCE must be set for OAuth mode.',
        context,
      );
      throw configurationError(
        'OAUTH_ISSUER_URL and OAUTH_AUDIENCE must be set for OAuth mode.',
        context,
      );
    }

    // Store validated config — no casts needed after the guard above
    this.issuerUrl = this.config.oauthIssuerUrl;
    this.audience = this.config.oauthAudience;

    try {
      const jwksUrl = new URL(
        this.config.oauthJwksUri || `${this.issuerUrl.replace(/\/$/, '')}/.well-known/jwks.json`,
      );
      this.jwks = createRemoteJWKSet(jwksUrl, {
        cooldownDuration: this.config.oauthJwksCooldownMs,
        timeoutDuration: this.config.oauthJwksTimeoutMs,
      });
      this.logger.info(`JWKS client initialized for URL: ${jwksUrl.href}`, context);
    } catch (error: unknown) {
      this.logger.fatal(
        'Failed to initialize JWKS client.',
        withExtra(context, { error: error instanceof Error ? error.message : String(error) }),
      );
      throw serviceUnavailable('Could not initialize JWKS client for OAuth strategy.', {
        ...context,
        originalError: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  async verify(token: string): Promise<AuthInfo> {
    const context = requestContextService.createRequestContext({
      operation: 'OauthStrategy.verify',
    });
    this.logger.debug('Attempting to verify OAuth token via JWKS.', context);

    try {
      const { payload }: JWTVerifyResult = await jwtVerify(token, this.jwks, {
        issuer: this.issuerUrl,
        audience: this.audience,
        algorithms: ['RS256', 'ES256', 'PS256'],
      });
      this.logger.debug(
        'OAuth token signature verified successfully.',
        withExtra(context, {
          claims: {
            iss: payload.iss,
            aud: payload.aud,
            exp: payload.exp,
            iat: payload.iat,
            jti: payload.jti,
          },
        }),
      );

      // RFC 8707 Resource Indicators validation (MCP 2025-06-18 requirement)
      if (this.config.mcpServerResourceIdentifier) {
        const resourceClaim = payload.resource || payload.aud;
        const expectedResource = this.config.mcpServerResourceIdentifier;

        const isResourceValid =
          (Array.isArray(resourceClaim) && resourceClaim.includes(expectedResource)) ||
          resourceClaim === expectedResource;

        if (!isResourceValid) {
          this.logger.warning(
            'Token resource indicator mismatch. Token was not issued for this MCP server.',
            withExtra(context, {
              expected: expectedResource,
              received: resourceClaim,
            }),
          );
          throw forbidden(
            'Token was not issued for this MCP server. Resource indicator mismatch.',
            {
              expected: expectedResource,
              received: resourceClaim,
            },
          );
        }

        this.logger.debug(
          'RFC 8707 resource indicator validated successfully.',
          withExtra(context, { resource: expectedResource }),
        );
      }

      const authInfo = buildAuthInfoFromClaims(token, payload);

      this.logger.info('OAuth token verification successful.', {
        ...withExtra(context, { clientId: authInfo.clientId, scopes: authInfo.scopes }),
        ...(authInfo.tenantId ? { tenantId: authInfo.tenantId } : {}),
      });
      return authInfo;
    } catch (error: unknown) {
      this.logger.warning(
        'OAuth token verification failed.',
        withExtra(context, { errorName: error instanceof Error ? error.name : 'Unknown' }),
      );
      handleJoseVerifyError(error, 'OAuth token verification failed.');
    }
  }
}
