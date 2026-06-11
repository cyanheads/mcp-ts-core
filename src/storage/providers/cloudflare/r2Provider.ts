/**
 * @fileoverview Implements the IStorageProvider interface for Cloudflare R2.
 *
 * Performance note: TTL filtering in list operations is not applied at the R2 API level.
 * Expired entries are only removed on get operations. For large datasets, consider
 * implementing periodic cleanup jobs to remove expired entries.
 *
 * @module src/storage/providers/cloudflare/r2Provider
 */
import type { R2Bucket } from '@cloudflare/workers-types';

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
import type { RequestContext } from '@/utils/internal/requestContext.js';

type R2Envelope = {
  __mcp: { v: 1; expiresAt?: number };
  value: unknown;
};

const R2_ENVELOPE_VERSION = 1;
const DEFAULT_LIST_LIMIT = 1000;
/** R2 rejects `list()` limits above 1000, so the +1 page probe clamps here. */
const R2_MAX_LIST_LIMIT = 1000;

export class R2Provider implements IStorageProvider {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    if (!bucket) {
      throw configurationError('R2Provider requires a valid R2Bucket instance.');
    }
    this.bucket = bucket;
  }

  private getR2Key(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  private buildEnvelope(value: unknown, options?: StorageOptions): R2Envelope {
    // Fix: Check for undefined instead of truthy to handle ttl=0 correctly
    const expiresAt = options?.ttl !== undefined ? Date.now() + options.ttl * 1000 : undefined;
    return {
      __mcp: {
        v: R2_ENVELOPE_VERSION,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      },
      value,
    };
  }

  private parseAndValidate<T>(
    raw: string,
    tenantId: string,
    key: string,
    context: RequestContext,
  ): T | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && '__mcp' in parsed) {
        const env = parsed as R2Envelope;
        const expiresAt = env.__mcp?.expiresAt;
        if (expiresAt && Date.now() > expiresAt) {
          // expired
          return null;
        }
        return env.value as T;
      }
      // legacy: direct value
      return parsed as T;
    } catch (error: unknown) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        `[R2Provider] Failed to parse JSON for key: ${this.getR2Key(tenantId, key)}`,
        { ...context, error },
      );
    }
  }

  async get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    const r2Key = this.getR2Key(tenantId, key);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[R2Provider] Getting key: ${r2Key}`, context);
        const object = await this.bucket.get(r2Key);
        if (object === null) {
          return null;
        }
        const text = await object.text();
        const value = this.parseAndValidate<T>(text, tenantId, key, context);
        if (value === null) {
          // best-effort cleanup if expired
          await this.bucket.delete(r2Key).catch(() => {});
          logger.debug(`[R2Provider] Key expired and removed: ${r2Key}`, context);
        }
        return value;
      },
      {
        operation: 'R2Provider.get',
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
    const r2Key = this.getR2Key(tenantId, key);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[R2Provider] Setting key: ${r2Key}`, {
          ...context,
          options,
        });
        const envelope = this.buildEnvelope(value, options);
        const body = JSON.stringify(envelope);
        await this.bucket.put(r2Key, body);
        logger.debug(`[R2Provider] Successfully set key: ${r2Key}`, context);
      },
      {
        operation: 'R2Provider.set',
        context,
        input: { tenantId, key },
      },
    );
  }

  /**
   * Deletes a key from the R2 bucket.
   *
   * Note: R2 `delete()` is idempotent and does not report whether the key
   * existed. This method always returns `true` on success — a backend
   * limitation, not a bug. A pre-delete `head()` would add latency and
   * still be racy under eventual consistency.
   */
  async delete(tenantId: string, key: string, context: RequestContext): Promise<boolean> {
    const r2Key = this.getR2Key(tenantId, key);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[R2Provider] Deleting key: ${r2Key}`, context);
        await this.bucket.delete(r2Key);
        logger.debug(`[R2Provider] Successfully deleted key: ${r2Key}`, context);
        return true;
      },
      {
        operation: 'R2Provider.delete',
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
    const r2Prefix = this.getR2Key(tenantId, prefix);
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[R2Provider] Listing keys with prefix: ${r2Prefix}`, {
          ...context,
          options,
        });

        const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
        const listOptions: import('@cloudflare/workers-types').R2ListOptions = {
          prefix: r2Prefix,
          // Fetch one extra to detect more pages, clamped to R2's hard cap of
          // 1000 keys per list() call (1001 is rejected). At the cap, the
          // response's `truncated` flag covers has-more detection instead.
          limit: Math.min(limit + 1, R2_MAX_LIST_LIMIT),
        };
        if (options?.cursor) {
          // Decode tenant-bound cursor to resume after the last key
          const lastKey = decodeCursor(options.cursor, tenantId, context);
          listOptions.startAfter = `${tenantId}:${lastKey}`;
        }
        const listed = await this.bucket.list(listOptions);

        const tenantPrefix = `${tenantId}:`;
        const keys = listed.objects.map((obj) =>
          obj.key.startsWith(tenantPrefix) ? obj.key.substring(tenantPrefix.length) : obj.key,
        );

        /**
         * Pure limit+1 pagination (consistent with D1/Supabase providers):
         * - If we got limit+1 items, there are more pages — return only `limit` items
         * - If we got <= limit items, this is the last page — no cursor
         * - At the R2 cap (limit >= 1000) the +1 probe can't fit, so the
         *   response's `truncated` flag detects further pages instead
         */
        const hasMore = keys.length > limit || listed.truncated;
        const resultKeys = hasMore ? keys.slice(0, limit) : keys;
        const nextCursor =
          hasMore && resultKeys.length > 0
            ? encodeCursor(resultKeys[resultKeys.length - 1] as string, tenantId)
            : undefined;

        logger.debug(
          `[R2Provider] Found ${resultKeys.length} keys with prefix: ${r2Prefix}`,
          context,
        );

        return {
          keys: resultKeys,
          nextCursor,
        };
      },
      {
        operation: 'R2Provider.list',
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
        operation: 'R2Provider.getMany',
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
        operation: 'R2Provider.setMany',
        context,
        input: { tenantId, entryCount: entries.size },
      },
    );
  }

  /**
   * Deletes multiple keys in a single R2 batch operation.
   *
   * Note: R2 batch delete is idempotent — it does not report which keys actually
   * existed. The returned count reflects the number of keys requested for deletion,
   * not confirmed deletions. This is a backend limitation, not a bug.
   */
  async deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        if (keys.length === 0) {
          return 0;
        }

        logger.debug(`[R2Provider] Batch deleting ${keys.length} keys`, context);
        const r2Keys = keys.map((key) => this.getR2Key(tenantId, key));
        await this.bucket.delete(r2Keys);
        return keys.length;
      },
      {
        operation: 'R2Provider.deleteMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  async clear(tenantId: string, context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        const r2Prefix = `${tenantId}:`;
        let deletedCount = 0;
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const listOpts: import('@cloudflare/workers-types').R2ListOptions = {
            prefix: r2Prefix,
            limit: 1000,
          };
          if (cursor) {
            listOpts.cursor = cursor;
          }
          const listed = await this.bucket.list(listOpts);

          const objectKeys = listed.objects.map((obj) => obj.key);
          if (objectKeys.length > 0) {
            await this.bucket.delete(objectKeys);
          }
          deletedCount += listed.objects.length;

          hasMore = listed.truncated;
          cursor = 'cursor' in listed ? listed.cursor : undefined;
        }

        logger.info(`[R2Provider] Cleared ${deletedCount} keys for tenant: ${tenantId}`, context);
        return deletedCount;
      },
      {
        operation: 'R2Provider.clear',
        context,
        input: { tenantId },
      },
    );
  }
}
