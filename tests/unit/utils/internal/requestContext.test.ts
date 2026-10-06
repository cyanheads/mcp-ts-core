/**
 * @fileoverview Unit tests for the requestContextService utilities.
 * @module tests/utils/internal/requestContext.test
 */

import { type Span, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import * as idGeneratorModule from '@/utils/security/idGenerator.js';
import { authContext } from '../../../../src/mcp-server/transports/auth/lib/authContext.js';
import {
  type RequestContext,
  requestContextService,
  toCanonicalContext,
  withActiveSpan,
  withExtra,
} from '../../../../src/utils/internal/requestContext.js';

/** A valid span context — 32/16 lowercase hex digits, sampled. */
const RECORDING_SPAN_CONTEXT = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: 1,
};

/** The all-zero span context a non-recording span carries. */
const NON_RECORDING_SPAN_CONTEXT = {
  traceId: '00000000000000000000000000000000',
  spanId: '0000000000000000',
  traceFlags: 0,
};

describe('requestContextService', () => {
  let idSpy: MockInstance;
  let getActiveSpanSpy: MockInstance;

  beforeEach(() => {
    getActiveSpanSpy = vi
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(undefined as unknown as Span);
    idSpy = vi.spyOn(idGeneratorModule, 'generateRequestContextId').mockReturnValue('CTX-TEST-ID');
  });

  afterEach(() => {
    idSpy.mockRestore();
    getActiveSpanSpy.mockRestore();
  });

  it('creates a context with generated IDs, added fields, and trace metadata', () => {
    getActiveSpanSpy.mockReturnValue({
      spanContext: () => RECORDING_SPAN_CONTEXT,
    } as never);

    const context = requestContextService.createRequestContext({
      additionalContext: { detail: 'value' },
      operation: 'UnitTest',
      tenantId: 'manual-tenant',
    });

    expect(context.requestId).toBe('CTX-TEST-ID');
    expect(context.operation).toBe('UnitTest');
    expect(context.extra).toEqual({ detail: 'value' });
    expect(context.tenantId).toBe('manual-tenant');
    expect(context.traceId).toBe(RECORDING_SPAN_CONTEXT.traceId);
    expect(context.spanId).toBe(RECORDING_SPAN_CONTEXT.spanId);
  });

  it('leaves trace IDs undefined when the active span context is invalid (#296)', () => {
    // What `startActiveSpan` yields with telemetry disabled: a non-recording
    // span whose IDs are all zeroes. They correlate to nothing, so publishing
    // them would be worse than reporting no correlation at all.
    getActiveSpanSpy.mockReturnValue({
      spanContext: () => NON_RECORDING_SPAN_CONTEXT,
    } as never);

    const context = requestContextService.createRequestContext({ operation: 'UnitTest' });

    expect(context.traceId).toBeUndefined();
    expect(context.spanId).toBeUndefined();
  });

  it('inherits data from a parent context and prefers explicit tenant overrides', () => {
    const parent = requestContextService.createRequestContext({
      additionalContext: { parentOnly: true },
      tenantId: 'parent-tenant',
    });

    const child = requestContextService.createRequestContext({
      parentContext: parent,
      additionalContext: { childOnly: true },
      tenantId: 'child-tenant',
    });

    expect(child.requestId).toBe(parent.requestId);
    expect(child.extra).toEqual({ parentOnly: true, childOnly: true });
    expect(child.tenantId).toBe('child-tenant');
  });

  it('falls back to the auth context tenant when none is provided elsewhere', async () => {
    await new Promise<void>((resolve) => {
      authContext.run(
        {
          authInfo: {
            subject: 'user-1',
            scopes: ['scope:a'],
            tenantId: 'auth-tenant',
            token: 'test-token',
            clientId: 'test-client',
          },
        },
        () => {
          const context = requestContextService.createRequestContext();
          expect(context.tenantId).toBe('auth-tenant');
          // Bridge auth from ALS, including the bearer token so handlers can
          // forward it upstream without reaching into AsyncLocalStorage.
          expect(context.auth).toBeDefined();
          expect(context.auth?.sub).toBe('user-1');
          expect(context.auth?.clientId).toBe('test-client');
          expect(context.auth?.scopes).toEqual(['scope:a']);
          expect(context.auth?.tenantId).toBe('auth-tenant');
          expect(context.auth?.token).toBe('test-token');
          resolve();
        },
      );
    });
  });

  it('routes ad-hoc properties into the extra bag and inherits declared fields', () => {
    const context = requestContextService.createRequestContext({
      operation: 'test',
      parentContext: { sessionId: 'sess-123' },
      additionalContext: { toolName: 'my-tool', isServerless: true },
    });

    expect(context.extra).toEqual({ toolName: 'my-tool', isServerless: true });
    expect(context.sessionId).toBe('sess-123');
  });

  describe('tenant ID resolution priority', () => {
    it('prefers additionalContext over rest params', () => {
      const context = requestContextService.createRequestContext({
        tenantId: 'rest-tenant',
        additionalContext: { tenantId: 'additional-tenant' },
      });

      expect(context.tenantId).toBe('additional-tenant');
    });

    it('prefers rest params over parent context', () => {
      const parent = requestContextService.createRequestContext({
        tenantId: 'parent-tenant',
      });

      const child = requestContextService.createRequestContext({
        parentContext: parent,
        tenantId: 'rest-tenant',
      });

      expect(child.tenantId).toBe('rest-tenant');
    });

    it('uses parent context tenant when no closer source provides one', () => {
      const parent = requestContextService.createRequestContext({
        tenantId: 'parent-tenant',
      });

      const child = requestContextService.createRequestContext({
        parentContext: parent,
      });

      expect(child.tenantId).toBe('parent-tenant');
    });

    it('falls back to auth store as lowest priority', async () => {
      const parent = requestContextService.createRequestContext();

      await new Promise<void>((resolve) => {
        authContext.run(
          {
            authInfo: {
              subject: 'u',
              scopes: [],
              tenantId: 'auth-tenant',
              token: 't',
              clientId: 'c',
            },
          },
          () => {
            const child = requestContextService.createRequestContext({
              parentContext: parent,
            });
            expect(child.tenantId).toBe('auth-tenant');
            resolve();
          },
        );
      });
    });
  });

  describe('withAuthInfo', () => {
    it('populates auth context from AuthInfo', () => {
      const authInfo = {
        subject: 'user-42',
        scopes: ['read', 'write'],
        clientId: 'client-abc',
        token: 'jwt-token-xyz',
        tenantId: 'tenant-1',
      };

      const context = requestContextService.withAuthInfo(authInfo);

      expect(context.tenantId).toBe('tenant-1');
      expect(context.auth).toBeDefined();
      expect(context.auth?.sub).toBe('user-42');
      expect(context.auth?.scopes).toEqual(['read', 'write']);
      expect(context.auth?.clientId).toBe('client-abc');
      expect(context.auth?.tenantId).toBe('tenant-1');
      expect(context.auth?.token).toBe('jwt-token-xyz');
    });

    it('omits token from auth when AuthInfo carries no token', () => {
      const context = requestContextService.withAuthInfo({
        scopes: ['read'],
        clientId: 'c',
      } as never);

      expect(context.auth?.token).toBeUndefined();
    });

    it('uses clientId as sub fallback when subject is undefined', () => {
      const authInfo = {
        scopes: ['read'],
        clientId: 'service-account',
        token: 'tok',
      };

      const context = requestContextService.withAuthInfo(authInfo);
      expect(context.auth?.sub).toBe('service-account');
    });

    it('omits tenantId from auth when not provided', () => {
      const authInfo = {
        subject: 'u',
        scopes: [],
        clientId: 'c',
        token: 't',
      };

      const context = requestContextService.withAuthInfo(authInfo);
      expect(context.auth?.tenantId).toBeUndefined();
    });

    it('inherits properties from a parent context', () => {
      const parent = requestContextService.createRequestContext({
        additionalContext: { tracing: true },
      });
      const authInfo = {
        subject: 'u',
        scopes: [],
        clientId: 'c',
        token: 't',
        tenantId: 'tid',
      };

      const context = requestContextService.withAuthInfo(authInfo, parent);
      expect(context.requestId).toBe(parent.requestId);
      expect(context.extra).toEqual({ tracing: true });
      expect(context.auth).toBeDefined();
    });
  });
  describe('withActiveSpan (#296)', () => {
    const base: RequestContext = {
      requestId: 'req-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      traceId: 'stale-trace',
      spanId: 'stale-span',
    };

    it('re-binds both IDs to the span active now', () => {
      getActiveSpanSpy.mockReturnValue({
        spanContext: () => RECORDING_SPAN_CONTEXT,
      } as never);

      expect(withActiveSpan(base)).toEqual({
        ...base,
        traceId: RECORDING_SPAN_CONTEXT.traceId,
        spanId: RECORDING_SPAN_CONTEXT.spanId,
      });
    });

    it('returns the context untouched when no span is active', () => {
      // The telemetry-disabled path — nothing to correlate to, so nothing to
      // rewrite, and the caller keeps its own reference.
      expect(withActiveSpan(base)).toBe(base);
    });

    it('returns the context untouched when the active span is non-recording', () => {
      getActiveSpanSpy.mockReturnValue({
        spanContext: () => NON_RECORDING_SPAN_CONTEXT,
      } as never);

      expect(withActiveSpan(base)).toBe(base);
    });

    it('allocates nothing when the IDs already match the active span', () => {
      getActiveSpanSpy.mockReturnValue({
        spanContext: () => RECORDING_SPAN_CONTEXT,
      } as never);
      const bound = {
        ...base,
        traceId: RECORDING_SPAN_CONTEXT.traceId,
        spanId: RECORDING_SPAN_CONTEXT.spanId,
      };

      expect(withActiveSpan(bound)).toBe(bound);
    });
  });
});

