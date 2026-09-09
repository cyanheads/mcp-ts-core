/**
 * @fileoverview A filesystem-based storage provider.
 * Persists data to the local filesystem in a specified directory.
 * Each key-value pair is stored as a separate JSON file.
 *
 * Performance note: List operations with TTL filtering can be slow on large datasets
 * as each file must be read and parsed to check expiration. Consider implementing
 * periodic cleanup jobs for production use with large key counts.
 *
 * @module src/storage/providers/fileSystem/fileSystemProvider
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  IStorageProvider,
  ListOptions,
  ListResult,
  StorageOptions,
} from '@/storage/core/IStorageProvider.js';
import {
  type DecodedEnvelope,
  decodeEnvelope,
  deleteManyViaDelete,
  encodeEnvelope,
  getManyViaGet,
  paginateSortedKeys,
  setManyViaSet,
} from '@/storage/core/providerHelpers.js';
import { decodeCursor, validateTenantId } from '@/storage/core/storageValidation.js';
import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  validationError,
} from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { sanitization } from '@/utils/security/sanitization.js';
import { isErrorWithCode } from '@/utils/types/guards.js';

const DEFAULT_LIST_LIMIT = 1000;

export class FileSystemProvider implements IStorageProvider {
  private readonly storagePath: string;

  constructor(storagePath: string) {
    if (!storagePath) {
      throw configurationError('FileSystemProvider requires a valid storagePath.');
    }
    this.storagePath = path.resolve(storagePath);
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private getTenantPath(tenantId: string, context: RequestContext): string {
    // Defense-in-depth: re-validate at the provider boundary. The upstream
    // StorageService gate also runs this check; mirroring it here protects
    // callers that construct the provider directly (custom providers,
    // tests, the add-provider skill's reference path).
    validateTenantId(tenantId, context);
    const sanitizedTenantId = sanitization.sanitizePath(tenantId, {
      toPosix: true,
    }).sanitizedPath;
    if (sanitizedTenantId.includes('/') || sanitizedTenantId.includes('..')) {
      throw validationError('Invalid tenantId contains path characters.');
    }
    const tenantPath = path.join(this.storagePath, sanitizedTenantId);
    if (!existsSync(tenantPath)) {
      mkdirSync(tenantPath, { recursive: true });
    }
    return tenantPath;
  }

  private getFilePath(tenantId: string, key: string, context: RequestContext): string {
    const tenantPath = this.getTenantPath(tenantId, context);
    const sanitizedKey = sanitization.sanitizePath(key, {
      rootDir: tenantPath,
      toPosix: true,
    }).sanitizedPath;
    const filePath = path.join(tenantPath, sanitizedKey);
    if (!path.resolve(filePath).startsWith(path.resolve(tenantPath))) {
      throw validationError('Invalid key results in path traversal attempt.');
    }
    return filePath;
  }

  /** Decodes a stored envelope; an expired file is removed best-effort and reads as `null`. */
  private async parseAndValidate<T>(
    raw: string,
    tenantId: string,
    key: string,
    filePath: string,
    context: RequestContext,
  ): Promise<T | null> {
    let decoded: DecodedEnvelope<T>;
    try {
      decoded = decodeEnvelope<T>(raw);
    } catch (error: unknown) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        `Failed to parse stored JSON for key "${key}" (tenant "${tenantId}").`,
        { ...context, error },
      );
    }
    if (decoded.kind === 'expired') {
      await rm(filePath, { force: true }).catch(() => undefined);
      return null;
    }
    return decoded.value;
  }

  async get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    const filePath = this.getFilePath(tenantId, key, context);
    return await ErrorHandler.tryCatch(
      async () => {
        try {
          const data = await readFile(filePath, 'utf-8');
          return this.parseAndValidate<T>(data, tenantId, key, filePath, context);
        } catch (error: unknown) {
          if (isErrorWithCode(error) && error.code === 'ENOENT') {
            return null; // File not found
          }
          throw error; // Re-throw other errors
        }
      },
      {
        operation: 'FileSystemProvider.get',
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
    const filePath = this.getFilePath(tenantId, key, context);
    return await ErrorHandler.tryCatch(
      async () => {
        const envelope = encodeEnvelope(value, options);
        const content = JSON.stringify(envelope, null, 2);
        mkdirSync(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content, 'utf-8');
      },
      {
        operation: 'FileSystemProvider.set',
        context,
        input: { tenantId, key },
      },
    );
  }

  async delete(tenantId: string, key: string, context: RequestContext): Promise<boolean> {
    const filePath = this.getFilePath(tenantId, key, context);
    return await ErrorHandler.tryCatch(
      async () => {
        try {
          await rm(filePath);
          return true;
        } catch (error: unknown) {
          if (isErrorWithCode(error) && error.code === 'ENOENT') {
            return false; // File didn't exist
          }
          throw error;
        }
      },
      {
        operation: 'FileSystemProvider.delete',
        context,
        input: { tenantId, key },
      },
    );
  }

  private async listFilesRecursively(dir: string, baseDir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.listFilesRecursively(fullPath, baseDir)));
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, fullPath);
        // Normalize to POSIX-style keys for consistency
        results.push(rel.split(path.sep).join('/'));
      }
    }
    return results;
  }

  async list(
    tenantId: string,
    prefix: string,
    context: RequestContext,
    options?: ListOptions,
  ): Promise<ListResult> {
    return await ErrorHandler.tryCatch(
      async () => {
        const tenantPath = this.getTenantPath(tenantId, context);
        const allKeys = await this.listFilesRecursively(tenantPath, tenantPath);
        const candidateKeys = allKeys.filter((k) => k.startsWith(prefix));

        // TTL-aware filtering: reads each file to check expiration.
        // Retains parsed values to populate ListResult.values, avoiding
        // a redundant getMany() in ContextState.list().
        const validKeys: string[] = [];
        const validValues = new Map<string, unknown>();
        for (const k of candidateKeys) {
          const filePath = this.getFilePath(tenantId, k, context);
          try {
            const raw = await readFile(filePath, 'utf-8');
            const value = await this.parseAndValidate<unknown>(raw, tenantId, k, filePath, context);
            if (value !== null) {
              validKeys.push(k);
              validValues.set(k, value);
            }
          } catch (_e) {}
        }

        validKeys.sort();
        const lastKey = options?.cursor
          ? decodeCursor(options.cursor, tenantId, context)
          : undefined;
        const { keys: paginatedKeys, nextCursor } = paginateSortedKeys(
          validKeys,
          tenantId,
          lastKey,
          options?.limit ?? DEFAULT_LIST_LIMIT,
        );

        // Build a values map for the paginated slice only.
        const paginatedValues = new Map<string, unknown>();
        for (const k of paginatedKeys) {
          const v = validValues.get(k);
          if (v !== undefined) paginatedValues.set(k, v);
        }

        return {
          keys: paginatedKeys,
          nextCursor,
          values: paginatedValues,
        };
      },
      {
        operation: 'FileSystemProvider.list',
        context,
        input: { tenantId, prefix },
      },
    );
  }

  async getMany<T>(
    tenantId: string,
    keys: string[],
    context: RequestContext,
  ): Promise<Map<string, T>> {
    return await ErrorHandler.tryCatch(
      () => getManyViaGet(keys, (key) => this.get<T>(tenantId, key, context)),
      {
        operation: 'FileSystemProvider.getMany',
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
      () =>
        setManyViaSet(entries, (key, value) => this.set(tenantId, key, value, context, options)),
      {
        operation: 'FileSystemProvider.setMany',
        context,
        input: { tenantId, entryCount: entries.size },
      },
    );
  }

  async deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      () => deleteManyViaDelete(keys, (key) => this.delete(tenantId, key, context)),
      {
        operation: 'FileSystemProvider.deleteMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  async clear(tenantId: string, context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        const tenantPath = this.getTenantPath(tenantId, context);
        const allKeys = await this.listFilesRecursively(tenantPath, tenantPath);
        let deletedCount = 0;
        for (const key of allKeys) {
          const deleted = await this.delete(tenantId, key, context);
          if (deleted) {
            deletedCount++;
          }
        }
        return deletedCount;
      },
      {
        operation: 'FileSystemProvider.clear',
        context,
        input: { tenantId },
      },
    );
  }
}
