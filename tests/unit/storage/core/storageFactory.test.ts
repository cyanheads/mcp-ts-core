/**
 * @fileoverview Unit tests for storage provider factory.
 * @module tests/storage/core/storageFactory
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/config/index.js';

import { createStorageProvider } from '@/storage/core/storageFactory.js';
import { D1Provider } from '@/storage/providers/cloudflare/d1Provider.js';
import { KvProvider } from '@/storage/providers/cloudflare/kvProvider.js';
import { R2Provider } from '@/storage/providers/cloudflare/r2Provider.js';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { SupabaseProvider } from '@/storage/providers/supabase/supabaseProvider.js';
import { McpError } from '@/types-global/errors.js';

const originalIsServerless = process.env.IS_SERVERLESS;

afterEach(() => {
  if (originalIsServerless === undefined) {
    delete process.env.IS_SERVERLESS;
  } else {
    process.env.IS_SERVERLESS = originalIsServerless;
  }

  delete (globalThis as Record<string, unknown>).DB;
  delete (globalThis as Record<string, unknown>).KV_NAMESPACE;
  delete (globalThis as Record<string, unknown>).R2_BUCKET;
});

describe('createStorageProvider', () => {
  describe('in-memory provider', () => {
    it('should create InMemoryProvider when configured', () => {
      const mockConfig = {
        storage: {
          providerType: 'in-memory' as const,
        },
      } as AppConfig;

      const provider = createStorageProvider(mockConfig);

      expect(provider).toBeInstanceOf(InMemoryProvider);
    });
  });

  describe('filesystem provider', () => {
    it('should create FileSystemProvider with valid path', () => {
      const mockConfig = {
        storage: {
          providerType: 'filesystem' as const,
          filesystemPath: '/tmp/test-storage',
        },
      } as AppConfig;

      const provider = createStorageProvider(mockConfig);

      expect(provider).toBeInstanceOf(FileSystemProvider);
    });

    it('should throw McpError when filesystem path is missing', () => {
      const mockConfig = {
        storage: {
          providerType: 'filesystem' as const,
          filesystemPath: undefined,
        },
      } as unknown as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /STORAGE_FILESYSTEM_PATH must be set/,
      );
      // #548 — the startup context is log metadata, not error data.
      expect(() => createStorageProvider(mockConfig)).toThrow(
        expect.objectContaining({ data: undefined }),
      );
    });
  });

  describe('supabase provider', () => {
    it('should create SupabaseProvider with provided client', () => {
      const mockConfig = {
        storage: {
          providerType: 'supabase' as const,
        },
        supabase: {
          url: 'https://test.supabase.co',
          serviceRoleKey: 'test-key',
        },
      } as AppConfig;

      const mockClient = {
        from: vi.fn(),
      };

      // Provide the client to avoid DI container issues
      const provider = createStorageProvider(mockConfig, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabaseClient: mockClient as any,
      });

      expect(provider).toBeInstanceOf(SupabaseProvider);
    });

    it('should throw McpError when supabase URL is missing', () => {
      const mockConfig = {
        storage: {
          providerType: 'supabase' as const,
        },
        supabase: {
          url: undefined,
          serviceRoleKey: 'test-key',
        },
      } as unknown as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set/,
      );
    });

    it('should throw McpError when supabase service role key is missing', () => {
      const mockConfig = {
        storage: {
          providerType: 'supabase' as const,
        },
        supabase: {
          url: 'https://test.supabase.co',
          serviceRoleKey: undefined,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
    });

    it('should throw when supabase config is present but no client is injected', () => {
      const mockConfig = {
        storage: {
          providerType: 'supabase' as const,
        },
        supabase: {
          serviceRoleKey: 'test-key',
          url: 'https://test.supabase.co',
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /Supabase client must be provided via deps/,
      );
    });
  });

  describe('cloudflare providers', () => {
    it('should throw error for R2 provider outside serverless environment', () => {
      const mockConfig = {
        storage: {
          providerType: 'cloudflare-r2' as const,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /Cloudflare R2 storage is only available in a Cloudflare Worker environment/,
      );
    });

    it('should throw error for KV provider outside serverless environment', () => {
      const mockConfig = {
        storage: {
          providerType: 'cloudflare-kv' as const,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /Cloudflare KV storage is only available in a Cloudflare Worker environment/,
      );
    });

    it('should throw error for D1 provider outside serverless environment', () => {
      const mockConfig = {
        storage: {
          providerType: 'cloudflare-d1' as const,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /Cloudflare D1 storage is only available in a Cloudflare Worker environment/,
      );
    });

    it('should create R2 provider from injected deps in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';

      const provider = createStorageProvider(
        {
          storage: {
            providerType: 'cloudflare-r2' as const,
          },
        } as AppConfig,
        {
          r2Bucket: {} as any,
        },
      );

      expect(provider).toBeInstanceOf(R2Provider);
    });

    it('should create R2 provider from global binding in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';
      (globalThis as Record<string, unknown>).R2_BUCKET = {};

      const provider = createStorageProvider({
        storage: {
          providerType: 'cloudflare-r2' as const,
        },
      } as AppConfig);

      expect(provider).toBeInstanceOf(R2Provider);
    });

    it('should throw when the R2 global binding is missing in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';

      const mockConfig = {
        storage: {
          providerType: 'cloudflare-r2' as const,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(/R2_BUCKET binding not available/);
    });

    it('should create KV provider from injected deps in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';

      const provider = createStorageProvider(
        {
          storage: {
            providerType: 'cloudflare-kv' as const,
          },
        } as AppConfig,
        {
          kvNamespace: {} as any,
        },
      );

      expect(provider).toBeInstanceOf(KvProvider);
    });

    it('should create KV provider from global binding in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';
      (globalThis as Record<string, unknown>).KV_NAMESPACE = {};

      const provider = createStorageProvider({
        storage: {
          providerType: 'cloudflare-kv' as const,
        },
      } as AppConfig);

      expect(provider).toBeInstanceOf(KvProvider);
    });

    it('should create D1 provider from injected deps in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';

      const provider = createStorageProvider(
        {
          storage: {
            providerType: 'cloudflare-d1' as const,
          },
        } as AppConfig,
        {
          d1Database: {} as any,
        },
      );

      expect(provider).toBeInstanceOf(D1Provider);
    });

    it('should create D1 provider from global binding in serverless mode', () => {
      process.env.IS_SERVERLESS = 'true';
      (globalThis as Record<string, unknown>).DB = {};

      const provider = createStorageProvider({
        storage: {
          providerType: 'cloudflare-d1' as const,
        },
      } as AppConfig);

      expect(provider).toBeInstanceOf(D1Provider);
    });
  });

  describe('unknown provider type', () => {
    it('should throw error for unsupported provider type', () => {
      const mockConfig = {
        storage: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          providerType: 'invalid-provider' as any,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(/Unhandled storage provider type/);
    });
  });

  describe('edge cases', () => {
    it('should reject filesystem provider in serverless mode before path validation', () => {
      process.env.IS_SERVERLESS = 'true';

      const mockConfig = {
        storage: {
          filesystemPath: '/tmp/test-storage',
          providerType: 'filesystem' as const,
        },
      } as AppConfig;

      expect(() => createStorageProvider(mockConfig)).toThrow(McpError);
      expect(() => createStorageProvider(mockConfig)).toThrow(
        /not supported in serverless environments/,
      );
    });
  });
});