describe('toCanonicalContext', () => {
  /** Every field `RequestContext` declares. */
  const canonical = {
    auth: { clientId: 'client-1', scopes: ['tool:x:read'], sub: 'user-1' },
    extra: { toolName: 'probe_tool' },
    operation: 'HandleToolRequest',
    requestId: 'req-1',
    sessionId: 'session-1',
    spanId: 'b'.repeat(16),
    tenantId: 'tenant-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    traceId: 'a'.repeat(32),
  };

  it('keeps every declared field and drops the live machinery of a handler context', () => {
    // A handler `ctx` is accepted wherever a `RequestContext` is, so it arrives
    // whole: request machinery, and after an elicitation round what the user typed.
    const handlerContext = {
      ...canonical,
      inputs: { responses: { creds: { action: 'accept', content: { passphrase: 'hunter2' } } } },
      log: { info: () => {} },
      signal: new AbortController().signal,
      state: { get: async () => null },
      requestInput: () => {},
      notifyResourceUpdated: () => {},
    };

    const projected = toCanonicalContext(handlerContext);

    expect(projected).toEqual(canonical);
    expect(JSON.stringify(projected)).not.toContain('hunter2');
  });

  it('leaves out a declared field whose value is undefined', () => {
    const projected = toCanonicalContext({
      requestId: 'req-2',
      timestamp: '2026-01-01T00:00:00.000Z',
      tenantId: undefined,
    });

    expect(projected).toEqual({ requestId: 'req-2', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(projected).not.toHaveProperty('tenantId');
  });
});

describe('withExtra', () => {
  const parent: RequestContext = {
    requestId: 'req-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    extra: { toolName: 'probe_tool', attempt: 1 },
  };

  it('merges into the extra a parent already carried, the new fields winning', () => {
    expect(withExtra(parent, { attempt: 2, url: 'https://x.test' })).toEqual({
      requestId: 'req-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      extra: { toolName: 'probe_tool', attempt: 2, url: 'https://x.test' },
    });
  });

  it('leaves the parent context and its extra untouched', () => {
    withExtra(parent, { attempt: 2 });

    expect(parent.extra).toEqual({ toolName: 'probe_tool', attempt: 1 });
  });
});
