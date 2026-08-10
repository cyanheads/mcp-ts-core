/**
 * @fileoverview Hermetic loopback OIDC/JWKS fixture for real OAuth integration tests.
 * @module tests/helpers/oauth-jwks-fixture
 */
import { createServer, type Server, type ServerResponse } from 'node:http';

import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

type JosePrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

/** A signing key the fixture publishes on its JWKS endpoint and signs tokens with. */
export interface OAuthSigningKey {
  alg: 'ES256' | 'RS256';
  kid: string;
  privateKey: JosePrivateKey;
  publicJwk: JWK;
}

/** Per-token overrides for the fixture's default issuer, audience, resource, lifetime, and claims. */
export interface OAuthTokenOptions {
  audience?: string | string[];
  claims?: Record<string, unknown>;
  expiresInSeconds?: number;
  issuer?: string;
  resource?: string | string[];
}

type FixtureMode = 'healthy' | 'outage' | 'timeout';

/** Control surface for the running loopback issuer: key material, JWKS behavior, and request counts. */
export interface OAuthJwksFixture {
  close: () => Promise<void>;
  createSigningKey: (alg: OAuthSigningKey['alg'], kid: string) => Promise<OAuthSigningKey>;
  discoveryUrl: string;
  getJwksRequestCount: () => number;
  issuer: string;
  issueToken: (key: OAuthSigningKey, options?: OAuthTokenOptions) => Promise<string>;
  jwksUrl: string;
  resetJwksRequestCount: () => void;
  setDelay: (delayMs: number) => void;
  setJwks: (keys: OAuthSigningKey[]) => void;
  setMode: (mode: FixtureMode) => void;
}

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('OIDC fixture did not receive a TCP port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Starts a loopback HTTP server serving OIDC discovery and JWKS documents.
 * The caller owns the returned fixture and must `close()` it.
 */
export async function createOAuthJwksFixture(): Promise<OAuthJwksFixture> {
  let issuer = '';
  let jwks: JWK[] = [];
  let jwksRequestCount = 0;
  let delayMs = 0;
  let mode: FixtureMode = 'healthy';
  const pending = new Set<ServerResponse>();
  const delayedSends = new Set<ReturnType<typeof setTimeout>>();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer || 'http://127.0.0.1');
    if (url.pathname === '/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` }));
      return;
    }

    if (url.pathname !== '/.well-known/jwks.json') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    jwksRequestCount += 1;
    if (mode === 'timeout') {
      pending.add(response);
      response.once('close', () => pending.delete(response));
      return;
    }
    if (mode === 'outage') {
      response.statusCode = 503;
      response.end('fixture outage');
      return;
    }

    const send = () => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: jwks }));
    };
    if (delayMs > 0) {
      const handle = setTimeout(() => {
        delayedSends.delete(handle);
        send();
      }, delayMs);
      delayedSends.add(handle);
    } else send();
  });

  const port = await listen(server);
  issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    async createSigningKey(alg, kid) {
      const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
      const publicJwk = await exportJWK(publicKey);
      publicJwk.alg = alg;
      publicJwk.kid = kid;
      publicJwk.use = 'sig';
      return { alg, kid, privateKey, publicJwk };
    },
    async issueToken(key, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        cid: 'oauth-client',
        scp: ['tool:echo:read'],
        sub: 'oauth-user',
        tid: 'oauth-tenant',
        resource: options.resource ?? 'https://resource.example.test/mcp',
        ...options.claims,
      };
      return await new SignJWT(payload)
        .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? 'mcp-audience')
        .setIssuedAt(now)
        .setExpirationTime(now + (options.expiresInSeconds ?? 300))
        .sign(key.privateKey);
    },
    setJwks(keys) {
      jwks = keys.map((key) => key.publicJwk);
    },
    setMode(nextMode) {
      mode = nextMode;
    },
    setDelay(nextDelayMs) {
      delayMs = nextDelayMs;
    },
    getJwksRequestCount: () => jwksRequestCount,
    resetJwksRequestCount() {
      jwksRequestCount = 0;
    },
    async close() {
      for (const handle of delayedSends) clearTimeout(handle);
      delayedSends.clear();
      for (const response of pending) response.destroy();
      pending.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
