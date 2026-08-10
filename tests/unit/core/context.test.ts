/**
 * @fileoverview Unit tests for the unified Context construction, the error
 * contract helpers (createFail/createRecoveryFor/attachTypedFail), the
 * enrichment/content accumulators, and the request-scoped logger/state/
 * progress wiring in src/core/context.ts.
 * @module tests/unit/core/context.test
 */

import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '@/core/context.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { type ErrorContract, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

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

function buildDeps(overrides: Partial<ContextDeps> = {}): ContextDeps {
  return {
    appContext: buildAppContext(),
    logger,
    signal: new AbortController().signal,
    storage: new StorageService(new InMemoryProvider()),
    ...overrides,
  };
}

/**
 * Sets or unsets a `process.env` var. Assigning `undefined` directly (e.g.
 * `process.env.KEY = undefined`) does not reliably leave the key absent —
 * under this suite's worker pool it coerces to the string `"undefined"`,
 * which then fails downstream Zod enum validation (e.g. the real
 * `ConfigSchema`'s `mcpTransportType`/`mcpAuthMode` fields read by
 * `StorageService`). `delete` is the only form that reliably unsets it.
 */
function setEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// Applies to every test in this file: keeps the tenantId-resolution env vars
// deterministic regardless of ambient process state, and undoes any
// `vi.spyOn` set up on the shared `logger` singleton so later tests never
// observe an earlier test's mocked logger implementation.
beforeEach(() => {
  delete process.env.MCP_TRANSPORT_TYPE;
  delete process.env.MCP_AUTH_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(err.data?.reason).toBe('typo_reason');
    expect(err.data?.declaredReasons).toEqual([
      'no_match',
      'queue_full',
      'permanent_denial',
      'no_retry_hint',
    ]);
  });
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

  it('stashes stores under non-enumerable symbol keys invisible to Object.keys/JSON.stringify', () => {
    const ctx = createContext(buildDeps());

    expect(Object.keys(ctx)).not.toContain('enrichmentStore');
    expect(Object.keys(ctx)).not.toContain('contentStore');
    expect(JSON.stringify(ctx)).not.toMatch(/mcp\.(enrichment|content)Store/);
  });
});

