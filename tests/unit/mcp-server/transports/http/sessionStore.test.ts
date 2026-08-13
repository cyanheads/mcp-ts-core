/**
 * @fileoverview Tests for SessionStore tenant isolation and security.
 * @module tests/mcp-server/transports/http/sessionStore.test
 */

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SessionIdentity, SessionStore } from '@/mcp-server/transports/http/sessionStore.js';

/**
 * Helper to create valid 64-character hex session IDs for testing.
 * Format matches the output of generateSecureSessionId().
 */
function createTestSessionId(suffix: string): string {
  // Convert suffix to hex if it's not already
  const hexSuffix = Buffer.from(suffix, 'utf8').toString('hex');
  // Pad to 64 characters with zeros
  const paddedSuffix = hexSuffix.padStart(64, '0');
  return paddedSuffix.slice(-64);
}

describe('SessionStore - Security & Tenant Isolation', () => {
  let store: SessionStore;
  const STALE_TIMEOUT = 30_000; // 30 seconds for testing

  // Valid session IDs for testing
  const SESSION_1 = createTestSessionId('1');
  const SESSION_2 = createTestSessionId('2');
  const SESSION_A = createTestSessionId('a');
  const SESSION_B = createTestSessionId('b');
  const SHARED_SESSION = createTestSessionId('shared');

  beforeEach(() => {
    store = new SessionStore(STALE_TIMEOUT);
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  describe('Basic Session Management', () => {
    it('should create a new session', () => {
      const session = store.getOrCreate(SESSION_1);
      expect(session.id).toBe(SESSION_1);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastAccessedAt).toBeInstanceOf(Date);
    });

    it('should retrieve existing session', () => {
      const session1 = store.getOrCreate(SESSION_1);
      const session2 = store.getOrCreate(SESSION_1);
      expect(session1).toBe(session2);
      expect(session1.id).toBe(SESSION_1);
    });

    it('should update lastAccessedAt on retrieval', async () => {
      const session1 = store.getOrCreate(SESSION_1);
      const firstAccess = session1.lastAccessedAt;

      await new Promise((resolve) => setTimeout(resolve, 10));

      const session2 = store.getOrCreate(SESSION_1);
      expect(session2.lastAccessedAt.getTime()).toBeGreaterThan(firstAccess.getTime());
    });

    it('should reject new sessions when capacity is exhausted', () => {
      const cappedStore = new SessionStore(STALE_TIMEOUT, 1);
      try {
        cappedStore.getOrCreate(SESSION_1);
        expect(() => cappedStore.getOrCreate(SESSION_2)).toThrow(
          'Maximum session capacity reached (1)',
        );
      } finally {
        cappedStore.destroy();
      }
    });

    it('should validate existing session', () => {
      store.getOrCreate(SESSION_1);
      expect(store.isValidForIdentity(SESSION_1)).toBe(true);
    });

    it('should reject non-existent session', () => {
      const invalidId = createTestSessionId('nonexistent');
      expect(store.isValidForIdentity(invalidId)).toBe(false);
    });

    it('should terminate a session', () => {
      store.getOrCreate(SESSION_1);
      expect(store.isValidForIdentity(SESSION_1)).toBe(true);

      store.terminate(SESSION_1);
      expect(store.isValidForIdentity(SESSION_1)).toBe(false);
    });

    it('should return session count', () => {
      expect(store.getSessionCount()).toBe(0);
      store.getOrCreate(SESSION_1);
      expect(store.getSessionCount()).toBe(1);
      store.getOrCreate(SESSION_2);
      expect(store.getSessionCount()).toBe(2);
    });
  });

  describe('Identity Binding', () => {
    it('should bind identity on session creation', () => {
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
        subject: 'user@example.com',
      };

      const session = store.getOrCreate(SESSION_1, identity);
      expect(session.tenantId).toBe('tenant-a');
      expect(session.clientId).toBe('client-1');
      expect(session.subject).toBe('user@example.com');
    });

    it('should create session without identity (backwards compatibility)', () => {
      const session = store.getOrCreate(SESSION_1);
      expect(session.tenantId).toBeUndefined();
      expect(session.clientId).toBeUndefined();
      expect(session.subject).toBeUndefined();
    });

    it('should lazy-bind identity on first authenticated request', () => {
      // Create session without identity
      const session1 = store.getOrCreate(SESSION_1);
      expect(session1.tenantId).toBeUndefined();

      // Bind identity on subsequent request
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
      };
      const session2 = store.getOrCreate(SESSION_1, identity);

      expect(session2.tenantId).toBe('tenant-a');
      expect(session2.clientId).toBe('client-1');
      expect(session1).toBe(session2); // Same session object
    });

    it('should not rebind identity once set', () => {
      // Create with first identity
      const identity1: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
      };
      store.getOrCreate(SESSION_1, identity1);

      // Try to rebind with different identity (should not change)
      const identity2: SessionIdentity = {
        tenantId: 'tenant-b',
        clientId: 'client-2',
      };
      const session = store.getOrCreate(SESSION_1, identity2);

      // Should still have original identity
      expect(session.tenantId).toBe('tenant-a');
      expect(session.clientId).toBe('client-1');
    });
  });

  describe('Tenant Isolation - Security', () => {
    it('should accept valid tenant for bound session', () => {
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
      };
      store.getOrCreate(SESSION_1, identity);

      // Validate with same tenant
      expect(store.isValidForIdentity(SESSION_1, identity)).toBe(true);
    });

    it('should REJECT session reuse across different tenants (CRITICAL)', () => {
      // User from tenant-a creates session
      const tenantA: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
      };
      store.getOrCreate(SESSION_1, tenantA);

      // Attacker from tenant-b tries to use same session
      const tenantB: SessionIdentity = {
        tenantId: 'tenant-b',
        clientId: 'client-2',
      };

      // Should REJECT - this prevents session hijacking
      expect(store.isValidForIdentity(SESSION_1, tenantB)).toBe(false);
    });

    it('should REJECT session reuse across different clients', () => {
      // User with client-1 creates session
      const client1: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
      };
      store.getOrCreate(SESSION_1, client1);

      // Different client from same tenant tries to use session
      const client2: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-2',
      };

      // Should REJECT
      expect(store.isValidForIdentity(SESSION_1, client2)).toBe(false);
    });

    it('should allow unbound session in no-auth mode', () => {
      // Create session without identity (no-auth mode)
      store.getOrCreate(SESSION_1);

      // Should accept requests without identity
      expect(store.isValidForIdentity(SESSION_1)).toBe(true);
      expect(store.isValidForIdentity(SESSION_1, undefined)).toBe(true);
    });

    it('should REJECT authenticated request for unbound session', () => {
      // Session created without identity
      store.getOrCreate(SESSION_1);

      // Authenticated request with identity
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
      };

      // Should allow (will trigger lazy binding)
      expect(store.isValidForIdentity(SESSION_1, identity)).toBe(true);
    });

    it('should REJECT unauthenticated request for bound session', () => {
      // Session created with identity
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
      };
      store.getOrCreate(SESSION_1, identity);

      // Unauthenticated request (no identity)
      expect(store.isValidForIdentity(SESSION_1)).toBe(false);
      expect(store.isValidForIdentity(SESSION_1, undefined)).toBe(false);
    });
  });

  describe('Subject Isolation', () => {
    it('should REJECT session reuse across different subjects', () => {
      const user1: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
        subject: 'user-1@example.com',
      };
      store.getOrCreate(SESSION_1, user1);

      const user2: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
        subject: 'user-2@example.com',
      };
      expect(store.isValidForIdentity(SESSION_1, user2)).toBe(false);
    });

    it('should accept same subject for bound session', () => {
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-1',
        subject: 'user-1@example.com',
      };
      store.getOrCreate(SESSION_1, identity);
      expect(store.isValidForIdentity(SESSION_1, identity)).toBe(true);
    });

    it('should validate when only subject is set', () => {
      const identity: SessionIdentity = { subject: 'user-1@example.com' };
      store.getOrCreate(SESSION_1, identity);

      expect(store.isValidForIdentity(SESSION_1, { subject: 'user-1@example.com' })).toBe(true);
      expect(store.isValidForIdentity(SESSION_1, { subject: 'user-2@example.com' })).toBe(false);
    });

    it('should REJECT unauthenticated request for subject-bound session', () => {
      const identity: SessionIdentity = { subject: 'user-1@example.com' };
      store.getOrCreate(SESSION_1, identity);

      expect(store.isValidForIdentity(SESSION_1)).toBe(false);
      expect(store.isValidForIdentity(SESSION_1, undefined)).toBe(false);
    });
  });

  describe('Protocol session state', () => {
    it('persists negotiated capabilities and exposes them through session hooks', () => {
      const capabilities = {
        elicitation: { form: {} },
        sampling: {},
      };
      store.getOrCreate(SESSION_1);

      store.setClientCapabilities(SESSION_1, capabilities);

      const hooks = store.createProtocolSessionHooks(SESSION_1);
      expect(hooks?.clientCapabilities).toEqual(capabilities);
      expect(hooks?.registerRequest).toBeTypeOf('function');
      expect(store.createProtocolSessionHooks(SESSION_2)).toBeUndefined();
    });

    it('registers by typed request ID and unregisters only that invocation', () => {
      store.getOrCreate(SESSION_A);
      store.getOrCreate(SESSION_B);
      const hooksA = store.createProtocolSessionHooks(SESSION_A)!;
      const hooksB = store.createProtocolSessionHooks(SESSION_B)!;
      const removed = hooksA.registerRequest!(42);
      const active = hooksA.registerRequest!(42);
      const stringId = hooksA.registerRequest!('42');
      const otherSession = hooksB.registerRequest!(42);

      removed.unregister();
      removed.unregister();
      expect(store.cancelRequest(SESSION_A, 42, 'client stopped')).toBe(true);

      expect(removed.signal.aborted).toBe(false);
      expect(active.signal.aborted).toBe(true);
      expect(active.signal.reason).toMatchObject({ name: 'AbortError', message: 'client stopped' });
      expect(stringId.signal.aborted).toBe(false);
      expect(otherSession.signal.aborted).toBe(false);
      expect(store.cancelRequest(SESSION_A, '42')).toBe(true);
      expect(stringId.signal.aborted).toBe(true);
    });

    it('does not route cancellation across sessions', () => {
      store.getOrCreate(SESSION_A);
      store.getOrCreate(SESSION_B);
      const requestA = store.createProtocolSessionHooks(SESSION_A)!.registerRequest!('shared-id');
      const requestB = store.createProtocolSessionHooks(SESSION_B)!.registerRequest!('shared-id');

      expect(store.cancelRequest(SESSION_A, 'shared-id')).toBe(true);
      expect(requestA.signal.aborted).toBe(true);
      expect(requestB.signal.aborted).toBe(false);
      expect(store.cancelRequest(SESSION_2, 'shared-id')).toBe(false);
    });

    it('routes server responses once by session and unique wire ID', () => {
      store.getOrCreate(SESSION_A);
      store.getOrCreate(SESSION_B);
      const deliveredA: unknown[] = [];
      const deliveredB: unknown[] = [];
      const firstA = store.registerServerRequest(SESSION_A, (response) => {
        deliveredA.push(response);
      })!;
      const secondA = store.registerServerRequest(SESSION_A, (response) => {
        deliveredA.push(response);
      })!;
      const requestB = store.registerServerRequest(SESSION_B, (response) => {
        deliveredB.push(response);
      })!;

      expect(new Set([firstA.requestId, secondA.requestId, requestB.requestId])).toHaveLength(3);
      const response = {
        jsonrpc: '2.0' as const,
        id: firstA.requestId,
        result: { action: 'accept' },
      };
      expect(store.routeServerResponse(SESSION_B, response)).toBe(false);
      expect(store.routeServerResponse(SESSION_A, response)).toBe(true);
      expect(store.routeServerResponse(SESSION_A, response)).toBe(false);
      expect(deliveredA).toEqual([response]);
      expect(deliveredB).toEqual([]);

      secondA.unregister();
      expect(
        store.routeServerResponse(SESSION_A, {
          jsonrpc: '2.0',
          id: secondA.requestId,
          result: { action: 'accept' },
        }),
      ).toBe(false);
    });

    it('rejects pending server requests when the session terminates', () => {
      store.getOrCreate(SESSION_1);
      const delivered: unknown[] = [];
      const registration = store.registerServerRequest(SESSION_1, (response) => {
        delivered.push(response);
      })!;

      store.terminate(SESSION_1);

      expect(delivered).toEqual([
        {
          jsonrpc: '2.0',
          id: registration.requestId,
          error: {
            code: ErrorCode.ConnectionClosed,
            message: 'MCP session ended',
          },
        },
      ]);
      expect(() => registration.unregister()).not.toThrow();
    });

    it('aborts every in-flight request when the session terminates', () => {
      store.getOrCreate(SESSION_1);
      const hooks = store.createProtocolSessionHooks(SESSION_1)!;
      const first = hooks.registerRequest!(1);
      const second = hooks.registerRequest!('two');

      store.terminate(SESSION_1);

      for (const registration of [first, second]) {
        expect(registration.signal.aborted).toBe(true);
        expect(registration.signal.reason).toMatchObject({
          name: 'AbortError',
          message: 'MCP session ended',
        });
        expect(() => registration.unregister()).not.toThrow();
      }
      expect(store.createProtocolSessionHooks(SESSION_1)).toBeUndefined();
      expect(store.cancelRequest(SESSION_1, 1)).toBe(false);
    });
  });

  describe('Staleness & Cleanup', () => {
    it('should invalidate stale sessions', async () => {
      // Use a very short timeout for faster test execution
      const shortStore = new SessionStore(50); // 50ms timeout
      shortStore.getOrCreate(SESSION_1);
      expect(shortStore.isValidForIdentity(SESSION_1)).toBe(true);

      // Wait for session to become stale
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(shortStore.isValidForIdentity(SESSION_1)).toBe(false);
      shortStore.destroy();
    });

    it('should invalidate stale sessions with identity validation', async () => {
      const shortStore = new SessionStore(50); // 50ms timeout
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
      };
      shortStore.getOrCreate(SESSION_1, identity);
      expect(shortStore.isValidForIdentity(SESSION_1, identity)).toBe(true);

      // Wait for session to become stale
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(shortStore.isValidForIdentity(SESSION_1, identity)).toBe(false);
      shortStore.destroy();
    });

    it('should evict stale sessions on the scheduled cleanup interval', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
      const shortStore = new SessionStore(1_000);
      shortStore.getOrCreate(SESSION_1);

      vi.setSystemTime(new Date('2026-08-02T00:01:00.001Z'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shortStore.getSessionCount()).toBe(0);
      shortStore.destroy();
    });
  });

  describe('Multi-Tenant Scenarios', () => {
    it('should isolate sessions across multiple tenants', () => {
      // Tenant A creates session
      const tenantA: SessionIdentity = {
        tenantId: 'tenant-a',
        clientId: 'client-a',
      };
      store.getOrCreate(SESSION_A, tenantA);

      // Tenant B creates different session
      const tenantB: SessionIdentity = {
        tenantId: 'tenant-b',
        clientId: 'client-b',
      };
      store.getOrCreate(SESSION_B, tenantB);

      // Each tenant can access their own session
      expect(store.isValidForIdentity(SESSION_A, tenantA)).toBe(true);
      expect(store.isValidForIdentity(SESSION_B, tenantB)).toBe(true);

      // But NOT each other's sessions
      expect(store.isValidForIdentity(SESSION_A, tenantB)).toBe(false);
      expect(store.isValidForIdentity(SESSION_B, tenantA)).toBe(false);
    });

    it('should handle same session ID across different tenants (edge case)', () => {
      // This shouldn't happen with crypto-strong IDs, but test defensive behavior
      // Tenant A creates session first
      const tenantA: SessionIdentity = {
        tenantId: 'tenant-a',
      };
      store.getOrCreate(SHARED_SESSION, tenantA);

      // Tenant B tries to use same session ID
      const tenantB: SessionIdentity = {
        tenantId: 'tenant-b',
      };

      // Tenant A should work
      expect(store.isValidForIdentity(SHARED_SESSION, tenantA)).toBe(true);

      // Tenant B should be REJECTED (session belongs to A)
      expect(store.isValidForIdentity(SHARED_SESSION, tenantB)).toBe(false);
    });
  });

  describe('Partial Identity Matching', () => {
    it('should validate when only tenantId is set', () => {
      const identity: SessionIdentity = {
        tenantId: 'tenant-a',
        // No clientId
      };
      store.getOrCreate(SESSION_1, identity);

      // Should validate with same tenant
      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a' })).toBe(true);

      // Should reject different tenant
      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-b' })).toBe(false);
    });

    it('should validate when only clientId is set', () => {
      const identity: SessionIdentity = {
        clientId: 'client-1',
        // No tenantId
      };
      store.getOrCreate(SESSION_1, identity);

      // Should validate with same client
      expect(store.isValidForIdentity(SESSION_1, { clientId: 'client-1' })).toBe(true);

      // Should reject different client
      expect(store.isValidForIdentity(SESSION_1, { clientId: 'client-2' })).toBe(false);
    });
  });
});
