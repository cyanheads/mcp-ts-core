/**
 * @fileoverview Unit tests for the unified Context construction, the error
 * contract helpers (createFail/createRecoveryFor/attachTypedFail), the
 * enrichment/content accumulators, and the request-scoped logger/state/
 * signal/multi-round-trip-input wiring in src/core/context.ts.
 * @module tests/unit/core/context.test
 */

import type { LoggingLevel } from '@modelcontextprotocol/server';
import { inputRequired } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  attachTypedFail,
  type Context,
  type ContextDeps,
  createContentCollect,
  createContentStore,
  createContext,
  createEnrich,
  createEnrichmentStore,
  createFail,
  createRecoveryFor,
  readContentStore,
  readEnrichmentStore,
  resolveDeclaredFailure,
} from '@/core/context.js';
import {
  createContextInputs,
  createRequestInput,
  type InputRequiredSignal,
  isInputRequiredSignal,
} from '@/mcp-server/inputRequired.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { type ErrorContract, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { sanitization } from '@/utils/security/sanitization.js';

// ---------------------------------------------------------------------------
// Local fixtures — no shared test helper covers ContextDeps construction, so
// these are colocated here per the field-test agent's scope notes.
// ---------------------------------------------------------------------------

function buildAppContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * `defaultTenantId` defaults to `'default'`, the value stdio and HTTP with
 * `MCP_AUTH_MODE=none` resolve to; pass `undefined` for the HTTP `jwt`/`oauth`
 * shape.
 */
function buildDeps(overrides: Partial<ContextDeps> = {}): ContextDeps {
  return {
    appContext: buildAppContext(),
    defaultTenantId: 'default',
    inputs: createContextInputs(undefined, undefined),
    logger,
    requestInput: createRequestInput(),
    signal: new AbortController().signal,
    storage: new StorageService(new InMemoryProvider()),
    ...overrides,
  };
}

/**
 * Undoes any `vi.spyOn` on the shared `logger` singleton so later tests never
 * observe an earlier test's mocked implementation, and any `vi.stubEnv`.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('createFail', () => {
  const errors: readonly ErrorContract[] = [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No items matched the query.',
      recovery: 'Broaden the query or check the spelling and try again.',
    },
    {
      reason: 'queue_full',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The queue is at capacity.',
      retryable: true,
      recovery: 'Wait a few seconds before retrying or reduce the batch size.',
    },
    {
      reason: 'permanent_denial',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The caller is permanently denied.',
      retryable: false,
      recovery: 'Contact an administrator to request access to this resource.',
    },
    {
      reason: 'no_retry_hint',
      code: JsonRpcErrorCode.InternalError,
      when: 'An internal error with no retry guidance.',
      recovery: 'Retry later or contact support if the problem persists.',
    },
  ];

  it('builds an error using the contract code and `when` text when no message is given', () => {
    const fail = createFail(errors);
    const err = fail('no_match');

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).toBe('No items matched the query.');
    expect(err.data).toEqual({ reason: 'no_match' });
  });

  it('uses the caller-supplied message over the contract `when` text', () => {
    const fail = createFail(errors);
    const err = fail('no_match', 'No items match ids [1,2,3]');

    expect(err.message).toBe('No items match ids [1,2,3]');
  });

  it('auto-populates data.reason and ignores a caller-supplied data.reason override', () => {
    // Regression: spread order in createFail was `{ reason, ...data }`, which
    // let user data overwrite the framework-canonical reason. The fix flips it
    // to `{ ...data, reason }` so the contract reason always wins. This is a
    // load-bearing invariant for observability — observers rely on data.reason
    // matching the contract entry.
    const fail = createFail(errors);
    const err = fail('no_match', undefined, { reason: 'something_else', ids: ['a'] });

    expect(err.data).toEqual({ reason: 'no_match', ids: ['a'] });
  });

  it('defaults data.retryable from the contract entry when declared true', () => {
    const fail = createFail(errors);
    const err = fail('queue_full');

    expect(err.data).toEqual({ reason: 'queue_full', retryable: true });
  });

  it('defaults data.retryable from the contract entry when declared false', () => {
    const fail = createFail(errors);
    const err = fail('permanent_denial');

    expect(err.data).toEqual({ reason: 'permanent_denial', retryable: false });
  });

  it('omits data.retryable entirely when the contract entry does not declare it', () => {
    const fail = createFail(errors);
    const err = fail('no_retry_hint');

    expect(err.data).toEqual({ reason: 'no_retry_hint' });
    expect(err.data).not.toHaveProperty('retryable');
  });

  it('lets caller-supplied data.retryable override the contract default per-occurrence', () => {
    const fail = createFail(errors);
    const err = fail('queue_full', undefined, { retryable: false });

    expect(err.data).toEqual({ reason: 'queue_full', retryable: false });
  });

  it('passes options.cause through to the resulting error', () => {
    const fail = createFail(errors);
    const cause = new Error('upstream boom');
    const err = fail('no_match', undefined, undefined, { cause });

    expect(err.cause).toBe(cause);
  });

  it('returns (not throws) an InternalError with diagnostic data for an undeclared reason', () => {
    const fail = createFail(errors);
    const err = fail('typo_reason');

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.InternalError);
    expect(err.message).toContain('typo_reason');
    expect(err.data?.reason).toBe('typo_reason');
    expect(err.data?.declaredReasons).toEqual([
      'no_match',
      'queue_full',
      'permanent_denial',
      'no_retry_hint',
    ]);
  });

  /**
   * The top frame is matched by file, not by function name: under coverage
   * instrumentation JSC renames frames, so a frame's file is what both
   * runtimes report the same way.
   */
  it.each([
    ['a declared reason', 'no_match', 'McpError: No items matched the query.'],
    ['an undeclared reason', 'typo_reason', 'McpError: ctx.fail() called with unknown reason'],
  ])(
    'starts the stack at the line that called it, its own frame cut, for %s (#694)',
    (_label, reason, header) => {
      const fail = createFail(errors);
      function throwSiteOfCtxFail(): McpError {
        return fail(reason);
      }

      const err = throwSiteOfCtxFail();

      const [first, top] = String(err.stack).split('\n');
      expect(first?.startsWith(header)).toBe(true);
      expect(top).toContain('context.test.ts:');
      expect(err.stack).not.toMatch(/core[\\/]context\.[jt]s/);
    },
  );
});

describe('createRecoveryFor', () => {
  const errors: readonly ErrorContract[] = [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No items matched.',
      recovery: 'Broaden the query and try again.',
    },
  ];

  it('returns the wire-shaped recovery hint for a declared reason', () => {
    const recoveryFor = createRecoveryFor(errors);
    expect(recoveryFor('no_match')).toEqual({
      recovery: { hint: 'Broaden the query and try again.' },
    });
  });

  it('returns an empty object for an undeclared reason', () => {
    const recoveryFor = createRecoveryFor(errors);
    expect(recoveryFor('unknown_reason')).toEqual({});
  });
});

