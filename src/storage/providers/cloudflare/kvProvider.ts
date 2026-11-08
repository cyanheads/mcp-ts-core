/**
 * @fileoverview Implements the IStorageProvider interface for Cloudflare KV.
 * @module src/storage/providers/cloudflare/kvProvider
 */
import type { KVNamespace } from '@cloudflare/workers-types';

import type {
  IStorageProvider,
  ListOptions,
  ListResult,
  StorageOptions,
} from '@/storage/core/IStorageProvider.js';
import {
  deleteManyViaDelete,
  encodeEntries,
  getManyViaGet,
  type StoredNameLimit,
  serializeValue,
  setManyViaSet,
  storedName,
} from '@/storage/core/providerHelpers.js';
import { decodeCursor, encodeCursor } from '@/storage/core/storageValidation.js';
import { configurationError, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';
import { utf8ByteLength } from '@/utils/parsing/inputBudget.js';

const DEFAULT_LIST_LIMIT = 1000;
/** KV returns at most 1,000 keys per `list()` call and rejects a larger `limit`. */
const KV_MAX_LIST_LIMIT = 1000;
/** KV caps a key name at 512 bytes (https://developers.cloudflare.com/kv/platform/limits/). */
const KV_NAME_LIMIT: StoredNameLimit = { backend: 'Cloudflare KV', maxBytes: 512 };

export class KvProvider implements IStorageProvider {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    if (!kv) {
      throw configurationError('KvProvider requires a valid KVNamespace instance.');
    }
    this.kv = kv;
  }

  /** The KV name for `key`; throws `ValidationError` past KV's 512-byte name limit. */
  private getKvKey(tenantId: string, key: string): string {
    return storedName(tenantId, key, KV_NAME_LIMIT);
  }

  /** Writes an already-encoded value; Cloudflare KV requires `expirationTtl` >= 60 seconds. */
  private async put(kvKey: string, json: string, options?: StorageOptions): Promise<void> {
    const putOptions: import('@cloudflare/workers-types').KVNamespacePutOptions = {};
    if (options?.ttl !== undefined) {
      putOptions.expirationTtl = Math.max(options.ttl, 60);
    }
    await this.kv.put(kvKey, json, putOptions);
  }

  /**
   * Reads as text and parses here, so only a stored value that is not JSON
   * becomes `SerializationError`; a rejected read (an outage, a rate limit) is
   * classified as every other KV call's is.
   */
  async get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    return await ErrorHandler.tryCatch(
      async () => {
        const kvKey = this.getKvKey(tenantId, key);
        logger.debug(`[KvProvider] Getting key: ${kvKey}`, context);
        const text = await this.kv.get(kvKey, 'text');
        if (text === null) return null;
        try {
          return JSON.parse(text) as T;
        } catch (error: unknown) {
          throw new McpError(
            JsonRpcErrorCode.SerializationError,
            `[KvProvider] Failed to parse JSON for key: ${kvKey}`,
            undefined,
            { cause: error },
          );
        }
      },
      {
        operation: 'KvProvider.get',
        context,
        input: { tenantId, key },
      },
    );
  }

  async set(
    tenantId: string,
    key: string,
    value: unknown,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    return await ErrorHandler.tryCatch(
      async () => {
        const kvKey = this.getKvKey(tenantId, key);
        logger.debug(`[KvProvider] Setting key: ${kvKey}`, withExtra(context, { options }));
        await this.put(kvKey, serializeValue(key, value), options);
        logger.debug(`[KvProvider] Successfully set key: ${kvKey}`, context);
      },
      {
        operation: 'KvProvider.set',
        context,
        input: { tenantId, key },
      },
    );
  }

  /**
   * Deletes a key from the KV namespace.
   *
   * Note: Cloudflare KV `delete()` is idempotent and does not report whether
   * the key existed. This method always returns `true` on success, which is a
   * backend limitation — the KV API provides no existence check on delete.
   * A pre-delete `get()` would add latency and still be racy under eventual
   * consistency, so we accept the imprecise return value.
   */
  async delete(tenantId: string, key: string, context: RequestContext): Promise<boolean> {
    return await ErrorHandler.tryCatch(
      async () => {
        const kvKey = this.getKvKey(tenantId, key);
        logger.debug(`[KvProvider] Deleting key: ${kvKey}`, context);
        // KV delete is idempotent — always succeeds regardless of key existence
        await this.kv.delete(kvKey);
        logger.debug(`[KvProvider] Successfully deleted key: ${kvKey}`, context);
        return true;
      },
      {
        operation: 'KvProvider.delete',
        context,
        input: { tenantId, key },
      },
    );
  }

  async list(
    tenantId: string,
    prefix: string,
    context: RequestContext,
    options?: ListOptions,
  ): Promise<ListResult> {
    const kvPrefix = `${tenantId}:${prefix}`;
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(
          `[KvProvider] Listing keys with prefix: ${kvPrefix}`,
          withExtra(context, { options }),
        );

        // Decode tenant-bound cursor to get the native KV cursor
        const resumeFrom = options?.cursor
          ? decodeCursor(options.cursor, tenantId, context)
          : undefined;
        // No stored name is long enough to start with this prefix, and KV rejects it.
        if (utf8ByteLength(kvPrefix) > KV_NAME_LIMIT.maxBytes) return { keys: [] };

        const listOptions: import('@cloudflare/workers-types').KVNamespaceListOptions = {
          prefix: kvPrefix,
          // A page can hold fewer keys than asked for; the cursor below continues it.
          limit: Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, KV_MAX_LIST_LIMIT),
        };
        if (resumeFrom) {
          listOptions.cursor = resumeFrom;
        }
        const listed = await this.kv.list(listOptions);

        const tenantPrefix = `${tenantId}:`;
        const keys = listed.keys.map((keyInfo) =>
          keyInfo.name.startsWith(tenantPrefix)
            ? keyInfo.name.substring(tenantPrefix.length)
            : keyInfo.name,
        );

        // Wrap native KV cursor in tenant-bound envelope
        const nativeCursor =
          'cursor' in listed && !listed.list_complete ? listed.cursor : undefined;
        const nextCursor = nativeCursor ? encodeCursor(nativeCursor, tenantId) : undefined;

        logger.debug(`[KvProvider] Found ${keys.length} keys with prefix: ${kvPrefix}`, context);

        return {
          keys,
          nextCursor,
        };
      },
      {
        operation: 'KvProvider.list',
        context,
        input: { tenantId, prefix, options },
      },
    );
  }

  async getMany<T>(
    tenantId: string,
    keys: string[],
    context: RequestContext,
  ): Promise<Map<string, T>> {
    return await ErrorHandler.tryCatch(
      () => {
        // Every name is checked before the first read reaches KV.
        for (const key of keys) this.getKvKey(tenantId, key);
        return getManyViaGet(keys, (key) => this.get<T>(tenantId, key, context));
      },
      {
        operation: 'KvProvider.getMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  async setMany(
    tenantId: string,
    entries: Map<string, unknown>,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    return await ErrorHandler.tryCatch(
      () => {
        // Every value is encoded and every name checked before the first write.
        const named = new Map(
          Array.from(encodeEntries(entries), ([key, json]) => [this.getKvKey(tenantId, key), json]),
        );
        return setManyViaSet(named, (kvKey, json) => this.put(kvKey, json, options));
      },
      {
        operation: 'KvProvider.setMany',
        context,
        input: { tenantId, entryCount: entries.size },
      },
    );
  }

  async deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      () => {
        // Every name is checked before the first delete reaches KV.
        for (const key of keys) this.getKvKey(tenantId, key);
        return deleteManyViaDelete(keys, (key) => this.delete(tenantId, key, context));
      },
      {
        operation: 'KvProvider.deleteMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  async clear(tenantId: string, context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        const kvPrefix = `${tenantId}:`;
        let deletedCount = 0;
        let cursor: string | undefined;
        let listComplete = false;

        while (!listComplete) {
          const listOpts: import('@cloudflare/workers-types').KVNamespaceListOptions = {
            prefix: kvPrefix,
            limit: KV_MAX_LIST_LIMIT,
          };
          if (cursor) {
            listOpts.cursor = cursor;
          }
          const listed = await this.kv.list(listOpts);

          const deletePromises = listed.keys.map((keyInfo) => this.kv.delete(keyInfo.name));
          await Promise.all(deletePromises);
          deletedCount += listed.keys.length;

          listComplete = listed.list_complete;
          cursor = 'cursor' in listed ? listed.cursor : undefined;
        }

        logger.info(`[KvProvider] Cleared ${deletedCount} keys for tenant: ${tenantId}`, context);
        return deletedCount;
      },
      {
        operation: 'KvProvider.clear',
        context,
        input: { tenantId },
      },
    );
  }
}
