/**
 * @fileoverview Unit tests for the building blocks shared by storage providers.
 * @module tests/unit/storage/core/providerHelpers.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeEnvelope,
  deleteManyViaDelete,
  encodeEntries,
  encodeEnvelope,
  escapeLikePattern,
  getManyViaGet,
  paginateSortedKeys,
  serializeValue,
  setManyViaSet,
} from '@/storage/core/providerHelpers.js';
import { decodeCursor } from '@/storage/core/storageValidation.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

function cyclicValue(): Record<string, unknown> {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  return cyclic;
}

describe('value encoding', () => {
  it('serializeValue returns the JSON text of an encodable value', () => {
    expect(serializeValue('k', { at: new Date('2026-01-01T00:00:00.000Z'), n: 1 })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z","n":1}',
    );
    expect(serializeValue('k', null)).toBe('null');
  });

  it.each([
    ['a bigint', { big: 10n }],
    ['a cyclic reference', cyclicValue()],
    ['a top-level undefined', undefined],
    ['a top-level function', () => 1],
    ['a top-level symbol', Symbol('s')],
    ['a toJSON that returns undefined', { toJSON: () => undefined }],
  ])('serializeValue rejects %s with a SerializationError naming the key', (_label, value) => {
    let thrown: unknown;
    try {
      serializeValue('item/1', value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
    expect((thrown as McpError).message).toContain('"item/1"');
  });

  it('encodeEntries encodes the whole batch, or throws before returning any of it', () => {
    expect(
      encodeEntries(
        new Map<string, unknown>([
          ['a', 1],
          ['b', { n: 2 }],
        ]),
      ),
    ).toEqual(
      new Map([
        ['a', '1'],
        ['b', '{"n":2}'],
      ]),
    );
    const encode = vi.fn(serializeValue);
    expect(() =>
      encodeEntries(
        new Map<string, unknown>([
          ['bad', undefined],
          ['good', 1],
        ]),
        encode,
      ),
    ).toThrow(McpError);
    expect(encode).toHaveBeenCalledTimes(1);
  });
});

describe('batch operations over single-key methods', () => {
  it('getManyViaGet fans out in parallel and omits misses', async () => {
    const store = new Map([
      ['a', 1],
      ['c', 3],
    ]);
    const get = vi.fn((key: string) => Promise.resolve(store.get(key) ?? null));

    const result = await getManyViaGet(['a', 'b', 'c'], get);

    expect(get).toHaveBeenCalledTimes(3);
    expect([...result]).toEqual([
      ['a', 1],
      ['c', 3],
    ]);
  });

  it('getManyViaGet short-circuits an empty key list', async () => {
    const get = vi.fn();
    expect((await getManyViaGet([], get)).size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });

  it('setManyViaSet writes every entry', async () => {
    const set = vi.fn(() => Promise.resolve());
    await setManyViaSet(
      new Map<string, unknown>([
        ['a', 1],
        ['b', 2],
      ]),
      set,
    );
    expect(set.mock.calls).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('setManyViaSet short-circuits an empty entry map', async () => {
    const set = vi.fn(() => Promise.resolve());
    await expect(setManyViaSet(new Map(), set)).resolves.toBeUndefined();
    expect(set).not.toHaveBeenCalled();
  });

  it('deleteManyViaDelete counts only confirmed deletions', async () => {
    const del = (key: string) => Promise.resolve(key !== 'missing');
    expect(await deleteManyViaDelete(['a', 'missing', 'b'], del)).toBe(2);
    expect(await deleteManyViaDelete([], del)).toBe(0);
  });
});

describe('TTL envelope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a value without a TTL', () => {
    const raw = encodeEnvelope('{"n":1}');
    expect(raw).toBe(JSON.stringify({ __mcp: { v: 1 }, value: { n: 1 } }));
    expect(decodeEnvelope(raw)).toEqual({ kind: 'value', value: { n: 1 } });
  });

  it('treats ttl: 0 as an expiry, not as "no TTL"', () => {
    vi.useFakeTimers({ now: 1_000 });
    const raw = encodeEnvelope('"v"', { ttl: 0 });
    expect(JSON.parse(raw).__mcp.expiresAt).toBe(1_000);
    vi.setSystemTime(1_001);
    expect(decodeEnvelope(raw)).toEqual({ kind: 'expired' });
  });

  it('reports a lapsed TTL and honours one still in the future', () => {
    vi.useFakeTimers({ now: 10_000 });
    const raw = encodeEnvelope('"v"', { ttl: 5 });
    expect(decodeEnvelope(raw)).toEqual({ kind: 'value', value: 'v' });
    vi.setSystemTime(15_001);
    expect(decodeEnvelope(raw)).toEqual({ kind: 'expired' });
  });

  it('returns a pre-envelope document as the value itself', () => {
    expect(decodeEnvelope('{"legacy":true}')).toEqual({ kind: 'value', value: { legacy: true } });
  });

  it('throws on invalid JSON so the provider can attach key context', () => {
    expect(() => decodeEnvelope('{not json')).toThrow(SyntaxError);
  });
});

describe('paginateSortedKeys', () => {
  const context = requestContextService.createRequestContext({ operation: 'test' });
  const keys = ['a', 'b', 'c', 'd', 'e'];

  it('returns the first page with a cursor bound to the tenant', () => {
    const page = paginateSortedKeys(keys, 'tenant-1', undefined, 2);
    expect(page.keys).toEqual(['a', 'b']);
    expect(page.nextCursor).toBeDefined();
    expect(decodeCursor(page.nextCursor as string, 'tenant-1', context)).toBe('b');
  });

  it('resumes after the cursor key', () => {
    expect(paginateSortedKeys(keys, 't', 'b', 2).keys).toEqual(['c', 'd']);
  });

  it('resumes from the next key when the cursor key was deleted between pages', () => {
    expect(paginateSortedKeys(['a', 'c', 'd'], 't', 'b', 2).keys).toEqual(['c', 'd']);
  });

  it('omits the cursor on the last page', () => {
    const page = paginateSortedKeys(keys, 't', 'c', 5);
    expect(page.keys).toEqual(['d', 'e']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('yields an empty page past the end', () => {
    expect(paginateSortedKeys(keys, 't', 'z', 2)).toEqual({ keys: [], nextCursor: undefined });
  });
});

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(escapeLikePattern('plain')).toBe('plain');
  });
});
