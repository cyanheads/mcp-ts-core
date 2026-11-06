/**
 * @fileoverview Implements the IStorageProvider interface for Cloudflare D1.
 * Provides SQL-based key-value storage with multi-tenancy, TTL support, and batch operations.
 * @module src/storage/providers/cloudflare/d1Provider
 */
import type { D1Database } from '@cloudflare/workers-types';

import type {
  IStorageProvider,
  ListOptions,
  ListResult,
  StorageOptions,
} from '@/storage/core/IStorageProvider.js';
import { serializeValue } from '@/storage/core/providerHelpers.js';
import { decodeCursor, encodeCursor } from '@/storage/core/storageValidation.js';
import {
  configurationError,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
} from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';

const DEFAULT_LIST_LIMIT = 1000;

/** D1's per-statement bound-parameter limit: https://developers.cloudflare.com/d1/platform/limits/ */
const D1_MAX_BOUND_PARAMETERS = 100;

/** Keys per `getMany` statement: the parameter limit less the statement's tenant and `now` binds. */
const GET_MANY_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 2;

/** The largest code point: nothing sorts between a string ending in it and that string's successor. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * The least string above every string that starts with `prefix`, in the order
 * D1 compares TEXT (bytewise UTF-8, which is code point order): the prefix with
 * its last code point incremented. A last code point of U+10FFFF has no
 * successor, so it is dropped and the one before it incremented; a prefix made
 * only of U+10FFFF has no upper bound and returns `undefined`.
 *
 * D1 stores a lone surrogate as its three-byte generalized-UTF-8 form, which
 * sorts by its value between U+D7FF and U+E000, so a lone surrogate increments
 * like any code point. The one exception: a low surrogate written after a lone
 * high surrogate would pair with it, so that successor skips to U+E000 — no
 * stored key holds a lone low surrogate there, for the same reason.
 */
function prefixUpperBound(prefix: string): string | undefined {
  // Code points, with a surrogate pair as one and a lone surrogate as itself.
  const codePoints = Array.from(prefix);
  while (codePoints.length > 0) {
    const last = (codePoints.pop() as string).codePointAt(0) as number;
    if (last === MAX_CODE_POINT) continue;
    const rest = codePoints.join('');
    const next = last + 1 === 0xdc00 && /[\uD800-\uDBFF]$/.test(rest) ? 0xe000 : last + 1;
    return rest + String.fromCodePoint(next);
  }
  return undefined;
}

/**
 * Cloudflare D1 storage provider implementation.
 *
 * Features:
 * - SQL-based key-value storage with multi-tenancy
 * - TTL support via expires_at column (Unix timestamp in milliseconds)
 * - Batch operations using D1's batch() API for transactional writes
 * - Cursor-based pagination with tenant-bound security
 * - Strong consistency (vs KV's eventual consistency)
 *
 * Schema Requirements (create the table before the first call; the primary key
 * is the index every lookup and `list` range uses):
 * ```sql
 * CREATE TABLE IF NOT EXISTS kv_store (
 *   tenant_id  TEXT NOT NULL,
 *   key        TEXT NOT NULL,
 *   value      TEXT NOT NULL,
 *   expires_at INTEGER,
 *   PRIMARY KEY (tenant_id, key)
 * );
 * ```
 *
 * Performance Characteristics:
 * - Reads: ~50-100ms (depends on query complexity)
 * - Writes: ~50-200ms (single), ~100-500ms (batch)
 * - List operations: Efficient with proper indexes
 * - Batch operations: 20-100x faster than individual calls
 */
export class D1Provider implements IStorageProvider {
  private readonly db: D1Database;
  private readonly tableName: string;

  /**
   * Creates a new D1Provider instance.
   *
   * @param db - The D1Database binding from Cloudflare Workers
   * @param tableName - The name of the kv_store table (default: 'kv_store')
   * @throws {McpError} If db is not provided or invalid
   */
  private static readonly SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

  constructor(db: D1Database, tableName = 'kv_store') {
    if (!db) {
      throw configurationError('D1Provider requires a valid D1Database instance.');
    }
    if (!D1Provider.SAFE_TABLE_NAME.test(tableName)) {
      throw configurationError(
        `D1Provider tableName must be a valid SQL identifier (letters, digits, underscores; start with letter or underscore; max 64 chars): ${tableName}`,
      );
    }
    this.db = db;
    this.tableName = tableName;
  }

  /**
   * Helper to get current timestamp in milliseconds.
   */
  private getNow(): number {
    return Date.now();
  }

  /**
   * Helper to check if a value has expired based on expires_at timestamp.
   */
  private isExpired(expiresAt: number | null): boolean {
    if (expiresAt === null) return false;
    return expiresAt <= this.getNow();
  }

