/**
 * @fileoverview Unit tests for the requestContextService utilities.
 * @module tests/utils/internal/requestContext.test
 */

import { type Span, trace } from '@opentelemetry/api';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import type { Context } from '@/core/context.js';
import type { RequestContext, RequestContextLike } from '@/utils/internal/requestContext.js';
import * as idGeneratorModule from '@/utils/security/idGenerator.js';
import { authContext } from '../../../../src/mcp-server/transports/auth/lib/authContext.js';
import { requestContextService } from '../../../../src/utils/internal/requestContext.js';

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
    const spanContext = { traceId: 'trace-id', spanId: 'span-id' };
    getActiveSpanSpy.mockReturnValue({
      spanContext: () => spanContext,
    } as never);

    const context = requestContextService.createRequestContext({
      additionalContext: { extra: 'value' },
      operation: 'UnitTest',
      tenantId: 'manual-tenant',
    });

    expect(context.requestId).toBe('CTX-TEST-ID');
    expect(context.operation).toBe('UnitTest');
    expect(context.extra).toBe('value');
    expect(context.tenantId).toBe('manual-tenant');
    expect(context.traceId).toBe('trace-id');
    expect(context.spanId).toBe('span-id');
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
    expect(child.parentOnly).toBe(true);
    expect(child.childOnly).toBe(true);
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

  it('creates a context with defaults when called with no arguments', () => {
    const context = requestContextService.createRequestContext();
    expect(context.requestId).toBe('CTX-TEST-ID');
    expect(context.timestamp).toBeDefined();
    expect(typeof context.timestamp).toBe('string');
  });

  it('passes ad-hoc properties through the index signature', () => {
    const context = requestContextService.createRequestContext({
      operation: 'test',
      toolName: 'my-tool',
      sessionId: 'sess-123',
      isServerless: true,
    });

    expect(context.toolName).toBe('my-tool');
    expect(context.sessionId).toBe('sess-123');
    expect(context.isServerless).toBe(true);
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

    it('forwards the bearer token so handlers can relay it upstream', () => {
      const context = requestContextService.withAuthInfo({
        scopes: ['read'],
        clientId: 'c',
        token: 'bearer-abc',
      });

      expect(context.auth?.token).toBe('bearer-abc');
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
      expect(context.tracing).toBe(true);
      expect(context.auth).toBeDefined();
    });
  });
});

describe('RequestContextLike structural assignability (issue #108)', () => {
  it('accepts the handler Context without a slice helper', () => {
    expectTypeOf<Context>().toMatchTypeOf<RequestContextLike>();
  });

  it('accepts the open RequestContext bag', () => {
    expectTypeOf<RequestContext>().toMatchTypeOf<RequestContextLike>();
  });
});