describe('resolveDeclaredFailure', () => {
  const RECOVERY = 'Search for the item again before retrying the call.';
  const errors: readonly ErrorContract[] = [
    {
      reason: 'gone',
      code: JsonRpcErrorCode.NotFound,
      when: 'The item is gone.',
      recovery: RECOVERY,
    },
  ];

  /** `target` with an own `key` whose read throws. */
  function unreadable<T extends object>(target: T, key: string): T {
    return Object.defineProperty(target, key, {
      configurable: true,
      get() {
        throw new Error(`${key} getter`);
      },
    });
  }

  /** A declared failure as a service raises it, with a cause. */
  function declared(): McpError {
    return new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      'upstream gone',
      { reason: 'gone', id: 7 },
      { cause: new Error('socket closed') },
    );
  }

  it('fills the entry’s recovery on a copy that keeps the thrown code, message, name, stack, and cause', () => {
    const thrown = declared();

    const { entry, failure } = resolveDeclaredFailure(errors, thrown);

    expect(entry?.reason).toBe('gone');
    expect(failure).not.toBe(thrown);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'upstream gone',
      name: 'McpError',
      stack: thrown.stack,
      cause: thrown.cause,
      data: { reason: 'gone', id: 7, recovery: { hint: RECOVERY } },
    });
    expect(thrown.data).toEqual({ reason: 'gone', id: 7 });
  });

  it('resolves no entry for a thrown McpError whose data it cannot read, or a revoked Proxy (#697)', () => {
    const thrown = unreadable(declared(), 'data');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(resolveDeclaredFailure(errors, thrown)).toEqual({ entry: undefined, failure: thrown });
    const resolved = resolveDeclaredFailure(errors, proxy);
    expect(resolved.entry).toBeUndefined();
    expect(Object.is(resolved.failure, proxy)).toBe(true);
  });

  it('copies each field it cannot read as [Unreadable], an unreadable code as the entry’s (#697)', () => {
    const thrown = unreadable(
      unreadable(unreadable(unreadable(declared(), 'stack'), 'name'), 'message'),
      'code',
    );

    const { failure } = resolveDeclaredFailure(errors, thrown);

    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: '[Unreadable]',
      name: '[Unreadable]',
      stack: '[Unreadable]',
      data: { reason: 'gone', id: 7, recovery: { hint: RECOVERY } },
    });
  });

  it('keeps a cause it cannot read unreadable on the copy (#697)', () => {
    const thrown = unreadable(declared(), 'cause');

    const { failure } = resolveDeclaredFailure(errors, thrown);

    expect(failure).toMatchObject({
      message: 'upstream gone',
      data: { recovery: { hint: RECOVERY } },
    });
    expect(() => (failure as McpError).cause).toThrow('cause getter');
  });
});

describe('attachTypedFail', () => {
  const errors: readonly ErrorContract[] = [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No items matched.',
      recovery: 'Broaden the query and try again.',
    },
  ];

  it('returns the same ctx unchanged when errors is undefined', () => {
    const ctx = createContext(buildDeps());
    const result = attachTypedFail(ctx, undefined);

    expect(result).toBe(ctx);
    expect((result as unknown as { fail?: unknown }).fail).toBeUndefined();
  });

  it('returns the same ctx unchanged when errors is an empty array', () => {
    const ctx = createContext(buildDeps());
    const result = attachTypedFail(ctx, []);

    expect(result).toBe(ctx);
    expect((result as unknown as { fail?: unknown }).fail).toBeUndefined();
  });

  it('mutates and returns the same ctx with a typed fail/recoveryFor when errors are declared', () => {
    const ctx = createContext(buildDeps());
    const result = attachTypedFail(ctx, errors);

    expect(result).toBe(ctx);
    const withFail = result as unknown as {
      fail: (reason: string) => McpError;
      recoveryFor: (reason: string) => unknown;
    };
    expect(withFail.fail('no_match').code).toBe(JsonRpcErrorCode.NotFound);
    expect(withFail.recoveryFor('no_match')).toEqual({
      recovery: { hint: 'Broaden the query and try again.' },
    });
  });

  it('composes with ctx.fail via spread without overriding caller-supplied data (#174)', () => {
    const ctx = attachTypedFail(createContext(buildDeps()), [
      {
        reason: 'rate_limited',
        code: JsonRpcErrorCode.RateLimited,
        when: 'Upstream throttled',
        retryable: true,
        recovery: 'Wait a few seconds before retrying.',
      },
    ]);
    const withFail = ctx as unknown as {
      fail: (reason: string, message?: string, data?: Record<string, unknown>) => McpError;
      recoveryFor: (reason: string) => Record<string, unknown>;
    };

    const err = withFail.fail('rate_limited', 'Upstream slowed down', {
      attempt: 3,
      ...withFail.recoveryFor('rate_limited'),
    });

    expect(err.data).toEqual({
      reason: 'rate_limited',
      retryable: true,
      attempt: 3,
      recovery: { hint: 'Wait a few seconds before retrying.' },
    });
  });
});

describe('createEnrich', () => {
  it('merges arbitrary fields via the bare call without tagging a render kind', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich({ customField: 'hello' });

    expect(store.values).toEqual({ customField: 'hello' });
    expect(store.kinds.size).toBe(0);
  });

  it('notice() writes `notice` and tags it as a notice render', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.notice('Nothing matched.');

    expect(store.values.notice).toBe('Nothing matched.');
    expect(store.kinds.get('notice')).toBe('notice');
  });

  it('total() writes `totalCount` and tags it as a total render', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.total(42);

    expect(store.values.totalCount).toBe(42);
    expect(store.kinds.get('totalCount')).toBe('total');
  });

  it('echo() writes `effectiveQuery` and tags it as an echo render', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.echo('parsed query');

    expect(store.values.effectiveQuery).toBe('parsed query');
    expect(store.kinds.get('effectiveQuery')).toBe('echo');
  });

  it('delta() writes {before, after} under the field name and tags it as a delta render', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.delta({ field: 'status', before: 'draft', after: 'published' });

    expect(store.values.status).toEqual({ before: 'draft', after: 'published' });
    expect(store.kinds.get('status')).toBe('delta');
  });

  it('truncated() without ceiling/guidance sets a generated default notice and omits truncationCeiling', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.truncated({ shown: 20, cap: 20 });

    expect(store.values.truncated).toBe(true);
    expect(store.values.shown).toBe(20);
    expect(store.values.cap).toBe(20);
    expect(store.values).not.toHaveProperty('truncationCeiling');
    expect(store.values.notice).toBe(
      'Results capped at 20; showing 20. Raise the cap or narrow with filters.',
    );
    expect(store.kinds.get('notice')).toBe('notice');
  });

  it('truncated() with ceiling and guidance sets truncationCeiling and uses the guidance text as notice', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.truncated({ shown: 5, cap: 5, ceiling: 100, guidance: 'Narrow with a date filter.' });

    expect(store.values.truncationCeiling).toBe(100);
    expect(store.values.notice).toBe('Narrow with a date filter.');
  });

  it('accumulates across multiple calls, with later calls overriding earlier keys', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich({ a: 1 });
    enrich({ a: 2, b: 3 });

    expect(store.values).toEqual({ a: 2, b: 3 });
  });

  it('truncated() is last-wins across successive calls', () => {
    const store = createEnrichmentStore();
    const enrich = createEnrich(store);

    enrich.truncated({ shown: 5, cap: 10, guidance: 'First.' });
    enrich.truncated({ shown: 3, cap: 5, guidance: 'Second.' });

    expect(store.values.notice).toBe('Second.');
    expect(store.values.shown).toBe(3);
    expect(store.values.cap).toBe(5);
  });
});