  /**
   * Retrieves a value from the D1 database.
   * Returns null if the key doesn't exist or has expired.
   */
  async get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[D1Provider] Getting key: ${key}`, context);

        const stmt = this.db
          .prepare(
            `SELECT value, expires_at FROM ${this.tableName} WHERE tenant_id = ? AND key = ?`,
          )
          .bind(tenantId, key);

        const result = await stmt.first<{
          value: string;
          expires_at: number | null;
        }>();

        if (!result) {
          logger.debug(`[D1Provider] Key not found: ${key}`, context);
          return null;
        }

        // Check TTL expiration
        if (this.isExpired(result.expires_at)) {
          logger.debug(`[D1Provider] Key expired: ${key}`, context);
          // Optionally delete expired key (lazy cleanup)
          await this.delete(tenantId, key, context);
          return null;
        }

        try {
          return JSON.parse(result.value) as T;
        } catch (error: unknown) {
          throw new McpError(
            JsonRpcErrorCode.SerializationError,
            `[D1Provider] Failed to parse JSON for key: ${key}`,
            undefined,
            { cause: error },
          );
        }
      },
      {
        operation: 'D1Provider.get',
        context,
        input: { tenantId, key },
      },
    );
  }

  /**
   * Stores a value in the D1 database.
   * Uses UPSERT (INSERT OR REPLACE) to handle both new and existing keys.
   */
  async set(
    tenantId: string,
    key: string,
    value: unknown,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[D1Provider] Setting key: ${key}`, withExtra(context, { options }));

        const serializedValue = serializeValue(key, value);
        let expiresAt: number | null = null;

        // Handle TTL (including ttl=0 for immediate expiration)
        if (options?.ttl !== undefined) {
          expiresAt = this.getNow() + options.ttl * 1000;
        }

        const stmt = this.db
          .prepare(
            `INSERT OR REPLACE INTO ${this.tableName} (tenant_id, key, value, expires_at) VALUES (?, ?, ?, ?)`,
          )
          .bind(tenantId, key, serializedValue, expiresAt);

        await stmt.run();
        logger.debug(`[D1Provider] Successfully set key: ${key}`, context);
      },
      {
        operation: 'D1Provider.set',
        context,
        input: { tenantId, key },
      },
    );
  }

  /**
   * Deletes a key from the D1 database.
   * Returns true if the key existed, false otherwise.
   */
  async delete(tenantId: string, key: string, context: RequestContext): Promise<boolean> {
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(`[D1Provider] Deleting key: ${key}`, context);

        const stmt = this.db
          .prepare(`DELETE FROM ${this.tableName} WHERE tenant_id = ? AND key = ?`)
          .bind(tenantId, key);

        const result = await stmt.run();

        // D1's meta.changes indicates number of rows affected
        const deleted = (result.meta?.changes ?? 0) > 0;

        if (deleted) {
          logger.debug(`[D1Provider] Successfully deleted key: ${key}`, context);
        } else {
          logger.debug(`[D1Provider] Key to delete not found: ${key}`, context);
        }

        return deleted;
      },
      {
        operation: 'D1Provider.delete',
        context,
        input: { tenantId, key },
      },
    );
  }

  /**
   * Lists keys matching a prefix with pagination support.
   * Filters out expired keys based on TTL.
   */
  async list(
    tenantId: string,
    prefix: string,
    context: RequestContext,
    options?: ListOptions,
  ): Promise<ListResult> {
    return await ErrorHandler.tryCatch(
      async () => {
        logger.debug(
          `[D1Provider] Listing keys with prefix: ${prefix}`,
          withExtra(context, { options }),
        );

        const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
        let lastKey: string | undefined;

        // Decode cursor if provided
        if (options?.cursor) {
          try {
            lastKey = decodeCursor(options.cursor, tenantId, context);
          } catch (error: unknown) {
            throw invalidParams('Invalid cursor format or tenant mismatch', undefined, {
              cause: error,
            });
          }
        }

        /**
         * The prefix is a key range, not a `LIKE`: D1 caps a `LIKE`/`GLOB`
         * pattern at 50 bytes, and `LIKE` ignores ASCII case. The bounds, the
         * cursor, and `ORDER BY key` all compare under the same BINARY
         * collation, and the `(tenant_id, key)` primary key serves the range.
         */
        const conditions = ['tenant_id = ?'];
        const params: unknown[] = [tenantId];
        if (prefix !== '') {
          conditions.push('key >= ?');
          params.push(prefix);
          const upperBound = prefixUpperBound(prefix);
          if (upperBound !== undefined) {
            conditions.push('key < ?');
            params.push(upperBound);
          }
        }
        if (lastKey) {
          conditions.push('key > ?');
          params.push(lastKey);
        }
        conditions.push('(expires_at IS NULL OR expires_at > ?)');
        params.push(this.getNow(), limit + 1);

        const result = await this.db
          .prepare(
            `SELECT key FROM ${this.tableName}
             WHERE ${conditions.join(' AND ')}
             ORDER BY key
             LIMIT ?`,
          )
          .bind(...params)
          .all<{ key: string }>();
        const rows = result.results ?? [];

        // Check if there are more results (for pagination)
        const hasMore = rows.length > limit;
        const keys = hasMore ? rows.slice(0, limit) : rows;

        // Generate next cursor if more results exist
        let nextCursor: string | undefined;
        if (hasMore && keys.length > 0) {
          // Use the last key from the results as the cursor
          nextCursor = encodeCursor((keys[keys.length - 1] as { key: string }).key, tenantId);
        }

        logger.debug(`[D1Provider] Found ${keys.length} keys with prefix: ${prefix}`, context);

        return {
          keys: keys.map((row) => row.key),
          nextCursor,
        };
      },
      {
        operation: 'D1Provider.list',
        context,
        input: { tenantId, prefix, options },
      },
    );
  }

  /**
   * Retrieves multiple values in one round trip. D1 binds at most 100 parameters
   * per statement, so the distinct keys are split into chunks that leave room for
   * the tenant and `now` binds, and every chunk runs in a single `db.batch()`:
   * one query against the per-invocation limit, one transaction snapshot, and
   * expiry judged against one instant.
   */
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

        logger.debug(`[D1Provider] Getting ${keys.length} keys in batch`, context);

        const uniqueKeys = [...new Set(keys)];
        const now = this.getNow();
        const chunks = Array.from(
          { length: Math.ceil(uniqueKeys.length / GET_MANY_CHUNK_SIZE) },
          (_, index) =>
            uniqueKeys.slice(index * GET_MANY_CHUNK_SIZE, (index + 1) * GET_MANY_CHUNK_SIZE),
        );
        const statements = chunks.map((chunk) =>
          this.db
            .prepare(
              `SELECT key, value, expires_at FROM ${this.tableName}
               WHERE tenant_id = ?
                 AND key IN (${chunk.map(() => '?').join(',')})
                 AND (expires_at IS NULL OR expires_at > ?)`,
            )
            .bind(tenantId, ...chunk, now),
        );

        const chunkResults = await this.db.batch<{
          key: string;
          value: string;
          expires_at: number | null;
        }>(statements);

        const results = new Map<string, T>();
        const rows = chunkResults.flatMap((result) => result.results ?? []);

        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.value) as T;
            results.set(row.key, parsed);
          } catch (error: unknown) {
            throw new McpError(
              JsonRpcErrorCode.SerializationError,
              `[D1Provider] Failed to parse JSON for key: ${row.key}`,
              undefined,
              { cause: error },
            );
          }
        }

        return results;
      },
      {
        operation: 'D1Provider.getMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  /**
   * Stores multiple key-value pairs in a single transaction.
   * Uses D1's batch() API for atomic, transactional writes.
   * Significantly faster than individual set() calls (20-100x).
   */
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

        logger.debug(
          `[D1Provider] Setting ${entries.size} keys in batch`,
          withExtra(context, { options }),
        );

        let expiresAt: number | null = null;
        if (options?.ttl !== undefined) {
          expiresAt = this.getNow() + options.ttl * 1000;
        }

        // Prepare batch statements; every value is encoded before the batch runs
        const statements = Array.from(entries.entries()).map(([key, value]) => {
          const serializedValue = serializeValue(key, value);
          return this.db
            .prepare(
              `INSERT OR REPLACE INTO ${this.tableName} (tenant_id, key, value, expires_at) VALUES (?, ?, ?, ?)`,
            )
            .bind(tenantId, key, serializedValue, expiresAt);
        });

        // Execute as a single transaction
        await this.db.batch(statements);

        logger.debug(`[D1Provider] Successfully set ${entries.size} keys in batch`, context);
      },
      {
        operation: 'D1Provider.setMany',
        context,
        input: { tenantId, entryCount: entries.size },
      },
    );
  }

  /**
   * Deletes multiple keys in a single transaction.
   * Uses D1's batch() API for atomic deletion.
   * Returns the count of successfully deleted keys.
   */
  async deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        if (keys.length === 0) {
          return 0;
        }

        logger.debug(`[D1Provider] Deleting ${keys.length} keys in batch`, context);

        // Prepare batch delete statements
        const statements = keys.map((key) =>
          this.db
            .prepare(`DELETE FROM ${this.tableName} WHERE tenant_id = ? AND key = ?`)
            .bind(tenantId, key),
        );

        // Execute as a single transaction
        const results = await this.db.batch(statements);

        // Count how many rows were actually deleted
        const deletedCount = results.reduce(
          (count, result) => count + (result.meta?.changes ?? 0),
          0,
        );

        logger.debug(`[D1Provider] Deleted ${deletedCount} of ${keys.length} keys`, context);

        return deletedCount;
      },
      {
        operation: 'D1Provider.deleteMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  /**
   * Clears all keys for a given tenant.
   * WARNING: This is a destructive operation that cannot be undone.
   * Useful for testing or tenant cleanup operations.
   */
  async clear(tenantId: string, context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        logger.warning(`[D1Provider] Clearing all keys for tenant: ${tenantId}`, context);

        const stmt = this.db
          .prepare(`DELETE FROM ${this.tableName} WHERE tenant_id = ?`)
          .bind(tenantId);

        const result = await stmt.run();
        const deletedCount = result.meta?.changes ?? 0;

        logger.info(`[D1Provider] Cleared ${deletedCount} keys for tenant: ${tenantId}`, context);

        return deletedCount;
      },
      {
        operation: 'D1Provider.clear',
        context,
        input: { tenantId },
      },
    );
  }
}
