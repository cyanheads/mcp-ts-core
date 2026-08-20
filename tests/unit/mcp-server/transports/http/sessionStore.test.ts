/**
 * @fileoverview Tests for SessionStore identity binding, capacity, lifecycle,
 * and tenant isolation.
 * @module tests/mcp-server/transports/http/sessionStore.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SessionConnection,
  type SessionIdentity,
  SessionStore,
} from '@/mcp-server/transports/http/sessionStore.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

/**
 * Helper to create valid 64-character hex session IDs for testing.
 * Format matches the output of generateSecureSessionId().
 */
function createTestSessionId(suffix: string): string {
  const hexSuffix = Buffer.from(suffix, 'utf8').toString('hex');
  return hexSuffix.padStart(64, '0').slice(-64);
}

/** A `{ server, transport }` pair whose closes are observable. */
function createTestConnection(): SessionConnection & {
  closes: { server: number; transport: number };
} {
  const closes = { server: 0, transport: 0 };
  return {
    closes,
    server: {
      close: vi.fn(async () => {
        closes.server++;
      }),
    } as unknown as SessionConnection['server'],
    transport: {
      close: vi.fn(async () => {
        closes.transport++;
      }),
    } as unknown as SessionConnection['transport'],
  };
}

describe('SessionStore - Security & Tenant Isolation', () => {
  let store: SessionStore;
  const STALE_TIMEOUT = 30_000; // 30 seconds for testing

  const SESSION_1 = createTestSessionId('1');
  const SESSION_2 = createTestSessionId('2');
  const SESSION_A = createTestSessionId('a');
  const SESSION_B = createTestSessionId('b');

  /** Registers a session with a throwaway connection and returns it. */
  const register = (id: string, identity?: SessionIdentity) => {
    const connection = createTestConnection();
    store.register(id, connection, identity);
    return connection;
  };

  beforeEach(() => {
    store = new SessionStore(STALE_TIMEOUT);
  });

  afterEach(async () => {
    await store.destroy();
    vi.useRealTimers();
  });

  describe('Registration', () => {
    it('makes a registered session reachable and counts it', () => {
      const connection = register(SESSION_1);
      expect(store.getConnection(SESSION_1)).toBe(connection);
      expect(store.getSessionCount()).toBe(1);
    });

    it('rejects a session ID that is not 64 hex characters', () => {
      expect(() => store.register('not-a-session-id', createTestConnection())).toThrow(
        /64 hexadecimal/,
      );
      expect(store.getSessionCount()).toBe(0);
    });

    it('returns undefined for an unknown session', () => {
      expect(store.getConnection(SESSION_1)).toBeUndefined();
    });

    it('refreshes lastAccessedAt on every connection lookup', async () => {
      vi.useFakeTimers();
      register(SESSION_1);

      // Past the stale timeout without a touch, the session would expire.
      vi.advanceTimersByTime(STALE_TIMEOUT - 1);
      expect(store.getConnection(SESSION_1)).toBeDefined();
      vi.advanceTimersByTime(STALE_TIMEOUT - 1);

      // Still valid: the lookup above reset the clock.
      expect(store.isValidForIdentity(SESSION_1)).toBe(true);
    });
  });

  describe('Capacity', () => {
    it('throws ServiceUnavailable once at capacity, before any instance is built', () => {
      const capped = new SessionStore(STALE_TIMEOUT, 1);
      capped.register(SESSION_1, createTestConnection());

      expect(() => capped.assertCapacity()).toThrow(/Maximum session capacity reached \(1\)/);
      try {
        capped.assertCapacity();
      } catch (error) {
        expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      }
      expect(() => capped.register(SESSION_2, createTestConnection())).toThrow(/capacity/);
      expect(capped.getSessionCount()).toBe(1);
    });

    it('accepts a new session again after one is terminated', async () => {
      const capped = new SessionStore(STALE_TIMEOUT, 1);
      capped.register(SESSION_1, createTestConnection());
      await capped.terminate(SESSION_1);

      expect(() => capped.assertCapacity()).not.toThrow();
      capped.register(SESSION_2, createTestConnection());
      expect(capped.getSessionCount()).toBe(1);
      await capped.destroy();
    });
  });

  describe('Termination', () => {
    it('closes both surfaces and makes the session unreachable', async () => {
      const connection = register(SESSION_1);
      await store.terminate(SESSION_1);

      expect(connection.closes).toEqual({ server: 1, transport: 1 });
      expect(store.getConnection(SESSION_1)).toBeUndefined();
      expect(store.isValidForIdentity(SESSION_1)).toBe(false);
      expect(store.getSessionCount()).toBe(0);
    });

    it('is idempotent — the SDK transport also calls it via onsessionclosed', async () => {
      const connection = register(SESSION_1);
      await store.terminate(SESSION_1);
      await store.terminate(SESSION_1);

      expect(connection.closes).toEqual({ server: 1, transport: 1 });
    });

    it('terminates a session whose transport close rejects', async () => {
      const connection = createTestConnection();
      (connection.transport.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('already closed'),
      );
      store.register(SESSION_1, connection);

      await expect(store.terminate(SESSION_1)).resolves.toBeUndefined();
      expect(store.getConnection(SESSION_1)).toBeUndefined();
    });

    it('destroy() closes every live connection', async () => {
      const a = register(SESSION_A);
      const b = register(SESSION_B);

      await store.destroy();

      expect(a.closes).toEqual({ server: 1, transport: 1 });
      expect(b.closes).toEqual({ server: 1, transport: 1 });
      expect(store.getSessionCount()).toBe(0);
    });
  });

  describe('Identity Binding', () => {
    it('binds identity at registration', () => {
      register(SESSION_1, { tenantId: 'tenant-a', clientId: 'client-1', subject: 'user-1' });

      expect(
        store.isValidForIdentity(SESSION_1, {
          tenantId: 'tenant-a',
          clientId: 'client-1',
          subject: 'user-1',
        }),
      ).toBe(true);
    });

    it('registers without identity (no-auth mode)', () => {
      register(SESSION_1);
      expect(store.isValidForIdentity(SESSION_1)).toBe(true);
    });

    it('lazy-binds identity on the first authenticated request', () => {
      register(SESSION_1);

      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a' })).toBe(true);
      // Bound now — a different tenant can no longer reach it.
      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-b' })).toBe(false);
    });

    it('does not rebind identity once set', () => {
      register(SESSION_1, { tenantId: 'tenant-a' });

      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-b' })).toBe(false);
      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a' })).toBe(true);
    });
  });

  describe('Tenant Isolation - Security', () => {
    it('accepts the bound tenant', () => {
      register(SESSION_1, { tenantId: 'tenant-a' });
      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a' })).toBe(true);
    });

    it('REJECTS session reuse across different tenants (CRITICAL)', () => {
      register(SESSION_1, { tenantId: 'tenant-a', clientId: 'client-1' });

      expect(
        store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-b', clientId: 'client-1' }),
      ).toBe(false);
    });

    it('REJECTS session reuse across different clients', () => {
      register(SESSION_1, { tenantId: 'tenant-a', clientId: 'client-1' });

      expect(
        store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a', clientId: 'client-2' }),
      ).toBe(false);
    });

    it('allows an unbound session in no-auth mode', () => {
      register(SESSION_1);
      expect(store.isValidForIdentity(SESSION_1)).toBe(true);
      expect(store.isValidForIdentity(SESSION_1, undefined)).toBe(true);
    });

    it('REJECTS an unauthenticated request for a bound session', () => {
      register(SESSION_1, { tenantId: 'tenant-a' });
      expect(store.isValidForIdentity(SESSION_1, undefined)).toBe(false);
    });
  });

  describe('Subject Isolation', () => {
    it('REJECTS session reuse across different subjects', () => {
      register(SESSION_1, { tenantId: 'tenant-a', subject: 'user-1' });

      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a', subject: 'user-2' })).toBe(
        false,
      );
    });

    it('accepts the same subject for a bound session', () => {
      register(SESSION_1, { tenantId: 'tenant-a', subject: 'user-1' });

      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a', subject: 'user-1' })).toBe(
        true,
      );
    });

    it('validates when only subject is set', () => {
      register(SESSION_1, { subject: 'user-1' });

      expect(store.isValidForIdentity(SESSION_1, { subject: 'user-1' })).toBe(true);
      expect(store.isValidForIdentity(SESSION_1, { subject: 'user-2' })).toBe(false);
    });

    it('REJECTS an unauthenticated request for a subject-bound session', () => {
      register(SESSION_1, { subject: 'user-1' });
      expect(store.isValidForIdentity(SESSION_1, undefined)).toBe(false);
    });
  });

  describe('Partial Identity Matching', () => {
    it('validates when only tenantId is set', () => {
      register(SESSION_1, { tenantId: 'tenant-a' });

      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a' })).toBe(true);
      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a', clientId: 'any' })).toBe(
        true,
      );
    });

    it('validates when only clientId is set', () => {
      register(SESSION_1, { clientId: 'client-1' });

      expect(store.isValidForIdentity(SESSION_1, { clientId: 'client-1' })).toBe(true);
      expect(store.isValidForIdentity(SESSION_1, { clientId: 'client-2' })).toBe(false);
    });
  });

  describe('Staleness & Cleanup', () => {
    it('invalidates and tears down a stale session on validation', async () => {
      vi.useFakeTimers();
      const connection = register(SESSION_1);

      vi.advanceTimersByTime(STALE_TIMEOUT + 1);

      expect(store.isValidForIdentity(SESSION_1)).toBe(false);
      await vi.runOnlyPendingTimersAsync();
      expect(store.getConnection(SESSION_1)).toBeUndefined();
      expect(connection.closes.transport).toBe(1);
    });

    it('invalidates a stale session even when the identity matches', async () => {
      vi.useFakeTimers();
      register(SESSION_1, { tenantId: 'tenant-a' });

      vi.advanceTimersByTime(STALE_TIMEOUT + 1);

      expect(store.isValidForIdentity(SESSION_1, { tenantId: 'tenant-a' })).toBe(false);
    });

    it('evicts stale sessions on the scheduled cleanup interval', async () => {
      // The interval is created in the constructor, so the clock has to be
      // faked before the store exists for the sweep to be drivable.
      vi.useFakeTimers();
      const scheduled = new SessionStore(STALE_TIMEOUT);
      const connection = createTestConnection();
      scheduled.register(SESSION_1, connection);
      expect(scheduled.getSessionCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(STALE_TIMEOUT + 60_001);

      expect(scheduled.getSessionCount()).toBe(0);
      expect(connection.closes).toEqual({ server: 1, transport: 1 });
      await scheduled.destroy();
    });
  });

  describe('Multi-Tenant Scenarios', () => {
    it('isolates sessions across multiple tenants', () => {
      register(SESSION_A, { tenantId: 'tenant-a', clientId: 'client-a' });
      register(SESSION_B, { tenantId: 'tenant-b', clientId: 'client-b' });

      expect(
        store.isValidForIdentity(SESSION_A, { tenantId: 'tenant-a', clientId: 'client-a' }),
      ).toBe(true);
      expect(
        store.isValidForIdentity(SESSION_B, { tenantId: 'tenant-b', clientId: 'client-b' }),
      ).toBe(true);

      // Cross-tenant access is refused in both directions.
      expect(
        store.isValidForIdentity(SESSION_A, { tenantId: 'tenant-b', clientId: 'client-b' }),
      ).toBe(false);
      expect(
        store.isValidForIdentity(SESSION_B, { tenantId: 'tenant-a', clientId: 'client-a' }),
      ).toBe(false);
    });
  });
});
