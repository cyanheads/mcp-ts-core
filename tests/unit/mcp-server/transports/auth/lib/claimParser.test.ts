/**
 * @fileoverview Unit tests for the shared JWT claim parser.
 * @module tests/mcp-server/transports/auth/lib/claimParser.test
 */
import type { JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  buildAuthInfoFromClaims,
  handleJoseVerifyError,
} from '@/mcp-server/transports/auth/lib/claimParser.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const RAW_TOKEN = 'raw.jwt.token';

describe('buildAuthInfoFromClaims', () => {
  describe('clientId extraction', () => {
    it('extracts clientId from the cid claim (Okta)', () => {
      const payload: JWTPayload = { cid: 'okta-client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.clientId).toBe('okta-client');
    });

    it('extracts clientId from the client_id claim (OAuth standard)', () => {
      const payload: JWTPayload = { client_id: 'oauth-client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.clientId).toBe('oauth-client');
    });

    it('prefers cid over client_id when both are present', () => {
      const payload: JWTPayload = { cid: 'okta-client', client_id: 'oauth-client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.clientId).toBe('okta-client');
    });

    it('throws McpError (Unauthorized) when neither cid nor client_id is present', () => {
      const payload: JWTPayload = { scp: ['read'] };
      expect(() => buildAuthInfoFromClaims(RAW_TOKEN, payload)).toThrow(McpError);
      try {
        buildAuthInfoFromClaims(RAW_TOKEN, payload);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
        expect(mcpError.message).toContain('cid');
        expect(mcpError.message).toContain('client_id');
      }
    });
  });

  describe('scope extraction', () => {
    it('extracts scopes from the scp array claim (Okta)', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read', 'write'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('extracts scopes from the scope space-delimited string claim (OAuth standard)', () => {
      const payload: JWTPayload = { cid: 'client', scope: 'read write' };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['read', 'write']);
    });

    it('drops leading, trailing, and repeated spaces from the scope string', () => {
      const payload: JWTPayload = {
        cid: 'client',
        scope: '  tool:read   resource:write  tool:execute  ',
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['tool:read', 'resource:write', 'tool:execute']);
    });

    it('unions scp array and scope string when both are present', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['scp-scope'], scope: 'scope-string' };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['scp-scope', 'scope-string']);
    });

    it('extracts scopes from mcp_tool_scopes when expressed as a space-delimited string', () => {
      const payload: JWTPayload = {
        cid: 'client',
        mcp_tool_scopes: 'tool:foo:read tool:bar:write',
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['tool:foo:read', 'tool:bar:write']);
    });

    it('extracts scopes from mcp_tool_scopes when expressed as an array', () => {
      const payload: JWTPayload = {
        cid: 'client',
        mcp_tool_scopes: ['tool:foo:read', 'tool:bar:write'],
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['tool:foo:read', 'tool:bar:write']);
    });

    it('unions scope and mcp_tool_scopes (the documented OIDC workaround path)', () => {
      const payload: JWTPayload = {
        cid: 'client',
        scope: 'openid email profile offline_access',
        mcp_tool_scopes: 'tool:foo:read tool:bar:write',
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual([
        'openid',
        'email',
        'profile',
        'offline_access',
        'tool:foo:read',
        'tool:bar:write',
      ]);
    });

    it('unions scp, scope, and mcp_tool_scopes when all three are present', () => {
      const payload: JWTPayload = {
        cid: 'client',
        scp: ['scp-scope'],
        scope: 'scope-string',
        mcp_tool_scopes: ['tool:custom:read'],
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['scp-scope', 'scope-string', 'tool:custom:read']);
    });

    it('ignores mcp_tool_scopes when it is an array containing non-string entries', () => {
      const payload: JWTPayload = {
        cid: 'client',
        scope: 'read',
        mcp_tool_scopes: ['tool:foo:read', 42 as unknown as string],
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['read']);
    });

    it('drops empty-string entries from array-form scope claims', () => {
      const payload: JWTPayload = {
        cid: 'client',
        mcp_tool_scopes: ['tool:foo:read', '', 'tool:bar:write'],
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['tool:foo:read', 'tool:bar:write']);
    });

    it('ignores mcp_tool_scopes when its value is neither array nor string', () => {
      const payload: JWTPayload = {
        cid: 'client',
        scope: 'read',
        mcp_tool_scopes: { not: 'usable' } as unknown as string,
      };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.scopes).toEqual(['read']);
    });

    it('throws McpError (Unauthorized) when neither scp, scope, nor mcp_tool_scopes is present', () => {
      const payload: JWTPayload = { cid: 'client' };
      expect(() => buildAuthInfoFromClaims(RAW_TOKEN, payload)).toThrow(McpError);
      try {
        buildAuthInfoFromClaims(RAW_TOKEN, payload);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      }
    });

    it('throws McpError (Unauthorized) when scp is an empty array', () => {
      const payload: JWTPayload = { cid: 'client', scp: [] };
      expect(() => buildAuthInfoFromClaims(RAW_TOKEN, payload)).toThrow(McpError);
      try {
        buildAuthInfoFromClaims(RAW_TOKEN, payload);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      }
    });

    it('throws McpError (Unauthorized) when scope is an empty string', () => {
      const payload: JWTPayload = { cid: 'client', scope: '' };
      expect(() => buildAuthInfoFromClaims(RAW_TOKEN, payload)).toThrow(McpError);
      try {
        buildAuthInfoFromClaims(RAW_TOKEN, payload);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      }
    });

    it('throws McpError (Unauthorized) when scope is a whitespace-only string', () => {
      const payload: JWTPayload = { cid: 'client', scope: '   ' };
      expect(() => buildAuthInfoFromClaims(RAW_TOKEN, payload)).toThrow(McpError);
      try {
        buildAuthInfoFromClaims(RAW_TOKEN, payload);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      }
    });

    it('throws McpError (Unauthorized) when only an empty mcp_tool_scopes string is present', () => {
      const payload: JWTPayload = { cid: 'client', mcp_tool_scopes: '' };
      expect(() => buildAuthInfoFromClaims(RAW_TOKEN, payload)).toThrow(McpError);
      try {
        buildAuthInfoFromClaims(RAW_TOKEN, payload);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      }
    });
  });

  describe('optional claim extraction', () => {
    it('includes subject when sub claim is present', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read'], sub: 'user-123' };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.subject).toBe('user-123');
    });

    it('omits subject when sub claim is absent', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.subject).toBeUndefined();
    });

    it('includes tenantId when tid claim is present', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read'], tid: 'tenant-abc' };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.tenantId).toBe('tenant-abc');
    });

    it('omits tenantId when tid claim is absent', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.tenantId).toBeUndefined();
    });

    it('includes expiresAt when exp claim is present', () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const payload: JWTPayload = { cid: 'client', scp: ['read'], exp };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.expiresAt).toBe(exp);
    });

    it('omits expiresAt when exp claim is absent', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe('token passthrough', () => {
    it('includes the raw token string in the returned AuthInfo', () => {
      const payload: JWTPayload = { cid: 'client', scp: ['read'] };
      const result = buildAuthInfoFromClaims(RAW_TOKEN, payload);
      expect(result.token).toBe(RAW_TOKEN);
    });
  });
});

