/**
 * @fileoverview Defines the core interface for a generic storage provider.
 * This contract ensures that any storage implementation (e.g., in-memory, filesystem, database)
 * can be used interchangeably throughout the application.
 * @module src/storage/core/IStorageProvider
 */
import type { RequestContext } from '@/utils/internal/requestContext.js';

/**
 * Options for storage operations.
 *
 * @property ttl - Time-to-live for the stored item, in seconds. If not provided, the item is stored indefinitely.
 *   Provider-specific behaviors:
 *   - `in-memory`: TTL enforced by timers and lazy filtering on get/list.
 *   - `filesystem`: TTL stored in a metadata envelope; expired items are filtered on `get()` and `list()`.
 *   - `supabase`: TTL managed via an `expires_at` column; expired rows are filtered in list queries and lazily removed on reads.
 *   - `cloudflare-d1`: TTL managed via an `expires_at` column; expired rows are filtered in list queries and lazily removed on reads.
 *   - `cloudflare-kv`: TTL is a native feature of the KV store. KV propagation is eventually consistent.
 *   - `cloudflare-r2`: TTL stored in a metadata envelope; expired items are filtered on `get()`. `list()` does not filter expired items due to performance cost.
 */
export interface StorageOptions {
  /**
   * Time-to-live for the stored item, in seconds.
   * If not provided, the item will be stored indefinitely.
   */
  ttl?: number;
}

/**
 * Options for list operations with pagination support.
 *
 * @property limit - Maximum number of keys to return per page. If not provided, returns all keys.
 * @property cursor - Opaque cursor for pagination. Provider-specific format.
 */
export interface ListOptions {
  /**
   * Pagination cursor from a previous list operation.
   * Format is provider-specific (opaque string).
   */
  cursor?: string;
  /**
   * Maximum number of keys to return. Defaults to provider-specific limit.
   */
  limit?: number;
}

/**
 * Result of a list operation with pagination support.
 *
 * @property keys - Array of matching keys.
 * @property nextCursor - Cursor for the next page, or undefined if no more results.
 */
export interface ListResult {
  /**
   * Array of keys matching the prefix.
   */
  keys: string[];
  /**
   * Cursor for fetching the next page of results.
   * Undefined if there are no more results.
   */
  nextCursor?: string | undefined;
  /**
   * Optional pre-fetched values keyed by key name. When present, callers
   * can use these directly instead of issuing a separate getMany() call.
   * Providers that already read file/record contents during list (e.g. for
   * TTL validation) should populate this to avoid redundant I/O.
   */
  values?: Map<string, unknown>;
}

/**
 * Defines the contract for a generic storage provider.
 * All methods must be asynchronous and accept a RequestContext for tracing and logging.
 *
 * Current provider-status notes:
 * - `in-memory`, `filesystem`, `supabase`, and `cloudflare-d1` report precise delete/deleteMany counts.
 * - `cloudflare-kv` and `cloudflare-r2` expose idempotent deletes only; delete() returns true after a successful backend call even when the key may not have existed, and deleteMany() counts attempted successful deletes.
 * - List TTL filtering is exact for `in-memory`, `filesystem`, `supabase`, and `cloudflare-d1`; native/eventual for `cloudflare-kv`; and not applied for `cloudflare-r2` because listing every object body would be too expensive.
 * - `values` on ListResult is opportunistic. Consumers must treat it as a cache hint and call getMany() when absent.
 */
export interface IStorageProvider {
  /**
   * Clears all keys for a given tenant.
   * WARNING: This is a destructive operation that cannot be undone.
   * Useful for testing or tenant cleanup operations.
   * @param tenantId The unique identifier for the tenant.
   * @param context The request context for logging and tracing.
   * @returns A promise that resolves to the number of keys deleted.
   */
  clear(tenantId: string, context: RequestContext): Promise<number>;

