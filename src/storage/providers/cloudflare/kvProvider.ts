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
import { decodeCursor, encodeCursor } from '@/storage/core/storageValidation.js';
import { configurationError, JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';

const DEFAULT_LIST_LIMIT = 1000;

export class KvProvider implements IStorageProvider {
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    if (!kv) {
      throw configurationError('KvProvider requires a valid KVNamespace instance.');
    }
    this.kv = kv;
  }

  private getKvKey(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  async get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    const kvKey = this.getKvKey(tenantId, key);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[KvProvider] Getting key: ${kvKey}`, context);
        try {
          const result = await this.kv.get<T>(kvKey, 'json');
          return result; // null indicates not found
        } catch (error: unknown) {
          throw new McpError(
            JsonRpcErrorCode.SerializationError,
            `[KvProvider] Failed to parse JSON for key: ${kvKey}`,
            { ...context, error },
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
    const kvKey = this.getKvKey(tenantId, key);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[KvProvider] Setting key: ${kvKey}`, withExtra(context, { options }));
        const valueToStore = JSON.stringify(value);

        const putOptions: import('@cloudflare/workers-types').KVNamespacePutOptions = {};
        if (options?.ttl !== undefined) {
          // Cloudflare KV requires expirationTtl >= 60 seconds
          putOptions.expirationTtl = Math.max(options.ttl, 60);
        }

        await this.kv.put(kvKey, valueToStore, putOptions);
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
    const kvKey = this.getKvKey(tenantId, key);
    return await ErrorHandler.tryCatch(
      async () => {
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
    const kvPrefix = this.getKvKey(tenantId, prefix);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(
          `[KvProvider] Listing keys with prefix: ${kvPrefix}`,
          withExtra(context, { options }),
        );

        const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
        const listOptions: import('@cloudflare/workers-types').KVNamespaceListOptions = {
          prefix: kvPrefix,
          limit,
        };
        if (options?.cursor) {
          // Decode tenant-bound cursor to get the native KV cursor
          listOptions.cursor = decodeCursor(options.cursor, tenantId, context);
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
      async () => {
        if (keys.length === 0) {
          return new Map<string, T>();
        }

        const entries = await Promise.all(
          keys.map(async (key) => {
            const value = await this.get<T>(tenantId, key, context);
            return [key, value] as const;
          }),
        );
        const results = new Map<string, T>();
        for (const [key, value] of entries) {
          if (value !== null) {
            results.set(key, value);
          }
        }
        return results;
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
      async () => {
        if (entries.size === 0) {
          return;
        }

        const promises = Array.from(entries.entries()).map(([key, value]) =>
          this.set(tenantId, key, value, context, options),
        );
        await Promise.all(promises);
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
      async () => {
        if (keys.length === 0) {
          return 0;
        }

        const promises = keys.map((key) => this.delete(tenantId, key, context));
        const results = await Promise.all(promises);
        return results.filter((deleted) => deleted).length;
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
            limit: 1000,
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
