/**
 * @fileoverview Real OAuth/JWKS integration against a hermetic loopback OIDC issuer.
 * @module tests/integration/oauth-jwks.int.test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeBody, jsonrpc, MCP_HEADERS } from '../helpers/http-helpers.js';
import {
  createOAuthJwksFixture,
  type OAuthJwksFixture,
  type OAuthSigningKey,
} from '../helpers/oauth-jwks-fixture.js';
import { type ServerHandle, startServer } from '../helpers/server-process.js';

const PROTOCOL_VERSION = '2025-06-18';
const PUBLIC_URL = 'https://public.example.test';
const RESOURCE = 'https://resource.example.test/mcp';
const WWW_AUTHENTICATE = `Bearer realm="@cyanheads/mcp-ts-core", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`;

/**
 * Every case in this block shares one fixture and one server process, and cases
 * mutate that shared state for the ones that follow (the JWKS response delay is
 * set in `beforeAll` and cleared by the cold-start case; the outage, timeout, and
 * rotation cases each extend the published key set). They must run in declaration
 * order — do not shuffle this lane or run a case in isolation with `-t`.
 */
describe('real OAuth/JWKS integration', () => {
  let fixture: OAuthJwksFixture;
  let handle: ServerHandle;
  let rsaPrimary: OAuthSigningKey;
  let ecPrimary: OAuthSigningKey;
  let rsaRotated: OAuthSigningKey;
  let rsaOutage: OAuthSigningKey;
  let rsaTimeout: OAuthSigningKey;

  const endpoint = () => `http://127.0.0.1:${handle.port}/mcp`;

  async function initialize(token?: string): Promise<Response> {
    return await fetch(endpoint(), {
      body: initializeBody(),
      headers: {
        ...MCP_HEADERS,
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      method: 'POST',
    });
  }

  function expectUnauthorized(response: Response): void {
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE);
  }

  beforeAll(async () => {
    fixture = await createOAuthJwksFixture();
    [rsaPrimary, ecPrimary, rsaRotated, rsaOutage, rsaTimeout] = await Promise.all([
      fixture.createSigningKey('RS256', 'rsa-primary'),
      fixture.createSigningKey('ES256', 'ec-primary'),
      fixture.createSigningKey('RS256', 'rsa-rotated'),
      fixture.createSigningKey('RS256', 'rsa-outage'),
      fixture.createSigningKey('RS256', 'rsa-timeout'),
    ]);
    fixture.setJwks([rsaPrimary, ecPrimary]);
    fixture.setDelay(50);

    handle = await startServer('http', {
      MCP_AUTH_MODE: 'oauth',
      MCP_PUBLIC_URL: `${PUBLIC_URL}/`,
      MCP_SERVER_RESOURCE_IDENTIFIER: RESOURCE,
      MCP_SESSION_MODE: 'stateful',
      OAUTH_AUDIENCE: 'mcp-audience',
      OAUTH_ISSUER_URL: fixture.issuer,
      OAUTH_JWKS_COOLDOWN_MS: '0',
      OAUTH_JWKS_TIMEOUT_MS: '150',
    });
  });

  afterAll(async () => {
    await handle?.kill();
    await fixture?.close();
  });

  it('exposes deterministic OIDC discovery metadata', async () => {
    const response = await fetch(fixture.discoveryUrl);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      issuer: fixture.issuer,
      jwks_uri: fixture.jwksUrl,
    });
  });

  it('deduplicates concurrent cold-start JWKS requests and accepts RS256 tokens', async () => {
    fixture.resetJwksRequestCount();
    const token = await fixture.issueToken(rsaPrimary);
    const responses = await Promise.all(Array.from({ length: 12 }, () => initialize(token)));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(fixture.getJwksRequestCount()).toBe(1);
    fixture.setDelay(0);
  });

  it('accepts an ES256 token through the real remote JWKS pipeline', async () => {
    const response = await initialize(await fixture.issueToken(ecPrimary));
    expect(response.status).toBe(200);
  });

  it.each([
    ['wrong issuer', { issuer: 'https://wrong-issuer.example' }],
    ['wrong audience', { audience: 'wrong-audience' }],
    ['expired token', { expiresInSeconds: -60 }],
  ] as const)('rejects %s with an exact OAuth challenge', async (_label, tokenOptions) => {
    const response = await initialize(await fixture.issueToken(rsaPrimary, tokenOptions));
    expectUnauthorized(response);
  });

  it('rejects a token issued for a different RFC 8707 resource', async () => {
    const response = await initialize(
      await fixture.issueToken(rsaPrimary, { resource: 'https://other-resource.example/mcp' }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('returns exact protected-resource metadata and unauthenticated challenge URLs', async () => {
    const unauthenticated = await initialize();
    expectUnauthorized(unauthenticated);

    const metadata = await fetch(
      `http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource`,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      authorization_servers: [fixture.issuer],
      bearer_methods_supported: ['header'],
      resource: RESOURCE,
      resource_signing_alg_values_supported: ['RS256', 'ES256', 'PS256'],
    });
  });

  it('reloads JWKS after a kid miss and accepts a rotated key', async () => {
    const token = await fixture.issueToken(rsaRotated);
    const missing = await initialize(token);
    expectUnauthorized(missing);

    const requestsBeforeRotation = fixture.getJwksRequestCount();
    fixture.setJwks([rsaPrimary, ecPrimary, rsaRotated]);
    const rotated = await initialize(token);

    expect(rotated.status).toBe(200);
    expect(fixture.getJwksRequestCount()).toBeGreaterThan(requestsBeforeRotation);
  });

  it('fails closed during a JWKS outage and recovers without restarting', async () => {
    const token = await fixture.issueToken(rsaOutage);
    fixture.setMode('outage');
    expectUnauthorized(await initialize(token));

    fixture.setJwks([rsaPrimary, ecPrimary, rsaRotated, rsaOutage]);
    fixture.setMode('healthy');
    expect((await initialize(token)).status).toBe(200);
  });

  it('times out a stalled JWKS fetch and recovers without restarting', async () => {
    const token = await fixture.issueToken(rsaTimeout);
    fixture.setMode('timeout');
    expectUnauthorized(await initialize(token));

    fixture.setJwks([rsaPrimary, ecPrimary, rsaRotated, rsaOutage, rsaTimeout]);
    fixture.setMode('healthy');
    expect((await initialize(token)).status).toBe(200);
  });

  it('binds stateful sessions to OAuth identity, not the token or signing algorithm', async () => {
    const rsaToken = await fixture.issueToken(rsaPrimary);
    const initialized = await initialize(rsaToken);
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toMatch(/^[a-f0-9]{64}$/);

    await fetch(endpoint(), {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${rsaToken}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'POST',
    });

    const sameIdentityEcToken = await fixture.issueToken(ecPrimary);
    const sameIdentity = await fetch(endpoint(), {
      body: jsonrpc(2, 'tools/list'),
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${sameIdentityEcToken}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'POST',
    });
    expect(sameIdentity.status).toBe(200);

    const otherTenantToken = await fixture.issueToken(rsaPrimary, {
      claims: { tid: 'other-tenant' },
    });
    const otherTenant = await fetch(endpoint(), {
      body: jsonrpc(3, 'tools/list'),
      headers: {
        ...MCP_HEADERS,
        Authorization: `Bearer ${otherTenantToken}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Session-Id': sessionId!,
      },
      method: 'POST',
    });
    expect(otherTenant.status).toBe(404);
    await expect(otherTenant.json()).resolves.toEqual({ error: 'Session not found or expired' });
  });
});
