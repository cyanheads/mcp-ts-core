/**
 * @fileoverview Tests for the FileSystem storage provider.
 * @module tests/storage/providers/fileSystem/fileSystemProvider.test.ts
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

const TEST_STORAGE_PATH = path.join(process.cwd(), '.test-storage-fs');

describe('FileSystemProvider', () => {
  let provider: FileSystemProvider;
  let testContext: ReturnType<typeof requestContextService.createRequestContext>;

  beforeEach(() => {
    // Clean up any existing test storage
    if (existsSync(TEST_STORAGE_PATH)) {
      rmSync(TEST_STORAGE_PATH, { recursive: true, force: true });
    }
    mkdirSync(TEST_STORAGE_PATH, { recursive: true });

    provider = new FileSystemProvider(TEST_STORAGE_PATH);
    testContext = requestContextService.createRequestContext({
      operation: 'test',
    });
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(TEST_STORAGE_PATH)) {
      rmSync(TEST_STORAGE_PATH, { recursive: true, force: true });
    }
  });

  describe('Constructor', () => {
    it('should create storage directory if it does not exist', () => {
      const newPath = path.join(TEST_STORAGE_PATH, 'new-dir');
      const newProvider = new FileSystemProvider(newPath);
      expect(existsSync(newPath)).toBe(true);
      expect(newProvider).toBeDefined();
    });

    it('should throw error when storage path is empty', () => {
      expect(() => new FileSystemProvider('')).toThrow(McpError);
    });
  });

  describe('Path Traversal Security', () => {
    it('should prevent path traversal with ../ in key', async () => {
      await expect(
        provider.set('tenant1', '../../../etc/passwd', { data: 'evil' }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should prevent path traversal with ../ in tenant ID', async () => {
      const evilProvider = new FileSystemProvider(TEST_STORAGE_PATH);
      await expect(
        evilProvider.set('../../evil-tenant', 'key1', { data: 'evil' }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should sanitize tenant IDs containing slashes', async () => {
      await expect(
        provider.set('tenant/with/slashes', 'key1', { data: 'test' }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should reject tenantId "." that would collapse into the storage root', async () => {
      // Pre-fix: tenant '.' wrote into storage root, overlapping every other tenant's keyspace.
      await expect(
        provider.set('.', 'alice/secret', { hijacked: true }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should reject tenantId variants the upstream gate blocks', async () => {
      for (const bad of ['./alice', 'alice/.', '.alice', 'alice.', 'alice..bob', '']) {
        await expect(provider.set(bad, 'k', { v: 1 }, testContext)).rejects.toThrow(McpError);
      }
    });
  });

  describe('List Operation', () => {
    it('should skip files with corrupted JSON during list rather than throwing', async () => {
      const fs = await import('node:fs/promises');
      const tenantPath = path.join(TEST_STORAGE_PATH, 'tenant1');
      mkdirSync(tenantPath, { recursive: true });
      await provider.set('tenant1', 'good-key', { value: 1 }, testContext);
      await fs.writeFile(path.join(tenantPath, 'corrupt-key'), 'not-valid-json{{{', 'utf-8');

      const result = await provider.list('tenant1', '', testContext);

      expect(result.keys).toEqual(['good-key']);
    });
  });

  describe('Error Handling', () => {
    it('should handle very long keys up to filesystem limits', async () => {
      // Use a reasonably long key that stays within filesystem limits
      const longKey = 'a'.repeat(200);
      await provider.set('tenant1', longKey, { data: 'test' }, testContext);

      const result = await provider.get('tenant1', longKey, testContext);
      expect(result).toEqual({ data: 'test' });
    });

    it('should reject a corrupted stored value as SerializationError', async () => {
      const fs = await import('node:fs/promises');
      const tenantPath = path.join(TEST_STORAGE_PATH, 'tenant1');
      mkdirSync(tenantPath, { recursive: true });
      await fs.writeFile(path.join(tenantPath, 'corrupt-key'), 'not-valid-json{{{', 'utf-8');

      await expect(provider.get('tenant1', 'corrupt-key', testContext)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
    });

    it('should read a missing key as null and delete it as false', async () => {
      await expect(provider.get('tenant1', 'absent', testContext)).resolves.toBeNull();
      await expect(provider.delete('tenant1', 'absent', testContext)).resolves.toBe(false);
    });

    // A directory where a file is expected — a key colliding with a stored
    // prefix — fails with a directory error, not ENOENT, so the provider must
    // reject rather than treat it as a missing key. The raw fs error quotes the
    // absolute path; the rejection names the key instead (#645).
    it.each([
      ['get', 'read'],
      ['delete', 'delete'],
    ] as const)(
      'should reject a non-ENOENT %s failure as DatabaseError without the storage path',
      async (operation, verb) => {
        mkdirSync(path.join(TEST_STORAGE_PATH, 'tenant1', 'dir-not-file'), { recursive: true });

        const error = await provider[operation]('tenant1', 'dir-not-file', testContext).catch(
          (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.DatabaseError,
          message: `Failed to ${verb} stored value for key "dir-not-file".`,
        });
        expect((error as McpError).message).not.toContain(TEST_STORAGE_PATH);
        expect((error as McpError).data).not.toHaveProperty('rootCause');
        expect(JSON.stringify((error as McpError).data)).not.toContain(TEST_STORAGE_PATH);
      },
    );
  });

  describe('Legacy Data Format Support', () => {
    it('should handle legacy data without envelope', async () => {
      // Simulate legacy data by directly writing JSON without envelope
      const fs = await import('node:fs/promises');
      const tenantPath = path.join(TEST_STORAGE_PATH, 'tenant1');
      mkdirSync(tenantPath, { recursive: true });
      await fs.writeFile(
        path.join(tenantPath, 'legacy-key'),
        JSON.stringify({ legacyData: 'test' }),
        'utf-8',
      );

      const result = await provider.get('tenant1', 'legacy-key', testContext);
      expect(result).toEqual({ legacyData: 'test' });
    });
  });
});
