/**
 * @fileoverview Building blocks shared by storage providers whose backend has
 * no native batch, TTL, or page primitive: batch operations as parallel
 * fan-out over the single-key methods, the TTL envelope the blob-style
 * providers store, one page of a sorted key list, and the SQL `LIKE` escape.
 * @module src/storage/core/providerHelpers
 */

import type { StorageOptions } from '@/storage/core/IStorageProvider.js';
import { encodeCursor } from '@/storage/core/storageValidation.js';

// ---------------------------------------------------------------------------
// Batch operations over single-key methods
// ---------------------------------------------------------------------------

/** `getMany` as a parallel `get` per key; keys that resolve to `null` are omitted. */
export async function getManyViaGet<T>(
  keys: readonly string[],
  get: (key: string) => Promise<T | null>,
): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  if (keys.length === 0) return results;
  const values = await Promise.all(keys.map((key) => get(key)));
  keys.forEach((key, i) => {
    const value = values[i];
    if (value !== null && value !== undefined) results.set(key, value);
  });
  return results;
}

/** `setMany` as a parallel `set` per entry. */
export async function setManyViaSet(
  entries: ReadonlyMap<string, unknown>,
  set: (key: string, value: unknown) => Promise<void>,
): Promise<void> {
  if (entries.size === 0) return;
  await Promise.all(Array.from(entries, ([key, value]) => set(key, value)));
}

/** `deleteMany` as a parallel `delete` per key; returns how many reported a deletion. */
export async function deleteManyViaDelete(
  keys: readonly string[],
  del: (key: string) => Promise<boolean>,
): Promise<number> {
  if (keys.length === 0) return 0;
  const results = await Promise.all(keys.map((key) => del(key)));
  return results.filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// TTL envelope
// ---------------------------------------------------------------------------

/**
 * The document a blob-style provider (R2, filesystem) stores: the value plus
 * the framework marker that carries its expiry, since the backend has no TTL
 * of its own.
 */
export interface StorageEnvelope {
  __mcp: { v: 1; expiresAt?: number };
  value: unknown;
}

/** Wraps `value` for storage; `options.ttl` (seconds, `0` included) sets `expiresAt`. */
export function encodeEnvelope(value: unknown, options?: StorageOptions): StorageEnvelope {
  const expiresAt = options?.ttl !== undefined ? Date.now() + options.ttl * 1000 : undefined;
  return {
    __mcp: { v: 1, ...(expiresAt !== undefined && { expiresAt }) },
    value,
  };
}

export type DecodedEnvelope<T> = { kind: 'value'; value: T } | { kind: 'expired' };

/**
 * Parses a stored document. A document without the marker is a value stored
 * before envelopes existed and is returned as-is. Throws `SyntaxError` on
 * invalid JSON so the provider can attach its own key context.
 */
export function decodeEnvelope<T>(raw: string): DecodedEnvelope<T> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && '__mcp' in parsed) {
    const envelope = parsed as StorageEnvelope;
    const expiresAt = envelope.__mcp?.expiresAt;
    if (expiresAt && Date.now() > expiresAt) return { kind: 'expired' };
    return { kind: 'value', value: envelope.value as T };
  }
  return { kind: 'value', value: parsed as T };
}

// ---------------------------------------------------------------------------
// Cursor pagination over a sorted key list
// ---------------------------------------------------------------------------

/**
 * One page of an already-sorted key list: the `limit` keys after `lastKey`
 * (the decoded cursor), or after where that key would sort when it was
 * deleted between pages, plus the cursor for the page that follows.
 */
export function paginateSortedKeys(
  sortedKeys: readonly string[],
  tenantId: string,
  lastKey: string | undefined,
  limit: number,
): { keys: string[]; nextCursor: string | undefined } {
  let startIndex = 0;
  if (lastKey !== undefined) {
    const cursorIndex = sortedKeys.indexOf(lastKey);
    if (cursorIndex !== -1) {
      startIndex = cursorIndex + 1;
    } else {
      const insertionPoint = sortedKeys.findIndex((k) => k > lastKey);
      startIndex = insertionPoint === -1 ? sortedKeys.length : insertionPoint;
    }
  }
  const keys = sortedKeys.slice(startIndex, startIndex + limit);
  const last = keys.at(-1);
  const nextCursor =
    startIndex + limit < sortedKeys.length && last !== undefined
      ? encodeCursor(last, tenantId)
      : undefined;
  return { keys, nextCursor };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Escapes SQL `LIKE` wildcard characters (`%`, `_`, and the escape itself) in a prefix. */
export function escapeLikePattern(prefix: string): string {
  return prefix.replace(/[%_\\]/g, '\\$&');
}