describe('createContentCollect', () => {
  it('pushes a raw content block via the bare call', () => {
    const store = createContentStore();
    const content = createContentCollect(store);

    content({ type: 'text', text: 'hello' } as never);

    expect(store.blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('image() pushes a typed image block', () => {
    const store = createContentStore();
    const content = createContentCollect(store);

    content.image('base64data', 'image/png');

    expect(store.blocks).toEqual([{ type: 'image', data: 'base64data', mimeType: 'image/png' }]);
  });

  it('audio() pushes a typed audio block', () => {
    const store = createContentStore();
    const content = createContentCollect(store);

    content.audio('base64audio', 'audio/mpeg');

    expect(store.blocks).toEqual([{ type: 'audio', data: 'base64audio', mimeType: 'audio/mpeg' }]);
  });

  it('accumulates multiple blocks in call order', () => {
    const store = createContentStore();
    const content = createContentCollect(store);

    content.image('img-1', 'image/png');
    content.audio('audio-1', 'audio/mpeg');

    expect(store.blocks).toEqual([
      { type: 'image', data: 'img-1', mimeType: 'image/png' },
      { type: 'audio', data: 'audio-1', mimeType: 'audio/mpeg' },
    ]);
  });
});

describe('enrichment and content store stash/read', () => {
  it('reads back the same enrichment store instance that was stashed by createContext', () => {
    const ctx = createContext(buildDeps());
    const store = readEnrichmentStore(ctx);

    expect(store).toBeDefined();
    store!.values.probe = true;
    expect(readEnrichmentStore(ctx)?.values.probe).toBe(true);
  });

  it('returns undefined reading an enrichment store from a context that never had one stashed', () => {
    const bareCtx = {} as Context;
    expect(readEnrichmentStore(bareCtx)).toBeUndefined();
  });

  it('reads back the same content store instance that was stashed by createContext', () => {
    const ctx = createContext(buildDeps());
    const store = readContentStore(ctx);

    expect(store).toBeDefined();
    store!.blocks.push({ type: 'text', text: 'probe' } as never);
    expect(readContentStore(ctx)?.blocks).toHaveLength(1);
  });

  it('returns undefined reading a content store from a context that never had one stashed', () => {
    const bareCtx = {} as Context;
    expect(readContentStore(bareCtx)).toBeUndefined();
  });

  it('wires ctx.enrich and ctx.content to the stashed stores rather than to detached copies', () => {
    const ctx = createContext(buildDeps());

    ctx.enrich.truncated({ shown: 2, cap: 5 });
    ctx.content.image('base64data', 'image/png');

    expect(readEnrichmentStore(ctx)?.values).toMatchObject({
      truncated: true,
      shown: 2,
      cap: 5,
    });
    expect(readContentStore(ctx)?.blocks).toEqual([
      { type: 'image', data: 'base64data', mimeType: 'image/png' },
    ]);
  });

  it('stashes stores under non-enumerable symbol keys invisible to Object.keys/JSON.stringify', () => {
    const ctx = createContext(buildDeps());

    expect(Object.keys(ctx)).not.toContain('enrichmentStore');
    expect(Object.keys(ctx)).not.toContain('contentStore');
    expect(JSON.stringify(ctx)).not.toMatch(/mcp\.(enrichment|content)Store/);
  });
});

describe('createContext — tenantId resolution', () => {
  it.each([['default'], [undefined]])(
    'preserves an explicit appContext.tenantId over a default of %s',
    (defaultTenantId) => {
      const ctx = createContext(
        buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }), defaultTenantId }),
      );

      expect(ctx.tenantId).toBe('tenant-a');
    },
  );

  it('applies the default tenant when appContext has none', () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext() }));

    expect(ctx.tenantId).toBe('default');
  });

  it('leaves tenantId undefined (fail-closed) when there is no default and appContext has none', () => {
    const ctx = createContext(
      buildDeps({ appContext: buildAppContext(), defaultTenantId: undefined }),
    );

    expect(ctx.tenantId).toBeUndefined();
  });

  it('takes the default from deps alone, never from process.env', () => {
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'http');
    vi.stubEnv('MCP_AUTH_MODE', 'jwt');
    expect(createContext(buildDeps()).tenantId).toBe('default');

    vi.stubEnv('MCP_TRANSPORT_TYPE', 'stdio');
    vi.stubEnv('MCP_AUTH_MODE', 'none');
    expect(createContext(buildDeps({ defaultTenantId: undefined })).tenantId).toBeUndefined();
  });
});

describe('createContext — field wiring', () => {
  it('mirrors requestId and timestamp from appContext', () => {
    const ctx = createContext(
      buildDeps({
        appContext: buildAppContext({
          requestId: 'req-xyz',
          timestamp: '2026-02-02T00:00:00.000Z',
        }),
      }),
    );

    expect(ctx.requestId).toBe('req-xyz');
    expect(ctx.timestamp).toBe('2026-02-02T00:00:00.000Z');
  });

  it.each<[keyof ContextDeps & keyof Context, unknown]>([
    ['sessionId', 'session-123'],
    ['notifyPromptListChanged', vi.fn()],
    ['notifyResourceListChanged', vi.fn()],
    ['notifyResourceUpdated', vi.fn()],
    ['notifyToolListChanged', vi.fn()],
    ['uri', new URL('myscheme://item/123')],
  ])('forwards %s from deps by reference, undefined when absent', (field, value) => {
    expect(createContext(buildDeps({ [field]: value }))[field]).toBe(value);
    expect(createContext(buildDeps())[field]).toBeUndefined();
  });

  it.each<[keyof RequestContext & keyof Context, unknown]>([
    ['traceId', 'trace-1'],
    ['spanId', 'span-1'],
    ['auth', { clientId: 'client-1', scopes: ['tool:x:read'], sub: 'user-1' }],
  ])('forwards %s from appContext, undefined when absent', (field, value) => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ [field]: value }) }));

    expect(ctx[field]).toEqual(value);
    expect(createContext(buildDeps())[field]).toBeUndefined();
  });

  it('initializes fresh, empty enrichment and content stores and a no-op recoveryFor', () => {
    const ctx = createContext(buildDeps());

    expect(readEnrichmentStore(ctx)).toEqual({ values: {}, kinds: new Map() });
    expect(readContentStore(ctx)).toEqual({ blocks: [] });
    expect(ctx.recoveryFor('anything')).toEqual({});
  });
});

