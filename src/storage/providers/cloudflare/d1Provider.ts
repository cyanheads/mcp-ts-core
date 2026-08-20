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

/** Escapes SQL LIKE wildcard characters (`%` and `_`) in a prefix string. */
function escapeLikePattern(prefix: string): string {
  return prefix.replace(/[%_\\]/g, '\\$&');
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
 * Schema Requirements:
 * - Table: kv_store (tenant_id, key, value, expires_at)
 * - See docs/cloudflare-d1-schema.sql for setup
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
            { ...context, error },
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

        const serializedValue = JSON.stringify(value);
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
            throw invalidParams('Invalid cursor format or tenant mismatch', { ...context, error });
          }
        }

        // Query with prefix matching and TTL filtering
        const now = this.getNow();
        let stmt: ReturnType<D1Database['prepare']>;

        if (lastKey) {
          // Cursor-based pagination: fetch keys after lastKey
          stmt = this.db
            .prepare(
              `SELECT key FROM ${this.tableName}
               WHERE tenant_id = ?
                 AND key LIKE ? ESCAPE '\\'
                 AND key > ?
                 AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY key
               LIMIT ?`,
            )
            .bind(tenantId, `${escapeLikePattern(prefix)}%`, lastKey, now, limit + 1);
        } else {
          // Initial page: no cursor
          stmt = this.db
            .prepare(
              `SELECT key FROM ${this.tableName}
               WHERE tenant_id = ?
                 AND key LIKE ? ESCAPE '\\'
                 AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY key
               LIMIT ?`,
            )
            .bind(tenantId, `${escapeLikePattern(prefix)}%`, now, limit + 1);
        }

        const result = await stmt.all<{ key: string }>();
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
   * Retrieves multiple values in a single operation.
   * More efficient than multiple individual get() calls.
   * Uses SQL IN clause for batch fetching.
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

        // Build SQL IN clause
        const placeholders = keys.map(() => '?').join(',');
        const now = this.getNow();

        const stmt = this.db
          .prepare(
            `SELECT key, value, expires_at FROM ${this.tableName}
             WHERE tenant_id = ?
               AND key IN (${placeholders})
               AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .bind(tenantId, ...keys, now);

        const result = await stmt.all<{
          key: string;
          value: string;
          expires_at: number | null;
        }>();

        const results = new Map<string, T>();
        const rows = result.results ?? [];

        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.value) as T;
            results.set(row.key, parsed);
          } catch (error: unknown) {
            throw new McpError(
              JsonRpcErrorCode.SerializationError,
              `[D1Provider] Failed to parse JSON for key: ${row.key}`,
              { ...context, error },
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

        // Prepare batch statements
        const statements = Array.from(entries.entries()).map(([key, value]) => {
          const serializedValue = JSON.stringify(value);
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
