/**
 * @fileoverview Provides utility functions for authorization, specifically for
 * checking token scopes against required permissions for a given operation.
 * @module src/mcp-server/transports/auth/core/authUtils
 */

import { config } from '@/config/index.js';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import { forbidden, McpError, unauthorized } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';

/** The `Forbidden` errors a scope check threw for a missing scope. */
const scopeRefusals = new WeakSet<McpError>();

/**
 * Marks `error` as a scope check's missing-scope refusal and returns it. The
 * mark is kept beside the error rather than on it, so the thrown `McpError`,
 * its wire envelope, and its log fields stay exactly what they were. Lives here
 * rather than in `checkScopes.ts`, which is the public `/auth` entry: anything
 * exported there is public API.
 *
 * @internal Used by {@link withRequiredScopes} and `checkScopes`.
 */
export function markScopeRefusal(error: McpError): McpError {
  scopeRefusals.add(error);
  return error;
}

/**
 * Whether `error` is the `Forbidden` a scope check threw for a missing scope.
 * That refusal is told apart from every other `Forbidden` — a handler's own
 * `forbidden()`, an upstream 403 — by where it was raised, never by its code,
 * so the tool handler factory can log it at `notice` with no stack (#585).
 *
 * @internal
 */
export function isScopeRefusal(error: unknown): boolean {
  return error instanceof McpError && scopeRefusals.has(error);
}

/**
 * Checks if the current authentication context contains all the specified scopes.
 * When auth is disabled (`MCP_AUTH_MODE=none`), scope checks are skipped.
 * When auth is enabled and the auth context is missing, fails closed with Unauthorized.
 * When `MCP_AUTH_DISABLE_SCOPE_CHECKS=true`, scope enforcement is bypassed after the
 * auth-context presence check; signature, audience, issuer, and expiry validation
 * remain intact.
 *
 * @param requiredScopes - An array of scope strings that are mandatory for the operation.
 * @param parentContext - Optional parent request context for trace correlation.
 * @throws {McpError} Throws `Unauthorized` if auth is enabled but no auth context exists.
 * @throws {McpError} Throws `Forbidden` if auth is active and required scopes are missing.
 */
export function withRequiredScopes(requiredScopes: string[], parentContext?: RequestContext): void {
  const initialContext = parentContext
    ? withExtra({ ...parentContext, operation: 'withRequiredScopesCheck' }, { requiredScopes })
    : requestContextService.createRequestContext({
        operation: 'withRequiredScopesCheck',
        additionalContext: { requiredScopes },
      });

  // Explicitly check if auth is disabled — only skip scope checks when intentionally off.
  if (config.mcpAuthMode === 'none') {
    logger.debug('Auth disabled (MCP_AUTH_MODE=none), skipping scope check.', initialContext);
    return;
  }

  const store = authContext.getStore();

  // Auth is enabled but no context exists — fail closed.
  if (!store?.authInfo) {
    logger.warning(
      'Auth enabled but no authentication context found. Denying request.',
      initialContext,
    );
    // No data: the context carries `extra.requiredScopes`, the scope names the
    // Forbidden branch below withholds to prevent enumeration. The log line
    // above keeps them.
    throw unauthorized('Authentication required but no auth context was established.');
  }

  if (config.mcpAuthDisableScopeChecks) {
    logger.debug(
      'Scope enforcement bypassed (MCP_AUTH_DISABLE_SCOPE_CHECKS=true).',
      initialContext,
    );
    return;
  }

  logger.debug('Performing scope authorization check.', initialContext);

  const { scopes: grantedScopes, clientId, subject } = store.authInfo;
  const grantedScopeSet = new Set(grantedScopes);

  const missingScopes = requiredScopes.filter((scope) => !grantedScopeSet.has(scope));

  const finalContext = withExtra(initialContext, {
    grantedScopes,
    clientId,
    subject,
  });

  if (missingScopes.length > 0) {
    // Log full details server-side (grantedScopes, clientId, subject stay in logs)
    logger.warning(
      'Authorization failed: Missing required scopes.',
      withExtra(finalContext, { missingScopes }),
    );
    // Do not include scope names in the client-facing error data — prevents scope enumeration.
    // Full details (grantedScopes, missingScopes, clientId, subject) are in the server-side log above.
    throw markScopeRefusal(forbidden('Insufficient permissions.'));
  }

  logger.debug('Scope authorization successful.', finalContext);
}
