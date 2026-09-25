/**
 * @fileoverview Tests for StorageService tenant ID validation and security.
 * @module tests/storage/StorageService.test
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';

describe('StorageService - Tenant ID Validation', () => {
  let storageService: StorageService;
  let baseContext: RequestContext;

  beforeEach(() => {
    storageService = new StorageService(new InMemoryProvider());

    baseContext = requestContextService.createRequestContext({
      operation: 'test-storage-service',
    });
  });

  describe('Valid Tenant IDs', () => {
    it.each([
      ['simple alphanumeric', 'tenant123'],
      ['hyphens', 'tenant-123'],
      ['underscores', 'tenant_123'],
      ['dots', 'tenant.123'],
      ['mixed valid characters', 'tenant-123_abc.xyz'],
      ['maximum length (128 characters)', 'a'.repeat(128)],
      ['a single character', 'a'],
      ['two characters', 'ab'],
    ])('should accept a tenant ID with %s', async (_label, tenantId) => {
      const context = { ...baseContext, tenantId };
      await expect(storageService.set('test-key', 'test-value', context)).resolves.toBeUndefined();
    });

    it('should trim and accept tenant ID with whitespace', async () => {
      const context = { ...baseContext, tenantId: '  tenant123  ' };
      await expect(storageService.set('test-key', 'test-value', context)).resolves.toBeUndefined();

      // Verify the trimmed value was used
      const result = await storageService.get<string>('test-key', {
        ...baseContext,
        tenantId: 'tenant123',
      });
      expect(result).toBe('test-value');
    });
  });

  describe('Invalid Tenant IDs - Missing or Empty', () => {
    it('should reject missing tenant ID', async () => {
      const context = { ...baseContext }; // No tenantId

      let thrown: Error | null = null;
      try {
        await storageService.set('test-key', 'test-value', context);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeInstanceOf(McpError);
      const mcpError = thrown as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.InternalError);
      expect(mcpError.message).toContain('Tenant ID is required');
    });

    it('should reject empty string tenant ID', async () => {
      const context = { ...baseContext, tenantId: '' };

      let thrown: Error | null = null;
      try {
        await storageService.set('test-key', 'test-value', context);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeInstanceOf(McpError);
      const mcpError = thrown as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mcpError.message).toContain('cannot be an empty string');
    });

    it('should reject whitespace-only tenant ID', async () => {
      const context = { ...baseContext, tenantId: '   ' };

      let thrown: Error | null = null;
      try {
        await storageService.set('test-key', 'test-value', context);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeInstanceOf(McpError);
      const mcpError = thrown as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(mcpError.message).toContain('cannot be an empty string');
    });
  });

  describe('All Storage Operations', () => {
    it('should validate tenant ID in all methods', async () => {
      const invalidContext = {
        ...baseContext,
        tenantId: '../invalid',
      };

      // Test each method
      const methods = [
        () => storageService.get('key', invalidContext),
        () => storageService.set('key', 'value', invalidContext),
        () => storageService.delete('key', invalidContext),
        () => storageService.list('prefix', invalidContext),
        () => storageService.getMany(['key1'], invalidContext),
        () => storageService.setMany(new Map([['k', 'v']]), invalidContext),
        () => storageService.deleteMany(['key1'], invalidContext),
        () => storageService.clear(invalidContext),
      ];

      for (const method of methods) {
        let thrown: Error | null = null;
        try {
          await method();
        } catch (error) {
          thrown = error as Error;
        }

        expect(thrown).toBeInstanceOf(McpError);
        const mcpError = thrown as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.InvalidParams);
      }
    });
  });

  describe('Tenant Isolation', () => {
    it('should isolate data between tenants', async () => {
      const tenant1Context = {
        ...baseContext,
        tenantId: 'tenant1',
      };
      const tenant2Context = {
        ...baseContext,
        tenantId: 'tenant2',
      };

      // Set value for tenant1
      await storageService.set('shared-key', 'tenant1-value', tenant1Context);

      // Set value for tenant2
      await storageService.set('shared-key', 'tenant2-value', tenant2Context);

      // Verify isolation
      const tenant1Value = await storageService.get<string>('shared-key', tenant1Context);
      const tenant2Value = await storageService.get<string>('shared-key', tenant2Context);

      expect(tenant1Value).toBe('tenant1-value');
      expect(tenant2Value).toBe('tenant2-value');
    });
  });
});