  /**
   * Deletes a value from the storage.
   * @param key The unique key for the item to delete.
   * @param context The request context for logging and tracing.
   * @returns A promise that resolves to true if the item was deleted, false if not found.
   */
  delete(tenantId: string, key: string, context: RequestContext): Promise<boolean>;

  /**
   * Deletes multiple keys in a single operation.
   * More efficient than multiple individual delete() calls.
   *
   * Performance characteristics by provider:
   * - Cloudflare KV/R2: Parallel deletes (fast)
   * - Supabase: Single SQL DELETE with IN clause (fast, database-optimized)
   * - In-Memory: Parallel Map deletes (fastest, no I/O)
   * - FileSystem: Parallel file deletes (I/O bound, benefits from concurrency)
   *
   * @param tenantId The unique identifier for the tenant.
   * @param keys Array of keys to delete. Empty array returns 0.
   * @param context The request context for logging and tracing.
   * @returns A promise that resolves to the number of keys successfully deleted.
   */
  deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number>;
  /**
   * Retrieves a value from the storage.
   * @param tenantId The unique identifier for the tenant.
   * @param key The unique key for the item.
   * @param context The request context for logging and tracing.
   * @returns A promise that resolves to the stored value, or null if not found.
   */
  get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null>;

  /**
   * Retrieves multiple values from storage in a single operation.
   * More efficient than multiple individual get() calls.
   *
   * Performance characteristics by provider:
   * - Cloudflare KV/R2: Parallel fetches (fast for large batches)
   * - Supabase: Single SQL query with IN clause (fast, database-optimized)
   * - In-Memory: Parallel Map lookups (fastest, no I/O)
   * - FileSystem: Parallel file reads (I/O bound, benefits from concurrency)
   *
   * @param tenantId The unique identifier for the tenant.
   * @param keys Array of keys to retrieve. Empty array returns empty Map.
   * @param context The request context for logging and tracing.
   * @returns A promise that resolves to a Map of key-value pairs. Missing keys are not included.
   */
  getMany<T>(tenantId: string, keys: string[], context: RequestContext): Promise<Map<string, T>>;

  /**
   * Lists all keys that match a given prefix.
   * Note: This may be an expensive operation on some backends.
   * TTL Behavior: This operation may or may not filter expired keys depending on the provider's capabilities.
   * Refer to `StorageOptions` for provider-specific TTL documentation.
   * @param prefix The prefix to match keys against.
   * @param context The request context for logging and tracing.
   * @param options Optional pagination settings.
   * @returns A promise that resolves to a ListResult with keys and optional pagination cursor.
   */
  list(
    tenantId: string,
    prefix: string,
    context: RequestContext,
    options?: ListOptions,
  ): Promise<ListResult>;

  /**
   * Stores a value in the storage.
   * @param key The unique key for the item.
   * @param value The value to store. Can be any serializable object.
   * @param context The request context for logging and tracing.
   * @param options Optional settings like TTL.
   * @returns A promise that resolves when the operation is complete.
   */
  set(
    tenantId: string,
    key: string,
    value: unknown,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void>;

  /**
   * Stores multiple values in a single operation.
   * More efficient than multiple individual set() calls.
   *
   * Performance characteristics by provider:
   * - Cloudflare KV/R2: Parallel writes (fast, eventually consistent)
   * - Supabase: Single SQL batch upsert (fast, immediately consistent)
   * - In-Memory: Parallel Map inserts (fastest, no I/O)
   * - FileSystem: Parallel file writes (I/O bound, benefits from concurrency)
   *
   * @param tenantId The unique identifier for the tenant.
   * @param entries Map of key-value pairs to store. Empty map is a no-op.
   * @param context The request context for logging and tracing.
   * @param options Optional settings like TTL (applied to all entries).
   * @returns A promise that resolves when all operations are complete.
   */
  setMany(
    tenantId: string,
    entries: Map<string, unknown>,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void>;
}