describe('createContext — signal wiring', () => {
  it('carries the provided AbortSignal by reference and reflects a later abort', () => {
    const controller = new AbortController();
    const ctx = createContext(buildDeps({ signal: controller.signal }));

    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.signal.aborted).toBe(false);

    controller.abort();

    expect(ctx.signal.aborted).toBe(true);
  });
});

describe('ContextLogger (ctx.log)', () => {
  it('debug/info/notice/warning forward to the singleton logger, enriched with call-site data', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const noticeSpy = vi.spyOn(logger, 'notice').mockImplementation(() => {});
    const warningSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    const appContext = buildAppContext({ requestId: 'req-log', tenantId: 'tenant-log' });
    const ctx = createContext(buildDeps({ appContext }));

    ctx.log.debug('debug msg', { extra: 1 });
    ctx.log.info('info msg', { extra: 2 });
    ctx.log.notice('notice msg', { extra: 3 });
    ctx.log.warning('warning msg', { extra: 4 });

    expect(debugSpy).toHaveBeenCalledWith(
      'debug msg',
      expect.objectContaining({ requestId: 'req-log', extra: { extra: 1 } }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'info msg',
      expect.objectContaining({ requestId: 'req-log', extra: { extra: 2 } }),
    );
    expect(noticeSpy).toHaveBeenCalledWith(
      'notice msg',
      expect.objectContaining({ requestId: 'req-log', extra: { extra: 3 } }),
    );
    expect(warningSpy).toHaveBeenCalledWith(
      'warning msg',
      expect.objectContaining({ requestId: 'req-log', extra: { extra: 4 } }),
    );
  });

  it('passes appContext through unmodified when no extra data is given', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    // tenantId is set explicitly so createContext's stdio auto-default logic
    // does not spread-copy appContext into a new object — effectiveContext
    // stays referentially equal to appContext, letting the assertion below
    // check exact passthrough (no data merged in).
    const appContext = buildAppContext({ requestId: 'req-log-2', tenantId: 'preset-tenant' });
    const ctx = createContext(buildDeps({ appContext }));

    ctx.log.debug('no data');

    expect(debugSpy).toHaveBeenCalledWith('no data', appContext);
  });

  it('logs the auto-defaulted tenantId rather than the absent original', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const ctx = createContext(buildDeps({ appContext: buildAppContext() }));

    ctx.log.info('check tenant');

    expect(ctx.tenantId).toBe('default');
    expect(infoSpy).toHaveBeenCalledWith(
      'check tenant',
      expect.objectContaining({ tenantId: 'default' }),
    );
  });

  it('error(msg, error, data) forwards the Error object and enriched data in the 3-arg form', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const appContext = buildAppContext({ requestId: 'req-err' });
    const ctx = createContext(buildDeps({ appContext }));
    const boom = new Error('boom');

    ctx.log.error('failed', boom, { detail: 'x' });

    expect(errorSpy).toHaveBeenCalledWith(
      'failed',
      boom,
      expect.objectContaining({ requestId: 'req-err', extra: { detail: 'x' } }),
    );
  });

  it('error(msg) without an Error object forwards the enriched context in the 2-arg form', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const appContext = buildAppContext({ requestId: 'req-err-2' });
    const ctx = createContext(buildDeps({ appContext }));

    ctx.log.error('failed without error object', undefined, { detail: 'y' });

    expect(errorSpy).toHaveBeenCalledWith(
      'failed without error object',
      expect.objectContaining({ requestId: 'req-err-2', extra: { detail: 'y' } }),
    );
    // Exactly two arguments — the Error slot is omitted entirely, not passed
    // as an explicit `undefined` placeholder.
    expect(errorSpy.mock.calls[0]).toHaveLength(2);
  });
});

