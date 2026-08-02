/**
 * @fileoverview Property-based security coverage for HTTP session identity binding.
 * @module tests/fuzz/session-store.fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '@/mcp-server/transports/http/sessionStore.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

const hexIdArbitrary = fc
  .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 })
  .map((characters) => characters.join(''));

const identityArbitrary = fc.record({
  tenantId: fc.string({ minLength: 1, maxLength: 40 }),
  clientId: fc.string({ minLength: 1, maxLength: 40 }),
  subject: fc.string({ minLength: 1, maxLength: 80 }),
});

describe('SessionStore fuzzing', () => {
  it('accepts valid IDs only for the identity snapshot that created them', () => {
    fc.assert(
      fc.property(hexIdArbitrary, identityArbitrary, (sessionId, identity) => {
        const store = new SessionStore(30_000);
        try {
          store.getOrCreate(sessionId, identity);
          expect(store.isValidForIdentity(sessionId, identity)).toBe(true);
          expect(
            store.isValidForIdentity(sessionId, {
              ...identity,
              tenantId: `${identity.tenantId}-other`,
            }),
          ).toBe(false);
        } finally {
          store.destroy();
        }
      }),
      { numRuns: 100, seed: 20_260_805 },
    );
  });

  it('rejects arbitrary non-session strings with InvalidParams', () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => !/^[a-f0-9]{64}$/i.test(value)),
        (sessionId) => {
          const store = new SessionStore(30_000);
          try {
            expect(() => store.getOrCreate(sessionId)).toThrowError(McpError);
            try {
              store.getOrCreate(sessionId);
            } catch (error) {
              expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
            }
          } finally {
            store.destroy();
          }
        },
      ),
      { numRuns: 100, seed: 20_260_806 },
    );
  });
});
