/**
 * @fileoverview Shared types for authentication middleware.
 * @module src/mcp-server/transports/auth/lib/authTypes
 */
import type { AuthInfo as SdkAuthInfo } from '@modelcontextprotocol/server';

/**
 * Extends the SDK's base AuthInfo with common optional JWT claims
 * not part of the core MCP auth contract.
 *
 * - `subject` — JWT `sub` claim (end-user or service identity)
 * - `tenantId` — JWT `tid` claim (Azure AD / custom multi-tenant)
 */
export type AuthInfo = SdkAuthInfo & {
  /** JWT `sub` claim — the authenticated subject (user or service). */
  subject?: string;
  /** JWT `tid` claim — tenant identifier for multi-tenant deployments. */
  tenantId?: string;
};
