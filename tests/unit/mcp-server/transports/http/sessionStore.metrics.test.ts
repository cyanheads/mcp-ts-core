/**
 * @fileoverview Tests that SessionStore records the `mcp.sessions.events` counter
 * with the correct `mcp.session.event` attribute for each lifecycle event.
 * @module tests/unit/mcp-server/transports/http/sessionStore.metrics.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock captures — must precede source imports
const mockCounterAdd = vi.fn();

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn(() => ({ add: mockCounterAdd })),
  createHistogram: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock('@/mcp-server/transports/http/sessionIdUtils.js', () => ({
  validateSessionIdFormat: vi.fn(() => true),
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: {
    createRequestContext: vi.fn((ctx: Record<string, unknown>) => ({
      requestId: 'req-test',
      timestamp: '2026-01-01T00:00:00Z',
      ...ctx,
    })),
  },
}));

import { type SessionConnection, SessionStore } from '@/mcp-server/transports/http/sessionStore.js';

/** Valid 64-character hex session ID for all tests. */
const SESSION_ID = 'a'.repeat(64);

/** A `{ server, transport }` pair with inert closes. */
function connection(): SessionConnection {
  return {
    server: { close: vi.fn(async () => {}) },
    transport: { close: vi.fn(async () => {}) },
  } as unknown as SessionConnection;
}

describe('SessionStore — mcp.sessions.events counter', () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SessionStore(60_000);
  });

  afterEach(async () => {
    await store.destroy();
  });

  it('records "created" when a session is registered', () => {
    store.register(SESSION_ID, connection());

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.session.event': 'created',
    });
  });

  it('does NOT record an event when an existing session is looked up', () => {
    store.register(SESSION_ID, connection());
    mockCounterAdd.mockClear();

    store.getConnection(SESSION_ID);

    expect(mockCounterAdd).not.toHaveBeenCalled();
  });

  it('records "terminated" when an existing session is terminated', async () => {
    store.register(SESSION_ID, connection());
    mockCounterAdd.mockClear();

    await store.terminate(SESSION_ID);

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.session.event': 'terminated',
    });
  });

  it('does NOT record "terminated" when terminating a non-existent session', async () => {
    await store.terminate(SESSION_ID);

    // The only call should NOT be 'terminated' — no call at all
    expect(mockCounterAdd).not.toHaveBeenCalledWith(1, {
      'mcp.session.event': 'terminated',
    });
  });

  it('records "rejected" on identity mismatch (tenant)', () => {
    store.register(SESSION_ID, connection(), {
      tenantId: 'tenant-a',
      clientId: 'client-1',
      subject: 'user-1',
    });
    mockCounterAdd.mockClear();

    const valid = store.isValidForIdentity(SESSION_ID, {
      tenantId: 'tenant-DIFFERENT',
      clientId: 'client-1',
      subject: 'user-1',
    });

    expect(valid).toBe(false);
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.session.event': 'rejected',
    });
  });

  it('records "rejected" on identity mismatch (client)', () => {
    store.register(SESSION_ID, connection(), {
      tenantId: 'tenant-a',
      clientId: 'client-1',
      subject: 'user-1',
    });
    mockCounterAdd.mockClear();

    const valid = store.isValidForIdentity(SESSION_ID, {
      tenantId: 'tenant-a',
      clientId: 'client-DIFFERENT',
      subject: 'user-1',
    });

    expect(valid).toBe(false);
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.session.event': 'rejected',
    });
  });

  it('records "rejected" when session has identity but request has none', () => {
    store.register(SESSION_ID, connection(), {
      tenantId: 'tenant-a',
      clientId: 'client-1',
    });
    mockCounterAdd.mockClear();

    const valid = store.isValidForIdentity(SESSION_ID, undefined);

    expect(valid).toBe(false);
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.session.event': 'rejected',
    });
  });

  it('does NOT record an event when isValidForIdentity succeeds', () => {
    const identity = { tenantId: 'tenant-a', clientId: 'client-1', subject: 'user-1' };
    store.register(SESSION_ID, connection(), identity);
    mockCounterAdd.mockClear();

    const valid = store.isValidForIdentity(SESSION_ID, identity);

    expect(valid).toBe(true);
    expect(mockCounterAdd).not.toHaveBeenCalled();
  });
});
