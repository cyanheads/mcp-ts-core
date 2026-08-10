/**
 * @fileoverview An in-memory storage provider implementation.
 * Ideal for development, testing, or scenarios where persistence is not required.
 * Supports TTL (Time-To-Live) for entries and a configurable maximum entry count
 * to prevent unbounded memory growth.
 * @module src/storage/providers/inMemory/inMemoryProvider
 */
import type {
  IStorageProvider,
  ListOptions,
  ListResult,
  StorageOptions,
} from '@/storage/core/IStorageProvider.js';
import { decodeCursor, encodeCursor } from '@/storage/core/storageValidation.js';
import { configurationError, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const DEFAULT_LIST_LIMIT = 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

/** Configuration options for the in-memory storage provider. */
export interface InMemoryProviderOptions {
  /**
   * Maximum number of entries across all tenants before the provider
   * rejects new writes. When capacity is reached, a TTL sweep runs first
   * to reclaim expired entries. If still at capacity after the sweep, `set()`
   * throws `McpError(InternalError)`.
   *
   * @default 10_000
   */
  maxEntries?: number;
}

interface InMemoryStoreEntry {
  expiresAt?: number;
  value: unknown;
}

export class InMemoryProvider implements IStorageProvider {
  private readonly store = new Map<string, Map<string, InMemoryStoreEntry>>();
  private readonly maxEntries: number;
  private entryCount = 0;

  constructor(options?: InMemoryProviderOptions) {
    const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw configurationError('InMemoryProvider maxEntries must be a non-negative safe integer.');
    }
    this.maxEntries = maxEntries;
  }

  /** Returns the total number of entries across all tenants. */
  get size(): number {
    return this.entryCount;
  }

  private getOrCreateTenantStore(tenantId: string): Map<string, InMemoryStoreEntry> {
    const existing = this.store.get(tenantId);
    if (existing) return existing;
    const created = new Map<string, InMemoryStoreEntry>();
    this.store.set(tenantId, created);
    return created;
  }

  /** Sweeps all tenant stores and removes expired entries, returning the count reclaimed. */
  private sweepExpired(): number {
    const now = Date.now();
    let reclaimed = 0;
    for (const [tenantId, tenantStore] of this.store) {
      for (const [key, entry] of tenantStore) {
        if (entry.expiresAt && now > entry.expiresAt) {
          tenantStore.delete(key);
          reclaimed++;
        }
      }
      if (tenantStore.size === 0) {
        this.store.delete(tenantId);
      }
    }
    this.entryCount -= reclaimed;
    return reclaimed;
  }

  /**
   * Ensures capacity for a new entry. If at limit, runs a TTL sweep first.
   * If still at capacity after sweep, throws.
   */
  private ensureCapacity(additionalEntries = 1): void {
    if (this.entryCount + additionalEntries <= this.maxEntries) return;

    const reclaimed = this.sweepExpired();
    if (reclaimed > 0) {
      logger.debug(`[InMemoryProvider] TTL sweep reclaimed ${reclaimed} expired entries`);
    }

    if (this.entryCount + additionalEntries > this.maxEntries) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `In-memory storage capacity exceeded (max: ${this.maxEntries}). ` +
          'Consider increasing maxEntries, adding TTLs to entries, or switching to a persistent provider.',
      );
    }
  }

  get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    logger.debug(`[InMemoryProvider] Getting key: ${key} for tenant: ${tenantId}`, context);
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) {
      return Promise.resolve(null);
    }
    const entry = tenantStore.get(key);

    if (!entry) {
      return Promise.resolve(null);
    }

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      tenantStore.delete(key);
      this.entryCount--;
      if (tenantStore.size === 0) this.store.delete(tenantId);
      logger.debug(
        `[InMemoryProvider] Key expired and removed: ${key} for tenant: ${tenantId}`,
        context,
      );
      return Promise.resolve(null);
    }

    return Promise.resolve(entry.value as T);
  }

  set(
    tenantId: string,
    key: string,
    value: unknown,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    logger.debug(`[InMemoryProvider] Setting key: ${key} for tenant: ${tenantId}`, context);
    let tenantStore = this.store.get(tenantId);
    const isNew = !tenantStore?.has(key);
    if (isNew) {
      this.ensureCapacity();
    }
    tenantStore ??= this.getOrCreateTenantStore(tenantId);
    // Fix: Check for undefined instead of truthy to handle ttl=0 correctly
    const expiresAt = options?.ttl !== undefined ? Date.now() + options.ttl * 1000 : undefined;
    tenantStore.set(key, {
      value,
      ...(expiresAt !== undefined && { expiresAt }),
    });
    if (isNew) {
      this.entryCount++;
    }
    return Promise.resolve();
  }

  delete(tenantId: string, key: string, context: RequestContext): Promise<boolean> {
    logger.debug(`[InMemoryProvider] Deleting key: ${key} for tenant: ${tenantId}`, context);
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return Promise.resolve(false);
    const deleted = tenantStore.delete(key);
    if (deleted) {
      this.entryCount--;
      if (tenantStore.size === 0) this.store.delete(tenantId);
    }
    return Promise.resolve(deleted);
  }

  list(
    tenantId: string,
    prefix: string,
    context: RequestContext,
    options?: ListOptions,
  ): Promise<ListResult> {
    logger.debug(`[InMemoryProvider] Listing keys with prefix: ${prefix} for tenant: ${tenantId}`, {
      ...context,
      options,
    });
    // Authenticate tenant-bound cursors before an empty-namespace fast path.
    // Otherwise a cursor issued to another tenant is silently accepted whenever
    // the requested tenant has no entries.
    const lastKey = options?.cursor ? decodeCursor(options.cursor, tenantId, context) : undefined;
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) {
      return Promise.resolve({ keys: [], nextCursor: undefined });
    }
    const now = Date.now();
    const allKeys: string[] = [];

    // Collect all matching non-expired keys
    for (const [key, entry] of tenantStore.entries()) {
      if (key.startsWith(prefix)) {
        if (entry.expiresAt && now > entry.expiresAt) {
          tenantStore.delete(key); // Lazy cleanup
          this.entryCount--;
        } else {
          allKeys.push(key);
        }
      }
    }
    if (tenantStore.size === 0) this.store.delete(tenantId);

    // Sort for consistent pagination
    allKeys.sort();

    // Apply pagination with opaque cursors
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
    let startIndex = 0;

    if (lastKey) {
      const cursorIndex = allKeys.indexOf(lastKey);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      } else {
        // Key was deleted between pages; resume from the next key after it
        const insertionPoint = allKeys.findIndex((k) => k > lastKey);
        startIndex = insertionPoint === -1 ? allKeys.length : insertionPoint;
      }
    }

    const paginatedKeys = allKeys.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < allKeys.length && paginatedKeys.length > 0
        ? encodeCursor(paginatedKeys[paginatedKeys.length - 1] as string, tenantId)
        : undefined;

    return Promise.resolve({
      keys: paginatedKeys,
      nextCursor,
    });
  }

  async getMany<T>(
    tenantId: string,
    keys: string[],
    context: RequestContext,
  ): Promise<Map<string, T>> {
    if (keys.length === 0) {
      return new Map<string, T>();
    }

    logger.debug(`[InMemoryProvider] Getting ${keys.length} keys for tenant: ${tenantId}`, context);

    // Parallel fetch for better performance
    const promises = keys.map((key) => this.get<T>(tenantId, key, context));
    const values = await Promise.all(promises);

    const results = new Map<string, T>();
    keys.forEach((key, i) => {
      const value = values[i];
      if (value !== null) {
        results.set(key, value as T);
      }
    });

    logger.debug(
      `[InMemoryProvider] Retrieved ${results.size}/${keys.length} keys for tenant: ${tenantId}`,
      context,
    );
    return results;
  }

  // biome-ignore lint/suspicious/useAwait: async is required by IStorageProvider; the in-memory batch write is synchronous.
  async setMany(
    tenantId: string,
    entries: Map<string, unknown>,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    if (entries.size === 0) {
      return;
    }

    logger.debug(
      `[InMemoryProvider] Setting ${entries.size} keys for tenant: ${tenantId}`,
      context,
    );

    // Expired entries must be removed before computing the batch delta. If an
    // expired key is present in this batch, counting it as an overwrite and
    // sweeping it later can undercount additions and exceed maxEntries.
    this.sweepExpired();
    let tenantStore = this.store.get(tenantId);
    let newEntryCount = 0;
    for (const key of entries.keys()) {
      if (!tenantStore?.has(key)) newEntryCount++;
    }
    // Preflight the complete batch so capacity failures cannot partially commit.
    this.ensureCapacity(newEntryCount);
    tenantStore ??= this.getOrCreateTenantStore(tenantId);

    const expiresAt = options?.ttl !== undefined ? Date.now() + options.ttl * 1000 : undefined;
    for (const [key, value] of entries) {
      tenantStore.set(key, {
        value,
        ...(expiresAt !== undefined && { expiresAt }),
      });
    }
    this.entryCount += newEntryCount;

    logger.debug(
      `[InMemoryProvider] Successfully set ${entries.size} keys for tenant: ${tenantId}`,
      context,
    );
  }

  async deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    logger.debug(
      `[InMemoryProvider] Deleting ${keys.length} keys for tenant: ${tenantId}`,
      context,
    );

    // Parallel delete for better performance
    const promises = keys.map((key) => this.delete(tenantId, key, context));
    const results = await Promise.all(promises);
    const deletedCount = results.filter((deleted) => deleted).length;

    logger.debug(
      `[InMemoryProvider] Deleted ${deletedCount}/${keys.length} keys for tenant: ${tenantId}`,
      context,
    );
    return deletedCount;
  }

  clear(tenantId: string, context: RequestContext): Promise<number> {
    logger.debug(`[InMemoryProvider] Clearing all keys for tenant: ${tenantId}`, context);
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return Promise.resolve(0);
    const count = tenantStore.size;
    this.store.delete(tenantId);
    this.entryCount -= count;
    logger.info(`[InMemoryProvider] Cleared ${count} keys for tenant: ${tenantId}`, context);
    return Promise.resolve(count);
  }
}
