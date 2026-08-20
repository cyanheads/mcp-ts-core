/**
 * @fileoverview End-to-end authz tests against a scoped-tool fixture server.
 * Uses the real SDK HTTP client with bearer tokens to verify that endpoint
 * authentication and per-tool authorization both behave correctly.
 * @module tests/integration/http-authz.e2e
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateTestJwt } from '../helpers/http-helpers.js';
import {
  assertServerBuilt,
  assertServerEntrypoint,
  type ServerHandle,
  startServerFromEntrypoint,
} from '../helpers/server-process.js';

const FIXTURE_ENTRYPOINT = 'tests/fixtures/auth-scoped-server.js';
const AUTH_SECRET = 'test-secret-key-for-conformance!';

function createToken(scopes: string[]): string {
  return generateTestJwt(
    {
      cid: 'authz-client',
      scp: scopes,
      sub: 'authz-user',
      tid: 'authz-tenant',
    },
    AUTH_SECRET,
  );
}

/**
 * Builds a token shaped like what a standard OIDC provider (Authentik,
 * Keycloak < 26.5, Zitadel) emits when an MCP client (Claude.ai, ChatGPT)
 * connects without the ability to customize requested scopes:
 *   `scope = "openid email profile offline_access"` plus an optional
 *   `mcp_tool_scopes` custom claim that the operator injects via a
 *   property mapping. No `scp` claim — that's an Okta-ism.
 */
function createOidcToken(mcpToolScopes?: string | string[]): string {
  const payload: Record<string, unknown> = {
    cid: 'authz-client',
    scope: 'openid email profile offline_access',
    sub: 'authz-user',
    tid: 'authz-tenant',
  };
  if (mcpToolScopes !== undefined) {
    payload.mcp_tool_scopes = mcpToolScopes;
  }
  return generateTestJwt(payload, AUTH_SECRET);
}

async function withClient<T>(
  port: number,
  token: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  const client = new Client({ name: 'authz-e2e', version: '1.0.0' });

  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);

  try {
    return await run(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Transport may already be closed.
    }
  }
}

