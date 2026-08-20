/**
 * @fileoverview Provides a singleton service for interacting with the application's storage layer.
 * This service acts as a proxy to the configured storage provider, ensuring a consistent
 * interface for all storage operations throughout the application. It receives its concrete
 * provider via dependency injection.
 * @module src/storage/core/StorageService
 */

import type {
  IStorageProvider,
  ListOptions,
  ListResult,
  StorageOptions,
} from '@/storage/core/IStorageProvider.js';
import {
  validateBatchEntries,
  validateBatchKeys,
  validateKey,
  validateListOptions,
  validatePrefix,
  validateStorageOptions,
  validateTenantId,
} from '@/storage/core/storageValidation.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { nowMs } from '@/utils/internal/performance.js';
import { type RequestContext, withExtra } from '@/utils/internal/requestContext.js';
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_CODE_NAMESPACE,
  ATTR_MCP_STORAGE_DURATION_MS,
  ATTR_MCP_STORAGE_KEY_COUNT,
  ATTR_MCP_STORAGE_OPERATION,
  ATTR_MCP_STORAGE_SUCCESS,
} from '@/utils/telemetry/attributes.js';
import { createCounter, createHistogram } from '@/utils/telemetry/metrics.js';
import { withSpan } from '@/utils/telemetry/trace.js';

/**
 * Validates and returns the tenant ID from the request context.
 *
 * This helper ensures the tenant ID is present in the context and passes
 * validation rules defined in {@link validateTenantId}. All StorageService
 * operations require a valid tenant ID for multi-tenancy isolation.
 *
 * @param context - The request context containing the tenant ID
 * @returns The validated tenant ID (trimmed of whitespace)
 * @throws {McpError} JsonRpcErrorCode.InternalError - If tenant ID is missing (undefined or null)
 * @throws {McpError} JsonRpcErrorCode.InvalidParams - If tenant ID fails validation (from validateTenantId)
 * @internal
 */
function requireTenantId(context: RequestContext): string {
  const tenantId = context.tenantId;

  // Check if tenant ID is missing (undefined or null)
  if (tenantId === undefined || tenantId === null) {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      'Tenant ID is required for storage operations but was not found in the request context.',
      {
        operation: context.operation || 'StorageService.requireTenantId',
        requestId: context.requestId,
        // Include call stack hint for debugging
        calledFrom: 'StorageService',
      },
    );
  }

  // Delegate validation to shared utility
  validateTenantId(tenantId, context);

  return tenantId.trim();
}

let storageOpCounter: ReturnType<typeof createCounter> | undefined;
let storageOpDuration: ReturnType<typeof createHistogram> | undefined;
let storageOpErrors: ReturnType<typeof createCounter> | undefined;

function getStorageMetrics() {
  storageOpCounter ??= createCounter('mcp.storage.operations', 'Total storage operations', '{ops}');
  storageOpDuration ??= createHistogram('mcp.storage.duration', 'Storage operation duration', 'ms');
  storageOpErrors ??= createCounter(
    'mcp.storage.errors',
    'Total storage operation errors',
    '{errors}',
  );
  return { storageOpCounter, storageOpDuration, storageOpErrors };
}

export class StorageService {
  constructor(private provider: IStorageProvider) {
    // Note: Cannot use structured logging in constructor as we don't have RequestContext yet
    // This is logged when the service is first instantiated by the DI container
  }

  /**
   * Wraps a provider call with an OTel span and standard storage metrics.
   * Accepts optional extra span attributes (e.g. key count for batch ops).
   */
  private async withStorageOp<T>(
    operation: string,
    fn: () => Promise<T>,
    extraAttrs?: Record<string, string | number | boolean>,
  ): Promise<T> {
    return await withSpan(
      `storage:${operation}`,
      async (span) => {
        const t0 = nowMs();
        let ok = false;
        try {
          const result = await fn();
          ok = true;
          return result;
        } finally {
          const durationMs = Math.round((nowMs() - t0) * 100) / 100;
          span.setAttribute(ATTR_MCP_STORAGE_DURATION_MS, durationMs);
          span.setAttribute(ATTR_MCP_STORAGE_SUCCESS, ok);
          if (extraAttrs) span.setAttributes(extraAttrs);
          const m = getStorageMetrics();
          const attrs = { [ATTR_MCP_STORAGE_OPERATION]: operation, [ATTR_MCP_STORAGE_SUCCESS]: ok };
          m.storageOpCounter.add(1, attrs);
          m.storageOpDuration.record(durationMs, attrs);
          if (!ok) m.storageOpErrors.add(1, { [ATTR_MCP_STORAGE_OPERATION]: operation });
        }
      },
      {
        [ATTR_CODE_FUNCTION_NAME]: operation,
        [ATTR_CODE_NAMESPACE]: 'StorageService',
        [ATTR_MCP_STORAGE_OPERATION]: operation,
        ...extraAttrs,
      },
    );
  }