describe('handleJoseVerifyError', () => {
  it('rethrows McpError instances unchanged', () => {
    const original = new McpError(JsonRpcErrorCode.Forbidden, 'custom forbidden');
    expect(() => handleJoseVerifyError(original, 'fallback')).toThrow(original);
  });

  it('maps JWTExpired errors to "Token has expired."', () => {
    expect.assertions(3);
    const expired = new Error('jwt expired');
    expired.name = 'JWTExpired';
    try {
      handleJoseVerifyError(expired, 'fallback message');
    } catch (error) {
      const mcpError = error as McpError;
      expect(mcpError).toBeInstanceOf(McpError);
      expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(mcpError.message).toBe('Token has expired.');
    }
  });

  it('uses fallback message for non-expired jose errors', () => {
    expect.assertions(3);
    const sigError = new Error('signature verification failed');
    sigError.name = 'JWSSignatureVerificationFailed';
    try {
      handleJoseVerifyError(sigError, 'Verification failed.');
    } catch (error) {
      const mcpError = error as McpError;
      expect(mcpError).toBeInstanceOf(McpError);
      expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(mcpError.message).toBe('Verification failed.');
    }
  });

  it('uses fallback message for non-Error values', () => {
    expect.assertions(3);
    try {
      handleJoseVerifyError('string error', 'Unknown failure.');
    } catch (error) {
      const mcpError = error as McpError;
      expect(mcpError).toBeInstanceOf(McpError);
      expect(mcpError.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(mcpError.message).toBe('Unknown failure.');
    }
  });
});
