/**
 * @fileoverview Factory function for creating a storage provider based on application configuration.
 * This module decouples the application from concrete storage implementations, allowing the
 * storage backend to be selected via environment variables. In a serverless environment,
 * it throws a configuration error for unsupported providers.
 * @module src/storage/core/storageFactory
 */
import type { D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '@/config/index.js';
import type { IStorageProvider } from '@/storage/core/IStorageProvider.js';
import { D1Provider } from '@/storage/providers/cloudflare/d1Provider.js';
import { KvProvider } from '@/storage/providers/cloudflare/kvProvider.js';
import { R2Provider } from '@/storage/providers/cloudflare/r2Provider.js';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import type { Database } from '@/storage/providers/supabase/supabase.types.js';
import { SupabaseProvider } from '@/storage/providers/supabase/supabaseProvider.js';
import { configurationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';

/** Evaluated at call time (not module load) so worker.ts can set IS_SERVERLESS before first use. */
function isServerless(): boolean {
  return typeof process === 'undefined' || process.env.IS_SERVERLESS === 'true';
}

/**
 * Optional dependencies for storage provider creation.
 * Allows pre-resolved dependencies to be passed in, useful for testing
 * and Worker environments where DI container may not be available.
 */
export interface StorageFactoryDeps {
  /** Cloudflare D1 database binding */
  readonly d1Database?: D1Database;
  /** Cloudflare KV namespace binding */
  readonly kvNamespace?: KVNamespace;
  /** Cloudflare R2 bucket binding */
  readonly r2Bucket?: R2Bucket;
  /** Pre-configured Supabase client */
  readonly supabaseClient?: SupabaseClient<Database>;
}

/**
 * Retrieves a Cloudflare binding from globalThis by key.
 * Throws a ConfigurationError if the binding is not present.
 */
function getGlobalBinding<T>(key: string, context: RequestContext): T {
  const g = globalThis as Record<string, unknown>;
  if (!(key in g) || g[key] == null) {
    throw configurationError(
      `${key} binding not available in globalThis. Ensure wrangler.toml is configured correctly.`,
      context,
    );
  }
  return g[key] as T;
}

/**
 * Creates and returns a storage provider instance based on the provided configuration.
 *
 * This factory decouples the application from concrete storage implementations,
 * allowing the backend to be selected via environment configuration. In serverless
 * environments, automatically falls back to in-memory storage for non-compatible providers.
 *
 * Provider Selection Logic:
 * - Serverless environment: Only `in-memory`, `cloudflare-r2`, `cloudflare-kv` allowed
 * - Node environment: All providers available
 * - Missing config: Throws ConfigurationError
 *
 * @param config - The application configuration object, typically resolved from DI container.
 * @param deps - Optional pre-resolved dependencies for providers (useful for testing/Workers).
 * @returns An instance of a class that implements the IStorageProvider interface.
 *
 * @throws {McpError} JsonRpcErrorCode.ConfigurationError - If:
 *   - filesystem provider selected but STORAGE_FILESYSTEM_PATH not set
 *   - supabase provider selected but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set
 *   - cloudflare-r2 provider selected in non-serverless environment
 *   - cloudflare-kv provider selected in non-serverless environment
 *   - unknown provider type specified
 *
 * @example
 * ```typescript
 * // Standard usage — DI container resolves clients and passes via deps
 * const provider = createStorageProvider(config, {
 *   supabaseClient: resolvedSupabaseClient,
 * });
 *
 * // Worker usage with Cloudflare bindings
 * const provider = createStorageProvider(config, {
 *   r2Bucket: env.R2_BUCKET,
 *   kvNamespace: env.KV_NAMESPACE,
 * });
 * ```
 */
export function createStorageProvider(
  config: AppConfig,
  deps: StorageFactoryDeps = {},
): IStorageProvider {
  const context = requestContextService.createRequestContext({
    operation: 'createStorageProvider',
  });

  const providerType = config.storage.providerType;

  if (
    isServerless() &&
    !['in-memory', 'cloudflare-r2', 'cloudflare-kv', 'cloudflare-d1'].includes(providerType)
  ) {
    throw configurationError(
      `Storage provider '${providerType}' is not supported in serverless environments. ` +
        `Use one of: 'in-memory', 'cloudflare-r2', 'cloudflare-kv', 'cloudflare-d1'.`,
    );
  }

  logger.info(`Creating storage provider of type: ${providerType}`, context);

  switch (providerType) {
    case 'in-memory':
      return new InMemoryProvider();
    case 'filesystem':
      if (!config.storage.filesystemPath) {
        throw configurationError(
          'STORAGE_FILESYSTEM_PATH must be set for the filesystem storage provider.',
          context,
        );
      }
      return new FileSystemProvider(config.storage.filesystemPath);
    case 'supabase':
      if (!config.supabase?.url || !config.supabase?.serviceRoleKey) {
        throw configurationError(
          'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the supabase storage provider.',
          context,
        );
      }
      if (!deps.supabaseClient) {
        throw configurationError(
          'Supabase client must be provided via deps for the supabase storage provider.',
          context,
        );
      }
      return new SupabaseProvider(deps.supabaseClient);
    case 'cloudflare-r2':
      if (isServerless()) {
        if (deps.r2Bucket) {
          return new R2Provider(deps.r2Bucket);
        }
        const r2Binding = getGlobalBinding<R2Bucket>('R2_BUCKET', context);
        return new R2Provider(r2Binding);
      }
      throw configurationError(
        'Cloudflare R2 storage is only available in a Cloudflare Worker environment.',
        context,
      );
    case 'cloudflare-kv':
      if (isServerless()) {
        if (deps.kvNamespace) {
          return new KvProvider(deps.kvNamespace);
        }
        const kvBinding = getGlobalBinding<KVNamespace>('KV_NAMESPACE', context);
        return new KvProvider(kvBinding);
      }
      throw configurationError(
        'Cloudflare KV storage is only available in a Cloudflare Worker environment.',
        context,
      );
    case 'cloudflare-d1':
      if (isServerless()) {
        if (deps.d1Database) {
          return new D1Provider(deps.d1Database);
        }
        const d1Binding = getGlobalBinding<D1Database>('DB', context);
        return new D1Provider(d1Binding);
      }
      throw configurationError(
        'Cloudflare D1 storage is only available in a Cloudflare Worker environment.',
        context,
      );
    default: {
      const exhaustiveCheck: never = providerType;
      throw configurationError(
        `Unhandled storage provider type: ${String(exhaustiveCheck)}`,
        context,
      );
    }
  }
}