describe('createContext — tenantId resolution', () => {
  it('preserves an explicit appContext.tenantId even under HTTP + jwt auth', () => {
    process.env.MCP_TRANSPORT_TYPE = 'http';
    process.env.MCP_AUTH_MODE = 'jwt';

    const ctx = createContext(buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }) }));

    expect(ctx.tenantId).toBe('tenant-a');
  });

  it.each([
    [undefined, undefined],
    ['stdio', undefined],
    ['stdio', 'jwt'],
    ['http', 'none'],
    ['http', undefined],
  ])(
    'defaults tenantId to "default" when appContext has none and transport=%s/auth=%s',
    (transportType, authMode) => {
      setEnvVar('MCP_TRANSPORT_TYPE', transportType);
      setEnvVar('MCP_AUTH_MODE', authMode);

      const ctx = createContext(buildDeps({ appContext: buildAppContext() }));

      expect(ctx.tenantId).toBe('default');
    },
  );

  it.each([['jwt'], ['oauth']])(
    'leaves tenantId undefined (fail-closed) when transport=http, auth=%s, and appContext has no tenantId',
    (authMode) => {
      process.env.MCP_TRANSPORT_TYPE = 'http';
      process.env.MCP_AUTH_MODE = authMode;

      const ctx = createContext(buildDeps({ appContext: buildAppContext() }));

      expect(ctx.tenantId).toBeUndefined();
    },
  );
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

  it('forwards sessionId from deps as-is, including when absent', () => {
    const withSession = createContext(buildDeps({ sessionId: 'session-123' }));
    expect(withSession.sessionId).toBe('session-123');

    const withoutSession = createContext(buildDeps());
    expect(withoutSession.sessionId).toBeUndefined();
  });

  it('casts traceId/spanId through from appContext when present', () => {
    const ctx = createContext(
      buildDeps({ appContext: buildAppContext({ traceId: 'trace-1', spanId: 'span-1' }) }),
    );

    expect(ctx.traceId).toBe('trace-1');
    expect(ctx.spanId).toBe('span-1');
  });

  it('leaves traceId/spanId undefined when absent from appContext', () => {
    const ctx = createContext(buildDeps());

    expect(ctx.traceId).toBeUndefined();
    expect(ctx.spanId).toBeUndefined();
  });

  it('forwards auth from appContext when present', () => {
    const auth = { clientId: 'client-1', scopes: ['tool:x:read'], sub: 'user-1' };
    const ctx = createContext(buildDeps({ appContext: buildAppContext({ auth }) }));

    expect(ctx.auth).toEqual(auth);
  });

  it('leaves auth undefined when absent from appContext', () => {
    const ctx = createContext(buildDeps());
    expect(ctx.auth).toBeUndefined();
  });

  it('forwards elicit from deps by reference, and leaves it undefined when absent', () => {
    const elicit = vi.fn() as unknown as Context['elicit'];
    const withElicit = createContext(buildDeps({ elicit }));
    expect(withElicit.elicit).toBe(elicit);

    const withoutElicit = createContext(buildDeps());
    expect(withoutElicit.elicit).toBeUndefined();
  });

  it('forwards notifyPromptListChanged from deps, undefined when absent', () => {
    const notifier = vi.fn();
    const withNotifier = createContext(buildDeps({ notifyPromptListChanged: notifier }));
    expect(withNotifier.notifyPromptListChanged).toBe(notifier);

    const withoutNotifier = createContext(buildDeps());
    expect(withoutNotifier.notifyPromptListChanged).toBeUndefined();
  });

  it('forwards notifyResourceListChanged from deps, undefined when absent', () => {
    const notifier = vi.fn();
    const withNotifier = createContext(buildDeps({ notifyResourceListChanged: notifier }));
    expect(withNotifier.notifyResourceListChanged).toBe(notifier);

    const withoutNotifier = createContext(buildDeps());
    expect(withoutNotifier.notifyResourceListChanged).toBeUndefined();
  });

  it('forwards notifyResourceUpdated from deps, undefined when absent', () => {
    const notifier = vi.fn();
    const withNotifier = createContext(buildDeps({ notifyResourceUpdated: notifier }));
    expect(withNotifier.notifyResourceUpdated).toBe(notifier);

    const withoutNotifier = createContext(buildDeps());
    expect(withoutNotifier.notifyResourceUpdated).toBeUndefined();
  });

  it('forwards notifyToolListChanged from deps, undefined when absent', () => {
    const notifier = vi.fn();
    const withNotifier = createContext(buildDeps({ notifyToolListChanged: notifier }));
    expect(withNotifier.notifyToolListChanged).toBe(notifier);

    const withoutNotifier = createContext(buildDeps());
    expect(withoutNotifier.notifyToolListChanged).toBeUndefined();
  });

  it('leaves progress undefined without a taskCtx, and defines it when a taskCtx is given', () => {
    const withoutTask = createContext(buildDeps());
    expect(withoutTask.progress).toBeUndefined();

    const store = { updateTaskStatus: vi.fn(async () => {}) } as unknown as RequestTaskStore;
    const withTask = createContext(buildDeps({ taskCtx: { store, taskId: 'task-1' } }));
    expect(withTask.progress).toBeDefined();
  });

  it('forwards uri from deps, undefined when absent', () => {
    const uri = new URL('myscheme://item/123');
    const withUri = createContext(buildDeps({ uri }));
    expect(withUri.uri).toBe(uri);

    const withoutUri = createContext(buildDeps());
    expect(withoutUri.uri).toBeUndefined();
  });

  it('always exposes callable content/enrich accumulators and a no-op recoveryFor', () => {
    const ctx = createContext(buildDeps());

    expect(typeof ctx.content).toBe('function');
    expect(typeof ctx.enrich).toBe('function');
    expect(ctx.recoveryFor('anything')).toEqual({});
  });

  it('initializes fresh, empty enrichment and content stores readable via the internal accessors', () => {
    const ctx = createContext(buildDeps());

    expect(readEnrichmentStore(ctx)).toEqual({ values: {}, kinds: new Map() });
    expect(readContentStore(ctx)).toEqual({ blocks: [] });
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
      expect.objectContaining({ requestId: 'req-log', extra: 1 }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'info msg',
      expect.objectContaining({ requestId: 'req-log', extra: 2 }),
    );
    expect(noticeSpy).toHaveBeenCalledWith(
      'notice msg',
      expect.objectContaining({ requestId: 'req-log', extra: 3 }),
    );
    expect(warningSpy).toHaveBeenCalledWith(
      'warning msg',
      expect.objectContaining({ requestId: 'req-log', extra: 4 }),
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

  it('error(msg, error, data) forwards the Error object and enriched data in the 3-arg form', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const appContext = buildAppContext({ requestId: 'req-err' });
    const ctx = createContext(buildDeps({ appContext }));
    const boom = new Error('boom');

    ctx.log.error('failed', boom, { detail: 'x' });

    expect(errorSpy).toHaveBeenCalledWith(
      'failed',
      boom,
      expect.objectContaining({ requestId: 'req-err', detail: 'x' }),
    );
  });

  it('error(msg) without an Error object forwards the enriched context in the 2-arg form', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const appContext = buildAppContext({ requestId: 'req-err-2' });
    const ctx = createContext(buildDeps({ appContext }));

    ctx.log.error('failed without error object', undefined, { detail: 'y' });

    expect(errorSpy).toHaveBeenCalledWith(
      'failed without error object',
      expect.objectContaining({ requestId: 'req-err-2', detail: 'y' }),
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

  it('list uses provider-supplied pre-fetched values instead of issuing a getMany call', async () => {
    const listMock = vi.fn(async () => ({
      keys: ['pre-1', 'pre-2'],
      values: new Map<string, unknown>([
        ['pre-1', { v: 1 }],
        ['pre-2', { v: 2 }],
      ]),
    }));
    const getManyMock = vi.fn(async () => new Map());
    const fakeStorage = { list: listMock, getMany: getManyMock } as unknown as StorageService;

    const ctx = createContext(
      buildDeps({ appContext: buildAppContext({ tenantId: 'tenant-a' }), storage: fakeStorage }),
    );

    const page = await ctx.state.list('pre-');

    expect(page.items).toEqual([
      { key: 'pre-1', value: { v: 1 } },
      { key: 'pre-2', value: { v: 2 } },
    ]);
    expect(getManyMock).not.toHaveBeenCalled();
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

  it('throws McpError(InvalidRequest) for any state operation when tenantId is missing (fail-closed)', async () => {
    process.env.MCP_TRANSPORT_TYPE = 'http';
    process.env.MCP_AUTH_MODE = 'jwt';
    const ctx = createContext(buildDeps({ appContext: buildAppContext() }));

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

describe('ContextProgress (ctx.progress)', () => {
  function buildProgressCtx() {
    const updateTaskStatus = vi.fn(async () => {});
    const store = { updateTaskStatus } as unknown as RequestTaskStore;
    const ctx = createContext(buildDeps({ taskCtx: { store, taskId: 'task-42' } }));
    return { ctx, updateTaskStatus };
  }

  it('setTotal sets the total and resets completed without calling the task store', async () => {
    const { ctx, updateTaskStatus } = buildProgressCtx();

    await ctx.progress?.setTotal(10);

    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('increment without a prior setTotal advances without clamping and reports no percentage', async () => {
    const { ctx, updateTaskStatus } = buildProgressCtx();

    await ctx.progress?.increment();
    await ctx.progress?.increment(2);

    expect(updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-42', 'working', undefined);
    expect(updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-42', 'working', undefined);
  });

  it('increment after setTotal reports a rounded percentage message', async () => {
    const { ctx, updateTaskStatus } = buildProgressCtx();

    await ctx.progress?.setTotal(4);
    await ctx.progress?.increment(1);

    expect(updateTaskStatus).toHaveBeenCalledWith('task-42', 'working', '25% complete');
  });

  it('increment clamps completed at the total and does not exceed 100%', async () => {
    const { ctx, updateTaskStatus } = buildProgressCtx();

    await ctx.progress?.setTotal(2);
    await ctx.progress?.increment(5);
    await ctx.progress?.increment(5);

    expect(updateTaskStatus).toHaveBeenLastCalledWith('task-42', 'working', '100% complete');
  });

  it('update sends a status message without advancing completed/total', async () => {
    const { ctx, updateTaskStatus } = buildProgressCtx();

    await ctx.progress?.update('halfway there');

    expect(updateTaskStatus).toHaveBeenCalledWith('task-42', 'working', 'halfway there');
  });
});