describe('ContextState (ctx.state)', () => {
  it('set/get round-trips a value for a tenant-scoped key', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.set('item-1', { name: 'Widget' });
    const value = await ctx.state.get<{ name: string }>('item-1');

    expect(value).toEqual({ name: 'Widget' });
  });

  it('get returns null for a missing key', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    const value = await ctx.state.get('missing-key');

    expect(value).toBeNull();
  });

  it('get validates the stored value against a provided Zod schema', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));
    const schema = z.object({ count: z.number() });

    await ctx.state.set('item-2', { count: 5 });
    const value = await ctx.state.get('item-2', schema);

    expect(value).toEqual({ count: 5 });
  });

  it('get throws when the stored value fails validation against a provided Zod schema', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));
    const schema = z.object({ count: z.number() });

    await ctx.state.set('item-3', { count: 'not-a-number' });

    await expect(ctx.state.get('item-3', schema)).rejects.toThrow();
  });

  it('get returns null for a missing key even when a schema is supplied, without parsing null', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));
    const schema = z.object({ count: z.number() });

    await expect(ctx.state.get('never-written', schema)).resolves.toBeNull();
  });

  it('delete removes a key so a subsequent get returns null', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.set('item-4', { v: 1 });
    await ctx.state.delete('item-4');

    expect(await ctx.state.get('item-4')).toBeNull();
  });

  it('deleteMany removes multiple keys and returns the deleted count', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.set('item-5', { v: 1 });
    await ctx.state.set('item-6', { v: 2 });

    const deletedCount = await ctx.state.deleteMany(['item-5', 'item-6', 'item-missing']);

    expect(deletedCount).toBe(2);
    expect(await ctx.state.get('item-5')).toBeNull();
  });

  it('getMany returns a Map containing only the keys that exist', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.set('item-7', { v: 7 });

    const result = await ctx.state.getMany(['item-7', 'item-missing']);

    expect(result.size).toBe(1);
    expect(result.get('item-7')).toEqual({ v: 7 });
  });

  it('setMany stores multiple entries in one call', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.setMany(
      new Map<string, unknown>([
        ['item-8', { v: 8 }],
        ['item-9', { v: 9 }],
      ]),
    );

    expect(await ctx.state.get('item-8')).toEqual({ v: 8 });
    expect(await ctx.state.get('item-9')).toEqual({ v: 9 });
  });

  it('list filters by prefix and includes only matching, existing keys', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.set('list.a-1', { v: 1 });
    await ctx.state.set('list.a-2', { v: 2 });
    await ctx.state.set('other.b-1', { v: 3 });

    const page = await ctx.state.list('list.');

    expect(page.items.map((i) => i.key).sort()).toEqual(['list.a-1', 'list.a-2']);
  });

  it('list paginates via a cursor when more keys exist than the page limit', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    await ctx.state.set('page.a-1', { v: 1 });
    await ctx.state.set('page.a-2', { v: 2 });

    const firstPage = await ctx.state.list('page.', { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.cursor).toBeDefined();

    const secondPage = await ctx.state.list('page.', {
      limit: 1,
      cursor: firstPage.cursor as string,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.cursor).toBeUndefined();

    const allKeys = [...firstPage.items, ...secondPage.items].map((i) => i.key).sort();
    expect(allKeys).toEqual(['page.a-1', 'page.a-2']);
  });

  it('list returns no items when no keys match the prefix', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    const page = await ctx.state.list('nonexistent-prefix.');

    expect(page.items).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('list falls back to getMany when the provider does not supply pre-fetched values', async () => {
    const listMock = vi.fn(async () => ({ keys: ['k-1', 'k-2'] }));
    const getManyMock = vi.fn(async () => new Map<string, unknown>([['k-1', { v: 1 }]]));
    const fakeStorage = { list: listMock, getMany: getManyMock } as unknown as StorageService;

    const ctx = createContext(
      buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }), storage: fakeStorage }),
    );

    const page = await ctx.state.list('k-');

    expect(getManyMock).toHaveBeenCalledWith(['k-1', 'k-2'], expect.anything());
    // k-2 has no value returned by getMany, so it is silently excluded.
    expect(page.items).toEqual([{ key: 'k-1', value: { v: 1 } }]);
  });

  it('scopes state by tenant so two contexts sharing one StorageService cannot read each other', async () => {
    const storage = new StorageService(new InMemoryProvider());
    const ctxA = createContext(
      buildDeps({
        appContext: buildAppContext({ requestId: 'r-a', tenantId: 'tenant-a' }),
        storage,
      }),
    );
    const ctxB = createContext(
      buildDeps({
        appContext: buildAppContext({ requestId: 'r-b', tenantId: 'tenant-b' }),
        storage,
      }),
    );

    await ctxA.state.set('shared-key', 'a-value');
    await ctxB.state.set('shared-key', 'b-value');

    expect(await ctxA.state.get('shared-key')).toBe('a-value');
    expect(await ctxB.state.get('shared-key')).toBe('b-value');
  });

  it('operates under the auto-defaulted "default" tenant when appContext carries none', async () => {
    const ctx = createContext(buildDeps({ appContext: buildAppContext() }));

    expect(ctx.tenantId).toBe('default');
    await ctx.state.set('key', 'val');

    expect(await ctx.state.get('key')).toBe('val');
  });

  it('forwards a ttl to StorageService.set and passes no options when ttl is absent', async () => {
    const storage = new StorageService(new InMemoryProvider());
    const setSpy = vi.spyOn(storage, 'set');
    const ctx = createContext(
      buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }), storage }),
    );

    await ctx.state.set('ephemeral', 'data', { ttl: 3600 });
    await ctx.state.set('permanent', 'data');

    expect(setSpy).toHaveBeenNthCalledWith(
      1,
      'ephemeral',
      'data',
      expect.objectContaining({ tenantId: 'tenant-a' }),
      { ttl: 3600 },
    );
    expect(setSpy).toHaveBeenNthCalledWith(
      2,
      'permanent',
      'data',
      expect.objectContaining({ tenantId: 'tenant-a' }),
      undefined,
    );
  });

  it('forwards a ttl to StorageService.setMany', async () => {
    const storage = new StorageService(new InMemoryProvider());
    const setManySpy = vi.spyOn(storage, 'setMany');
    const ctx = createContext(
      buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }), storage }),
    );
    const entries = new Map<string, unknown>([
      ['a', 1],
      ['b', 2],
    ]);

    await ctx.state.setMany(entries, { ttl: 600 });

    expect(setManySpy).toHaveBeenCalledWith(
      entries,
      expect.objectContaining({ tenantId: 'tenant-a' }),
      { ttl: 600 },
    );
  });

  it('throws McpError(InvalidRequest) for any state operation when tenantId is missing (fail-closed)', async () => {
    const ctx = createContext(
      buildDeps({ appContext: buildAppContext(), defaultTenantId: undefined }),
    );

    expect(ctx.tenantId).toBeUndefined();
    await expect(ctx.state.get('any-key')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
    });
    await expect(ctx.state.set('any-key', 1)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
    });
  });

  it('short-circuits every state operation on an already-aborted signal', async () => {
    const methods = {
      delete: vi.fn(),
      deleteMany: vi.fn(),
      get: vi.fn(),
      getMany: vi.fn(),
      list: vi.fn(),
      set: vi.fn(),
      setMany: vi.fn(),
    };
    const fakeStorage = methods as unknown as StorageService;
    const controller = new AbortController();
    controller.abort();

    const ctx = createContext(
      buildDeps({
        appContext: buildAppContext({ tenantId: 'tenant-a' }),
        storage: fakeStorage,
        signal: controller.signal,
      }),
    );

    await expect(ctx.state.get('any-key')).rejects.toThrow();
    await expect(ctx.state.set('any-key', 1)).rejects.toThrow();
    await expect(ctx.state.delete('any-key')).rejects.toThrow();
    expect(() => ctx.state.getMany(['any-key'])).toThrow();
    expect(() => ctx.state.deleteMany(['any-key'])).toThrow();
    await expect(ctx.state.setMany(new Map([['any-key', 1]]))).rejects.toThrow();
    await expect(ctx.state.list('any-key')).rejects.toThrow();
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });
});
describe('createContext — multi-round-trip input wiring', () => {
  it('reads a retried request’s responses through ctx.inputs (accepted / view / state / dropped)', () => {
    const inputs = createContextInputs(
      {
        inputResponses: {
          confirm: { action: 'accept', content: { ok: true } },
          cancelled: { action: 'cancel' },
        },
        droppedInputResponseKeys: ['wrapped'],
        requestState: () => 'round-1',
      } as never,
      { elicitation: {} },
    );
    const ctx = createContext(buildDeps({ inputs }));

    expect(ctx.inputs.accepted('confirm', z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(ctx.inputs.accepted('cancelled')).toBeUndefined();
    expect(ctx.inputs.view('cancelled')).toEqual({ kind: 'elicit', action: 'cancel' });
    expect(ctx.inputs.view('never-asked')).toEqual({ kind: 'missing' });
    expect(ctx.inputs.state()).toBe('round-1');
    expect(ctx.inputs.dropped).toEqual(['wrapped']);
  });

  it('forwards the resolved client capabilities onto ctx.clientCapabilities (#580)', () => {
    const declared = { roots: {}, extensions: { 'io.modelcontextprotocol/ui': {} } };

    expect(createContext(buildDeps({ clientCapabilities: declared })).clientCapabilities).toBe(
      declared,
    );
    expect(createContext(buildDeps({ clientCapabilities: {} })).clientCapabilities).toEqual({});
  });

  it('has an always-present clientCapabilities key, undefined when no view was supplied', () => {
    const ctx = createContext(buildDeps());

    expect(Object.hasOwn(ctx, 'clientCapabilities')).toBe(true);
    expect(ctx.clientCapabilities).toBeUndefined();
  });

  it('defaults to an empty inputs reader on the first round', () => {
    const ctx = createContext(buildDeps());

    expect(ctx.inputs.accepted('confirm')).toBeUndefined();
    expect(ctx.inputs.view('confirm')).toEqual({ kind: 'missing' });
    expect(ctx.inputs.state()).toBeUndefined();
    expect(ctx.inputs.dropped).toEqual([]);
    expect(ctx.inputs.responses).toBeUndefined();
  });

  it('throws a signal carrying the SDK input_required result for the requested elicitation', () => {
    const ctx = createContext(buildDeps());

    let thrown: unknown;
    try {
      ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: 'Delete it?',
            requestedSchema: z.object({ ok: z.boolean() }),
          }),
        },
        requestState: 'round-1',
      });
    } catch (error) {
      thrown = error;
    }

    expect(isInputRequiredSignal(thrown)).toBe(true);
    const { result } = thrown as InputRequiredSignal;
    expect(result.resultType).toBe('input_required');
    expect(result.requestState).toBe('round-1');
    expect(result.inputRequests?.confirm).toMatchObject({
      method: 'elicitation/create',
      params: { message: 'Delete it?', mode: 'form' },
    });
  });

  it('rejects a spec carrying neither inputRequests nor requestState', () => {
    const ctx = createContext(buildDeps());

    expect(() => ctx.requestInput({})).toThrow(TypeError);
  });
});

