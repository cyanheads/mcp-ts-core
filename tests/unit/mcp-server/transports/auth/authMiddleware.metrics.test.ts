/**
 * @fileoverview Tests that the auth middleware records `mcp.auth.attempts` counter
 * and `mcp.auth.duration` histogram with the correct outcome and failure reason attributes.
 * @module tests/unit/mcp-server/transports/auth/authMiddleware.metrics.test
 */
import type { Context, Next } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTR_MCP_AUTH_SCOPES,
  ATTR_MCP_AUTH_SUBJECT,
  ATTR_MCP_CLIENT_ID,
  ATTR_MCP_TENANT_ID,
} from '@/utils/telemetry/attributes.js';

// Shared mock captures — must precede source imports
const mockCounterAdd = vi.fn();
const mockHistogramRecord = vi.fn();
const mockSpanSetAttributes = vi.fn();
let activeSpanMock: { setAttributes: typeof mockSpanSetAttributes } | undefined;

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn(() => ({ add: mockCounterAdd })),
  createHistogram: vi.fn(() => ({ record: mockHistogramRecord })),
}));

vi.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: vi.fn(() => activeSpanMock) },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

let nowMsValue = 1000;
vi.mock('@/utils/internal/performance.js', () => ({
  nowMs: vi.fn(() => nowMsValue),
}));

vi.mock('@/utils/internal/requestContext.js', () => ({
  withExtra: (ctx: { extra?: Record<string, unknown> }, fields: Record<string, unknown>) => ({
    ...ctx,
    extra: { ...ctx.extra, ...fields },
  }),
  requestContextService: {
    createRequestContext: vi.fn((ctx: Record<string, unknown>) => ({
      requestId: 'req-auth-test',
      timestamp: '2026-01-01T00:00:00Z',
      ...ctx,
    })),
  },
}));

vi.mock('@/mcp-server/transports/auth/lib/authContext.js', () => ({
  authContext: { run: vi.fn((_store: unknown, fn: () => unknown) => fn()) },
}));

import { createAuthMiddleware } from '@/mcp-server/transports/auth/authMiddleware.js';
import type { AuthStrategy } from '@/mcp-server/transports/auth/strategies/authStrategy.js';

function createMockHonoContext(authHeader?: string): Context {
  return {
    req: {
      method: 'POST',
      path: '/mcp',
      header: vi.fn((name: string) => {
        if (name === 'Authorization') return authHeader;
        return;
      }),
    },
  } as unknown as Context;
}

describe('Auth Middleware — mcp.auth.attempts counter & mcp.auth.duration histogram', () => {
  let mockStrategy: AuthStrategy;
  let mockNext: Next;

  beforeEach(() => {
    vi.clearAllMocks();
    nowMsValue = 1000;
    activeSpanMock = undefined;

    mockStrategy = {
      verify: vi.fn(async () => ({
        token: 'test-token',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        subject: 'user-1',
        scopes: ['read'],
      })),
    };

    mockNext = vi.fn(async () => {});
  });

  it('records "missing" outcome with "missing_header" reason when no Authorization header', async () => {
    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext(undefined);

    await expect(middleware(ctx, mockNext)).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.auth.outcome': 'missing',
      'mcp.auth.failure_reason': 'missing_header',
    });
    // Duration should NOT be recorded for 'missing' outcomes
    expect(mockHistogramRecord).not.toHaveBeenCalled();
  });

  it('records "missing" outcome with "missing_token" reason for empty Bearer token', async () => {
    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext('Bearer ');

    await expect(middleware(ctx, mockNext)).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.auth.outcome': 'missing',
      'mcp.auth.failure_reason': 'missing_token',
    });
    expect(mockHistogramRecord).not.toHaveBeenCalled();
  });

  it('records "missing" outcome when Authorization header uses wrong scheme', async () => {
    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext('Basic dXNlcjpwYXNz');

    await expect(middleware(ctx, mockNext)).rejects.toThrow();

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.auth.outcome': 'missing',
      'mcp.auth.failure_reason': 'missing_header',
    });
  });

  it('records "success" outcome with duration when strategy.verify succeeds', async () => {
    // Simulate 5ms verification duration
    const { nowMs } = await import('@/utils/internal/performance.js');
    (nowMs as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(1000) // t0
      .mockReturnValueOnce(1005); // after verify

    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext('Bearer valid-token');

    await middleware(ctx, mockNext);

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.auth.outcome': 'success',
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(5, {
      'mcp.auth.outcome': 'success',
    });
  });

  it('records "failure" outcome with duration when strategy.verify throws', async () => {
    const { nowMs } = await import('@/utils/internal/performance.js');
    (nowMs as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(2000) // t0
      .mockReturnValueOnce(2010); // after verify

    (mockStrategy.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('token expired'),
    );

    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext('Bearer expired-token');

    await expect(middleware(ctx, mockNext)).rejects.toThrow('token expired');

    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      'mcp.auth.outcome': 'failure',
    });
    expect(mockHistogramRecord).toHaveBeenCalledWith(10, {
      'mcp.auth.outcome': 'failure',
    });
  });

  it('does not include failure_reason attribute on success', async () => {
    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext('Bearer valid-token');

    await middleware(ctx, mockNext);

    const successCall = mockCounterAdd.mock.calls.find(
      (call: unknown[]) => (call[1] as Record<string, string>)['mcp.auth.outcome'] === 'success',
    );
    expect(successCall).toBeDefined();
    expect(successCall![1]).not.toHaveProperty('mcp.auth.failure_reason');
  });

  it('records identity attributes on the active span and falls back when tenant and subject are absent', async () => {
    activeSpanMock = { setAttributes: mockSpanSetAttributes };
    mockStrategy = {
      verify: vi.fn(async () => ({
        token: 'test-token',
        clientId: 'client-no-tenant',
        scopes: ['read', 'write'],
      })),
    };

    const middleware = createAuthMiddleware(mockStrategy);
    const ctx = createMockHonoContext('Bearer valid-token');

    await middleware(ctx, mockNext);

    expect(mockSpanSetAttributes).toHaveBeenLastCalledWith({
      [ATTR_MCP_CLIENT_ID]: 'client-no-tenant',
      [ATTR_MCP_TENANT_ID]: 'none',
      [ATTR_MCP_AUTH_SCOPES]: '2',
      [ATTR_MCP_AUTH_SUBJECT]: 'unknown',
    });
  });
});