  async get<T>(key: string, context: RequestContext): Promise<T | null> {
    const tenantId = requireTenantId(context);
    validateKey(key, context);

    logger.debug('[StorageService] get operation', {
      ...withExtra(context, { key }),
      operation: 'StorageService.get',
      tenantId,
    });

    return await this.withStorageOp('get', () => this.provider.get<T>(tenantId, key, context));
  }

  async set(
    key: string,
    value: unknown,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    const tenantId = requireTenantId(context);
    validateKey(key, context);
    validateStorageOptions(options, context);

    logger.debug('[StorageService] set operation', {
      ...withExtra(context, { key, hasTTL: options?.ttl !== undefined, ttl: options?.ttl }),
      operation: 'StorageService.set',
      tenantId,
    });

    return await this.withStorageOp('set', () =>
      this.provider.set(tenantId, key, value, context, options),
    );
  }

  async delete(key: string, context: RequestContext): Promise<boolean> {
    const tenantId = requireTenantId(context);
    validateKey(key, context);

    logger.debug('[StorageService] delete operation', {
      ...withExtra(context, { key }),
      operation: 'StorageService.delete',
      tenantId,
    });

    return await this.withStorageOp('delete', () => this.provider.delete(tenantId, key, context));
  }

  async list(prefix: string, context: RequestContext, options?: ListOptions): Promise<ListResult> {
    const tenantId = requireTenantId(context);
    validatePrefix(prefix, context);
    validateListOptions(options, context);

    logger.debug('[StorageService] list operation', {
      ...withExtra(context, { prefix, limit: options?.limit, hasCursor: !!options?.cursor }),
      operation: 'StorageService.list',
      tenantId,
    });

    return await this.withStorageOp('list', () =>
      this.provider.list(tenantId, prefix, context, options),
    );
  }

  async getMany<T>(keys: string[], context: RequestContext): Promise<Map<string, T>> {
    const tenantId = requireTenantId(context);
    validateBatchKeys(keys, 'getMany', context);
    for (const key of keys) {
      validateKey(key, context);
    }

    logger.debug('[StorageService] getMany operation', {
      ...withExtra(context, { keyCount: keys.length }),
      operation: 'StorageService.getMany',
      tenantId,
    });

    return await this.withStorageOp(
      'getMany',
      () => this.provider.getMany<T>(tenantId, keys, context),
      { [ATTR_MCP_STORAGE_KEY_COUNT]: keys.length },
    );
  }

  async setMany(
    entries: Map<string, unknown>,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    const tenantId = requireTenantId(context);
    validateBatchEntries(entries, context);
    validateStorageOptions(options, context);
    for (const key of entries.keys()) {
      validateKey(key, context);
    }

    logger.debug('[StorageService] setMany operation', {
      ...withExtra(context, {
        entryCount: entries.size,
        hasTTL: options?.ttl !== undefined,
        ttl: options?.ttl,
      }),
      operation: 'StorageService.setMany',
      tenantId,
    });

    return await this.withStorageOp(
      'setMany',
      async () => {
        await this.provider.setMany(tenantId, entries, context, options);
      },
      { [ATTR_MCP_STORAGE_KEY_COUNT]: entries.size },
    );
  }

  async deleteMany(keys: string[], context: RequestContext): Promise<number> {
    const tenantId = requireTenantId(context);
    validateBatchKeys(keys, 'deleteMany', context);
    for (const key of keys) {
      validateKey(key, context);
    }

    logger.debug('[StorageService] deleteMany operation', {
      ...withExtra(context, { keyCount: keys.length }),
      operation: 'StorageService.deleteMany',
      tenantId,
    });

    return await this.withStorageOp(
      'deleteMany',
      () => this.provider.deleteMany(tenantId, keys, context),
      { [ATTR_MCP_STORAGE_KEY_COUNT]: keys.length },
    );
  }

  async clear(context: RequestContext): Promise<number> {
    const tenantId = requireTenantId(context);

    logger.info('[StorageService] clear operation', {
      ...context,
      operation: 'StorageService.clear',
      tenantId,
    });

    return await this.withStorageOp('clear', () => this.provider.clear(tenantId, context));
  }
}