describe('HTTP auth authorization e2e', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    assertServerBuilt();
    assertServerEntrypoint(FIXTURE_ENTRYPOINT);
    handle = await startServerFromEntrypoint(FIXTURE_ENTRYPOINT, 'http', {
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: AUTH_SECRET,
      MCP_SESSION_MODE: 'stateful',
    });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('allows scoped callers to invoke both public and protected tools', async () => {
    const token = createToken(['tool:scoped_echo:read']);

    await withClient(handle.port!, token, async (client) => {
      const publicResult = await client.callTool({
        name: 'open_echo',
        arguments: { message: 'hello-public' },
      });
      const protectedResult = await client.callTool({
        name: 'scoped_echo',
        arguments: { message: 'hello-protected' },
      });

      expect(publicResult.isError).toBeUndefined();
      expect(publicResult.structuredContent).toEqual({
        echoed: 'hello-public',
        visibility: 'public',
      });

      expect(protectedResult.isError).toBeUndefined();
      expect(protectedResult.structuredContent).toEqual({
        echoed: 'hello-protected',
        visibility: 'protected',
      });
    });
  });

  it('returns an MCP authz error when the token lacks the protected tool scope', async () => {
    const token = createToken(['tool:other:read']);

    await withClient(handle.port!, token, async (client) => {
      const publicResult = await client.callTool({
        name: 'open_echo',
        arguments: { message: 'still-public' },
      });
      const protectedResult = await client.callTool({
        name: 'scoped_echo',
        arguments: { message: 'blocked' },
      });

      expect(publicResult.isError).toBeUndefined();
      expect(publicResult.structuredContent).toEqual({
        echoed: 'still-public',
        visibility: 'public',
      });

      expect(protectedResult.isError).toBe(true);
      expect(protectedResult.structuredContent).toEqual({
        error: {
          code: expect.any(Number),
          message: expect.stringContaining('Insufficient permissions.'),
        },
      });
      expect(protectedResult.content).toContainEqual({
        type: 'text',
        text: expect.stringContaining('Insufficient permissions.'),
      });
    });
  });

  /**
   * Issue #128 — standard OIDC providers (Authentik, Keycloak < 26.5, Zitadel)
   * cannot inject per-tool scopes into the JWT `scope` claim during the
   * authorization_code flow. Operators inject them via the `mcp_tool_scopes`
   * custom claim instead. These cases exercise that wire-level scenario
   * end-to-end through the JWT strategy and handler factory.
   */
  describe('OIDC fix — mcp_tool_scopes claim union (issue #128)', () => {
    it('reproduces the original bug: standard OIDC scopes alone are insufficient', async () => {
      const token = createOidcToken(); // no mcp_tool_scopes

      await withClient(handle.port!, token, async (client) => {
        const protectedResult = await client.callTool({
          name: 'scoped_echo',
          arguments: { message: 'blocked-by-default-oidc-scopes' },
        });

        expect(protectedResult.isError).toBe(true);
        expect(protectedResult.structuredContent).toEqual({
          error: {
            code: expect.any(Number),
            message: expect.stringContaining('Insufficient permissions.'),
          },
        });
      });
    });

    it('grants the per-tool scope when injected via mcp_tool_scopes (string form)', async () => {
      const token = createOidcToken('tool:scoped_echo:read tool:other:read');

      await withClient(handle.port!, token, async (client) => {
        const protectedResult = await client.callTool({
          name: 'scoped_echo',
          arguments: { message: 'allowed-via-custom-claim-string' },
        });

        expect(protectedResult.isError).toBeUndefined();
        expect(protectedResult.structuredContent).toEqual({
          echoed: 'allowed-via-custom-claim-string',
          visibility: 'protected',
        });
      });
    });

    it('grants the per-tool scope when injected via mcp_tool_scopes (array form)', async () => {
      const token = createOidcToken(['tool:scoped_echo:read', 'tool:other:read']);

      await withClient(handle.port!, token, async (client) => {
        const protectedResult = await client.callTool({
          name: 'scoped_echo',
          arguments: { message: 'allowed-via-custom-claim-array' },
        });

        expect(protectedResult.isError).toBeUndefined();
        expect(protectedResult.structuredContent).toEqual({
          echoed: 'allowed-via-custom-claim-array',
          visibility: 'protected',
        });
      });
    });

    it('still permits the public tool with default OIDC scopes only', async () => {
      const token = createOidcToken();

      await withClient(handle.port!, token, async (client) => {
        const publicResult = await client.callTool({
          name: 'open_echo',
          arguments: { message: 'public-with-default-oidc-scopes' },
        });

        expect(publicResult.isError).toBeUndefined();
        expect(publicResult.structuredContent).toEqual({
          echoed: 'public-with-default-oidc-scopes',
          visibility: 'public',
        });
      });
    });
  });
});

describe('HTTP auth authorization e2e — MCP_AUTH_DISABLE_SCOPE_CHECKS bypass', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    assertServerBuilt();
    assertServerEntrypoint(FIXTURE_ENTRYPOINT);
    handle = await startServerFromEntrypoint(FIXTURE_ENTRYPOINT, 'http', {
      MCP_AUTH_MODE: 'jwt',
      MCP_AUTH_SECRET_KEY: AUTH_SECRET,
      MCP_AUTH_DISABLE_SCOPE_CHECKS: 'true',
      MCP_SESSION_MODE: 'stateful',
    });
  });

  afterAll(async () => {
    await handle?.kill();
  });

  it('allows the protected tool with only default OIDC scopes when the bypass is on', async () => {
    const token = createOidcToken();

    await withClient(handle.port!, token, async (client) => {
      const protectedResult = await client.callTool({
        name: 'scoped_echo',
        arguments: { message: 'allowed-by-bypass' },
      });

      expect(protectedResult.isError).toBeUndefined();
      expect(protectedResult.structuredContent).toEqual({
        echoed: 'allowed-by-bypass',
        visibility: 'protected',
      });
    });
  });
});