describe('ContextLogger — wire sink (ctx.mcpReq.log mirror)', () => {
  function buildWireCtx() {
    const wireLog = vi.fn(async () => {});
    const ctx = createContext(
      buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-wire' }), wireLog }),
    );
    return { ctx, wireLog };
  }

  it.each<[Exclude<keyof Context['log'], 'error'>, LoggingLevel]>([
    ['debug', 'debug'],
    ['info', 'info'],
    ['notice', 'notice'],
    ['warning', 'warning'],
  ])('mirrors ctx.log.%s to the wire at RFC 5424 level "%s"', (method, level) => {
    const { ctx, wireLog } = buildWireCtx();

    ctx.log[method]('hello', { step: 1 });

    expect(wireLog).toHaveBeenCalledWith(level, { message: 'hello', step: 1 });
  });

  it('sends only { message } when no call-site data is supplied', () => {
    const { ctx, wireLog } = buildWireCtx();

    ctx.log.info('bare');

    expect(wireLog).toHaveBeenCalledWith('info', { message: 'bare' });
  });

  it('adds error: <message> to the wire payload when an Error is supplied', () => {
    const { ctx, wireLog } = buildWireCtx();

    ctx.log.error('failed', new Error('boom'), { detail: 'x' });

    expect(wireLog).toHaveBeenCalledWith('error', {
      message: 'failed',
      detail: 'x',
      error: 'boom',
    });
  });

  it('mirrors ctx.log.error with an Error whose message cannot be read, error: [Unreadable] (#697)', () => {
    const { ctx, wireLog } = buildWireCtx();
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const unreadable = Object.defineProperty(new Error('unused'), 'message', {
      get() {
        throw new Error('message getter threw');
      },
    });

    ctx.log.error('failed', unreadable, { detail: 'x' });

    expect(wireLog).toHaveBeenCalledWith('error', {
      message: 'failed',
      detail: 'x',
      error: '[Unreadable]',
    });
  });

  it.each([
    ['a Symbol', Symbol('m'), 'Symbol(m)'],
    ['a number', 404, '404'],
    [
      'an object whose toJSON throws',
      {
        toJSON(): never {
          throw new Error('toJSON threw');
        },
      },
      '[Unreadable]',
    ],
  ])(
    'mirrors ctx.log.error with an Error whose message is %s, its error key as text (#697)',
    (_label, value, text) => {
      const { ctx, wireLog } = buildWireCtx();
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const failure = Object.defineProperty(new Error('unused'), 'message', { value });

      ctx.log.error('failed', failure, { detail: 'x' });

      // The payload as the transport serializes it into the notification.
      const [, payload] = (wireLog.mock.calls as unknown[][])[0] as [unknown, unknown];
      expect(JSON.stringify(payload)).toBe(
        `{"message":"failed","detail":"x","error":${JSON.stringify(text)}}`,
      );
    },
  );

  it('omits the error key when ctx.log.error is called without an Error', () => {
    const { ctx, wireLog } = buildWireCtx();

    ctx.log.error('failed', undefined, { detail: 'y' });

    expect(wireLog).toHaveBeenCalledWith('error', { message: 'failed', detail: 'y' });
  });

  it('serializes a payload with no reserved key exactly as { message, ...data }', () => {
    const { ctx, wireLog } = buildWireCtx();

    ctx.log.warning('hello', { step: 1, reason: 'r' });
    ctx.log.error('failed', new Error('boom'), { detail: 'x' });

    // Key order is part of what a client sees on the wire, not just the key set.
    const payloads = (wireLog.mock.calls as unknown[][]).map((call) => JSON.stringify(call[1]));
    expect(payloads).toEqual([
      '{"message":"hello","step":1,"reason":"r"}',
      '{"message":"failed","detail":"x","error":"boom"}',
    ]);
  });

  // #502 — a `message` key in call-site data replaced the log line on the wire.
  it('keeps the log line as the wire message when data carries its own message key', () => {
    const { ctx, wireLog } = buildWireCtx();
    const warningSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    ctx.log.warning('fallback failed; answering from cache', {
      message: 'upstream quota reached',
      reason: 'quota_exceeded',
    });

    expect(wireLog).toHaveBeenCalledWith('warning', {
      message: 'fallback failed; answering from cache',
      reason: 'quota_exceeded',
    });
    // The process logger still receives the caller's own field.
    expect(warningSpy).toHaveBeenCalledWith(
      'fallback failed; answering from cache',
      expect.objectContaining({
        extra: expect.objectContaining({ message: 'upstream quota reached' }),
      }),
    );
  });

  it('keeps the log line and the Error message on ctx.log.error when data collides with both', () => {
    const { ctx, wireLog } = buildWireCtx();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    ctx.log.error('fetch failed', new Error('socket hang up'), {
      message: 'upstream said no',
      error: 'caller error text',
    });

    expect(wireLog).toHaveBeenCalledWith('error', {
      message: 'fetch failed',
      error: 'socket hang up',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'fetch failed',
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ message: 'upstream said no' }),
      }),
    );
  });

  it('swallows a rejecting wire sink — a log that cannot flush never fails the handler', async () => {
    const wireLog = vi.fn(async () => {
      throw new Error('transport gone');
    });
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const ctx = createContext(buildDeps({ wireLog }));

    expect(() => ctx.log.info('still logged')).not.toThrow();
    // Flush the rejected promise's microtask queue; an unhandled rejection here
    // would fail the run.
    await Promise.resolve();
    await Promise.resolve();

    expect(wireLog).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('still logged', expect.anything());
  });

  it('still writes to the Pino sink when no wire sink is wired', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const ctx = createContext(buildDeps());

    ctx.log.info('no wire');
    ctx.log.error('no wire either');

    expect(infoSpy).toHaveBeenCalledWith('no wire', expect.anything());
    expect(errorSpy).toHaveBeenCalledWith('no wire either', expect.anything());
  });

  it('serializes dates, URLs, arrays, and nested values as the data would, and an Error as { type, message }', () => {
    const { ctx, wireLog } = buildWireCtx();
    class Upstream {
      region = 'us-west';
      describe() {
        return this.region;
      }
    }
    const data = {
      when: new Date(0),
      url: new URL('https://api.example.test/v1/items?page=2'),
      pages: [1, { cursor: 'c2', seen: [true, null] }],
      nested: { level1: { level2: { level3: 'deep' } } },
      cause: new Error('upstream failed'),
      upstream: new Upstream(),
      seen: new Map([['a', 1]]),
      skipped: undefined,
    };

    ctx.log.info('shapes', data);

    const [[, payload]] = wireLog.mock.calls as unknown as [[string, unknown]];
    expect(JSON.stringify(payload)).toBe(
      JSON.stringify({
        message: 'shapes',
        ...data,
        cause: { type: 'Error', message: 'upstream failed' },
      }),
    );
  });

  // #646 — the mirror sent an Error's enumerable own properties: a request URL, a server file path.
  it('writes each Error in data as { type, message } only, at any depth and over its toJSON', () => {
    const { ctx, wireLog } = buildWireCtx();
    const rejection = Object.assign(
      new TypeError('Unable to connect.', { cause: new Error('connect ECONNREFUSED') }),
      {
        code: 'ConnectionRefused',
        path: 'http://127.0.0.1:3619/sk-test-0000/reverse?api-key=QSECRET-9999',
        sourceURL: '/srv/app/handler.js',
        line: 36,
      },
    );
    const libraryError = Object.assign(new Error('library failure'), {
      toJSON: () => ({ message: 'library failure', config: { url: 'https://api.example.test' } }),
    });
    const aborted = AbortSignal.abort().reason as DOMException;

    ctx.log.warning('errors', {
      error: rejection,
      nested: { attempts: [libraryError, { last: rejection }] },
      aborted,
    });

    expect(wireLog).toHaveBeenCalledWith('warning', {
      message: 'errors',
      error: { type: 'TypeError', message: 'Unable to connect.' },
      nested: {
        attempts: [
          { type: 'Error', message: 'library failure' },
          { last: { type: 'TypeError', message: 'Unable to connect.' } },
        ],
      },
      aborted: { type: 'AbortError', message: aborted.message },
    });
  });

  it('never fails the handler on a value whose toJSON throws, and mirrors it as [Unreadable]', () => {
    const { ctx, wireLog } = buildWireCtx();
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const exploding = {
      toJSON() {
        throw new Error('cannot serialize');
      },
    };

    expect(() => ctx.log.info('odd value', { exploding, kept: 1 })).not.toThrow();
    expect(wireLog).toHaveBeenCalledWith('info', {
      message: 'odd value',
      exploding: '[Unreadable]',
      kept: 1,
    });
  });

  it('never fails the handler when the log data object itself cannot be read (#695)', () => {
    const { ctx } = buildWireCtx();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const throwingGetter = {
      kept: 1,
      get broken(): never {
        throw new Error('getter threw');
      },
    };
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => ctx.log.info('getter', throwingGetter)).not.toThrow();
    expect(() => ctx.log.info('revoked', revoked)).not.toThrow();

    const extraOf = (call: number) =>
      (info.mock.calls[call]?.[1] as { extra?: Record<string, unknown> } | undefined)?.extra;
    expect(extraOf(0)).toMatchObject({ kept: 1, broken: '[Unreadable]' });
    expect(extraOf(1)).toMatchObject({ data: '[Unreadable]' });
  });

  // #695 — the mirror walked log data with no depth bound or budget and read it unguarded.
  describe('bounds and unreadable values (#695)', () => {
    it('stops at depth 16 with [MaxDepth] and still delivers a 20,000-level value', () => {
      const { ctx, wireLog } = buildWireCtx();
      vi.spyOn(logger, 'info').mockImplementation(() => {});
      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 20_000; i++) deep = { n: deep };

      ctx.log.info('deep', { deep });

      expect(wireLog).toHaveBeenCalledTimes(1);
      const [[, payload]] = wireLog.mock.calls as unknown as [[string, Record<string, unknown>]];
      // `deep` sits at depth 1 of the data, as in the process log: objects through 15, then the marker.
      let cursor: unknown = payload.deep;
      let objectLevels = 0;
      while (cursor !== null && typeof cursor === 'object') {
        cursor = (cursor as Record<string, unknown>).n;
        objectLevels++;
      }
      expect(objectLevels).toBe(15);
      expect(cursor).toBe('[MaxDepth]');
    });

    it('mirrors a shared-reference graph within the walk budget, marked [Truncated]', () => {
      const { ctx, wireLog } = buildWireCtx();
      vi.spyOn(logger, 'info').mockImplementation(() => {});
      let graph: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 16; i++) graph = { a: graph, b: graph, c: graph };

      const start = process.threadCpuUsage();
      ctx.log.info('graph', { graph });
      const { user, system } = process.threadCpuUsage(start);

      // Unbounded, the 3^16 paths take tens of seconds; bounded, a few ms (headroom for coverage and load).
      expect((user + system) / 1000).toBeLessThan(250);
      const payload = JSON.stringify(wireLog.mock.calls[0]);
      expect(payload).toContain('"[Truncated]"');
      // Bounded by the budget, not by the 3^16 paths through the graph.
      expect(payload.length).toBeLessThan(2_000_000);
    });

    it('mirrors each unreadable value as [Unreadable] and delivers the rest of the record', () => {
      const { ctx, wireLog } = buildWireCtx();
      vi.spyOn(logger, 'info').mockImplementation(() => {});
      const { proxy: revoked, revoke } = Proxy.revocable({ a: 1 }, {});
      revoke();
      const unreadable = {
        getter: {
          fine: 1,
          get boom(): never {
            throw new Error('getter threw');
          },
        },
        ownKeysTrap: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('ownKeys threw');
            },
          },
        ),
        revoked,
        messageAccessor: Object.defineProperty(new Error('unused'), 'message', {
          get() {
            throw new Error('message getter threw');
          },
        }),
      };

      ctx.log.info('unreadable', { top: unreadable, deep: { a: { b: { c: unreadable } } } });

      const mirrored = {
        getter: { fine: 1, boom: '[Unreadable]' },
        ownKeysTrap: '[Unreadable]',
        revoked: '[Unreadable]',
        messageAccessor: { type: 'Error', message: '[Unreadable]' },
      };
      expect(wireLog).toHaveBeenCalledWith('info', {
        message: 'unreadable',
        top: mirrored,
        deep: { a: { b: { c: mirrored } } },
      });
    });
  });

  // #630 — the wire payload went out with the caller's data unredacted.
  describe('sensitive-field masking (#630)', () => {
    it('masks sensitive fields at the top level and nested, leaving the rest as written', () => {
      const { ctx, wireLog } = buildWireCtx();

      ctx.log.info('upstream call', {
        apiKey: 'sk-live-123',
        password: 'hunter2',
        query: 'aspirin',
        upstream: { apiKey: 'sk-live-456', status: 200, auth: { token: 't-1', scheme: 'Bearer' } },
      });

      expect(wireLog).toHaveBeenCalledWith('info', {
        message: 'upstream call',
        apiKey: '[REDACTED]',
        password: '[REDACTED]',
        query: 'aspirin',
        upstream: {
          apiKey: '[REDACTED]',
          status: 200,
          auth: { token: '[REDACTED]', scheme: 'Bearer' },
        },
      });
    });

    it('masks past the depths the process log redact paths reach, through arrays and toJSON', () => {
      const { ctx, wireLog } = buildWireCtx();

      ctx.log.debug('deep', {
        a: { b: { c: { d: { secret: 's-4', kept: 4 } } } },
        attempts: [{ token: 't-1' }, { token: 't-2', ok: true }, ['plain', { cookie: 'c' }]],
        credentials: { toJSON: () => ({ client_secret: 'cs', clientId: 'id-1' }) },
      });

      expect(wireLog).toHaveBeenCalledWith('debug', {
        message: 'deep',
        a: { b: { c: { d: { secret: '[REDACTED]', kept: 4 } } } },
        attempts: [
          { token: '[REDACTED]' },
          { token: '[REDACTED]', ok: true },
          ['plain', { cookie: '[REDACTED]' }],
        ],
        credentials: { client_secret: '[REDACTED]', clientId: 'id-1' },
      });
    });

    it('masks any casing or separator of a sensitive name, and a name it is one word of', () => {
      const { ctx, wireLog } = buildWireCtx();

      ctx.log.warning('variants', {
        API_KEY: 'k-1',
        'Api-Key': 'k-2',
        Authorization: 'Bearer x',
        accessToken: 'at-1',
        tokenizer: 'kept',
      });

      expect(wireLog).toHaveBeenCalledWith('warning', {
        message: 'variants',
        API_KEY: '[REDACTED]',
        'Api-Key': '[REDACTED]',
        Authorization: '[REDACTED]',
        accessToken: '[REDACTED]',
        tokenizer: 'kept',
      });
    });

    // #696 — a sensitive name split across adjacent words of a longer key went out in clear.
    it('masks a name spanning adjacent words, and leaves token counters as written', () => {
      const { ctx, wireLog } = buildWireCtx();
      const headers = new Headers({ 'x-api-key': 'sk-live-0000', accept: 'application/json' });

      ctx.log.info('upstream', {
        'x-api-key': 'sk-live-0001',
        'X-Api-Key': 'sk-live-0002',
        upstream_private_key: 'pem',
        headers,
        max_tokens: 5,
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });

      const [[, payload]] = wireLog.mock.calls as unknown as [[string, Record<string, unknown>]];
      // Bun's Headers has a toJSON, Node's does not: either way no key reaches the wire.
      expect(JSON.stringify(payload)).not.toContain('sk-live');
      expect(payload).toMatchObject({
        message: 'upstream',
        'x-api-key': '[REDACTED]',
        'X-Api-Key': '[REDACTED]',
        upstream_private_key: '[REDACTED]',
        max_tokens: 5,
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    });

    it('masks a field registered through sanitization.setSensitiveFields', () => {
      sanitization.setSensitiveFields(['upstreamSignature']);
      const { ctx, wireLog } = buildWireCtx();

      ctx.log.notice('signed', {
        upstreamSignature: 'sig-1',
        response: { upstream_signature: 'sig-2', signatureAlgorithm: 'HS256' },
      });

      expect(wireLog).toHaveBeenCalledWith('notice', {
        message: 'signed',
        upstreamSignature: '[REDACTED]',
        response: { upstream_signature: '[REDACTED]', signatureAlgorithm: 'HS256' },
      });
    });

    it('keeps message and error framework-owned and leaves the caller data unmodified', () => {
      const { ctx, wireLog } = buildWireCtx();
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const data = { message: 'caller text', password: 'p-1', nested: { token: 't-1' } };
      const before = structuredClone(data);

      ctx.log.error('login failed', new Error('denied'), data);

      expect(wireLog).toHaveBeenCalledWith('error', {
        message: 'login failed',
        password: '[REDACTED]',
        nested: { token: '[REDACTED]' },
        error: 'denied',
      });
      expect(data).toEqual(before);
    });

    it('delivers a payload that refers back to itself, marking the cycle', () => {
      const { ctx, wireLog } = buildWireCtx();
      const node: Record<string, unknown> = { name: 'root', apiKey: 'k' };
      node.self = node;
      const shared = { id: 'shared' };

      ctx.log.info('cyclic', { node, left: shared, right: shared });

      expect(wireLog).toHaveBeenCalledWith('info', {
        message: 'cyclic',
        node: { name: 'root', apiKey: '[REDACTED]', self: '[Circular]' },
        left: { id: 'shared' },
        right: { id: 'shared' },
      });
    });
  });
});

describe('createContext inherits the RequestContext contract', () => {
  it('carries operation and extra through to the handler ctx', () => {
    // `Context extends RequestContext`, and the #110 contract is that a handler
    // ctx goes straight into `storage.get(key, ctx)` / `logger.info(msg, ctx)`.
    // Dropping these loses the operation and every `additionalContext` field
    // the request was created with.
    const ctx = createContext(
      buildDeps({
        appContext: buildAppContext({
          operation: 'HandleToolRequest',
          extra: { toolName: 'echo_message' },
        }),
      }),
    );

    expect(ctx.operation).toBe('HandleToolRequest');
    expect(ctx.extra).toEqual({ toolName: 'echo_message' });
  });
});
