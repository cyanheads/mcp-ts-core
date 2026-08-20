/**
 * @fileoverview Property-based security coverage for HTTP session identity
 * binding, capacity, and staleness expiry.
 * @module tests/fuzz/session-store.fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { type SessionConnection, SessionStore } from '@/mcp-server/transports/http/sessionStore.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

/**
 * The protocol pair a session holds, reduced to what the store touches: a
 * `close()` on each half, counted so double-close regressions surface.
 */
interface FakeConnection extends SessionConnection {
  closes: { server: number; transport: number };
}

function fakeConnection(): FakeConnection {
  const closes = { server: 0, transport: 0 };
  return {
    closes,
    server: {
      close: vi.fn(async () => {
        closes.server += 1;
      }),
    },
    transport: {
      close: vi.fn(async () => {
        closes.transport += 1;
      }),
    },
  } as unknown as FakeConnection;
}

const hexIdArbitrary = fc
  .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 })
  .map((characters) => characters.join(''));

const identityArbitrary = fc.record({
  tenantId: fc.string({ minLength: 1, maxLength: 40 }),
  clientId: fc.string({ minLength: 1, maxLength: 40 }),
  subject: fc.string({ minLength: 1, maxLength: 80 }),
});

/** Lets the fire-and-forget `terminate()` inside `isValidForIdentity` settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SessionStore fuzzing', () => {
  it('accepts valid IDs only for the identity snapshot that created them', () => {
    fc.assert(
      fc.property(hexIdArbitrary, identityArbitrary, (sessionId, identity) => {
        const store = new SessionStore(30_000);
        try {
          store.register(sessionId, fakeConnection(), identity);
          expect(store.isValidForIdentity(sessionId, identity)).toBe(true);
          expect(
            store.isValidForIdentity(sessionId, {
              ...identity,
              tenantId: `${identity.tenantId}-other`,
            }),
          ).toBe(false);
          // An identity-bound session is never reachable without an identity.
          expect(store.isValidForIdentity(sessionId)).toBe(false);
        } finally {
          void store.destroy();
        }
      }),
      { numRuns: 100, seed: 20_260_805 },
    );
  });

  it('rejects arbitrary non-session strings with InvalidParams', () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => !/^[a-f0-9]{64}$/.test(value)),
        (sessionId) => {
          const store = new SessionStore(30_000);
          try {
            const connection = fakeConnection();
            expect(() => store.register(sessionId, connection)).toThrowError(McpError);
            try {
              store.register(sessionId, connection);
            } catch (error) {
              expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
            }
            expect(store.getSessionCount()).toBe(0);
          } finally {
            void store.destroy();
          }
        },
      ),
      { numRuns: 100, seed: 20_260_806 },
    );
  });

  it('never registers past the configured capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.uniqueArray(hexIdArbitrary, { minLength: 8, maxLength: 12 }),
        (maxSessions, sessionIds) => {
          const store = new SessionStore(30_000, maxSessions);
          try {
            let rejected = 0;
            for (const sessionId of sessionIds) {
              try {
                store.register(sessionId, fakeConnection());
              } catch (error) {
                expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
                rejected += 1;
              }
              expect(store.getSessionCount()).toBeLessThanOrEqual(maxSessions);
            }
            expect(store.getSessionCount()).toBe(maxSessions);
            expect(rejected).toBe(sessionIds.length - maxSessions);
          } finally {
            void store.destroy();
          }
        },
      ),
      { numRuns: 60, seed: 20_260_807 },
    );
  });

  it('expires a stale session and closes its connection exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(hexIdArbitrary, identityArbitrary, async (sessionId, identity) => {
        const store = new SessionStore(1);
        const connection = fakeConnection();
        try {
          store.register(sessionId, connection, identity);
          await new Promise((resolve) => setTimeout(resolve, 5));

          expect(store.isValidForIdentity(sessionId, identity)).toBe(false);
          await settle();
          expect(store.getSessionCount()).toBe(0);
          expect(store.getConnection(sessionId)).toBeUndefined();
          expect(connection.closes).toEqual({ server: 1, transport: 1 });
        } finally {
          await store.destroy();
        }
        // destroy() must not re-close a session it already terminated.
        expect(connection.closes).toEqual({ server: 1, transport: 1 });
      }),
      { numRuns: 25, seed: 20_260_808 },
    );
  });
});
