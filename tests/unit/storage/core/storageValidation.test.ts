/**
 * @fileoverview Test suite for storage validation utilities
 * @module tests/storage/core/storageValidation.test
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  validateKey,
  validateListOptions,
  validatePrefix,
  validateStorageOptions,
  validateTenantId,
} from '@/storage/core/storageValidation.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { stringToBase64 } from '@/utils/internal/encoding.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

describe('Storage Validation', () => {
  const context: RequestContext = {
    requestId: 'test-id',
    timestamp: new Date().toISOString(),
  };

  describe('validateTenantId', () => {
    it('should accept valid tenant IDs', () => {
      expect(() => validateTenantId('tenant-123', context)).not.toThrow();
      expect(() => validateTenantId('test_tenant', context)).not.toThrow();
      expect(() => validateTenantId('tenant.123', context)).not.toThrow();
      expect(() => validateTenantId('a1b2c3', context)).not.toThrow();
    });

    it('should reject empty tenant ID', () => {
      expect(() => validateTenantId('', context)).toThrow(McpError);
      expect(() => validateTenantId('', context)).toThrow(/Tenant ID cannot be an empty string/);
    });

    it('should reject tenant ID with path traversal', () => {
      expect(() => validateTenantId('../malicious', context)).toThrow(McpError);
      expect(() => validateTenantId('..\\malicious', context)).toThrow(McpError);
    });

    it('should reject tenant ID with consecutive dots', () => {
      expect(() => validateTenantId('tenant..id', context)).toThrow(McpError);
    });

    it('should reject tenant ID that is too long', () => {
      const longId = 'a'.repeat(129);
      expect(() => validateTenantId(longId, context)).toThrow(McpError);
    });

    it('should reject tenant ID with invalid characters', () => {
      expect(() => validateTenantId('tenant@id', context)).toThrow(McpError);
      expect(() => validateTenantId('tenant id', context)).toThrow(McpError);
      expect(() => validateTenantId('tenant/id', context)).toThrow(McpError);
    });

    it('should throw McpError with InvalidParams code', () => {
      expect(() => validateTenantId('', context)).toThrow(McpError);

      try {
        validateTenantId('', context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
      }
    });
  });

  describe('validateKey', () => {
    it('should accept valid keys', () => {
      expect(() => validateKey('user123', context)).not.toThrow();
      expect(() => validateKey('data-key', context)).not.toThrow();
      expect(() => validateKey('key_with_underscore', context)).not.toThrow();
      expect(() => validateKey('path/to/key', context)).not.toThrow();
    });

    it('should reject empty key', () => {
      expect(() => validateKey('', context)).toThrow(McpError);
      expect(() => validateKey('', context)).toThrow(/Key must be a non-empty string/);
    });

    it('should reject null or undefined key', () => {
      expect(() => validateKey(null as any, context)).toThrow(McpError);
      expect(() => validateKey(undefined as any, context)).toThrow(McpError);
    });

    it('should reject key that is too long', () => {
      const longKey = 'k'.repeat(1025);
      expect(() => validateKey(longKey, context)).toThrow(McpError);
    });

    it('should reject key with invalid characters', () => {
      expect(() => validateKey('key with spaces', context)).toThrow(McpError);
      expect(() => validateKey('key@invalid', context)).toThrow(McpError);
      expect(() => validateKey('key#hash', context)).toThrow(McpError);
    });

    it('should reject key with path traversal', () => {
      expect(() => validateKey('key/../malicious', context)).toThrow(McpError);
      expect(() => validateKey('..', context)).toThrow(McpError);
    });

    it('should throw McpError with ValidationError code', () => {
      expect(() => validateKey('', context)).toThrow(McpError);

      try {
        validateKey('', context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      }
    });
  });

  describe('validatePrefix', () => {
    it('should accept valid prefixes', () => {
      expect(() => validatePrefix('user', context)).not.toThrow();
      expect(() => validatePrefix('', context)).not.toThrow();
      expect(() => validatePrefix('namespace/', context)).not.toThrow();
      expect(() => validatePrefix('data-prefix', context)).not.toThrow();
    });

    it('should accept empty prefix', () => {
      expect(() => validatePrefix('', context)).not.toThrow();
    });

    it('should reject prefix that is not a string', () => {
      expect(() => validatePrefix(null as any, context)).toThrow(McpError);
      expect(() => validatePrefix(undefined as any, context)).toThrow(McpError);
      expect(() => validatePrefix(123 as any, context)).toThrow(McpError);
      expect(() => validatePrefix({} as any, context)).toThrow(McpError);
    });

    it('should reject prefix that is too long', () => {
      const longPrefix = 'p'.repeat(513);
      expect(() => validatePrefix(longPrefix, context)).toThrow(McpError);
    });

    it('should reject prefix with invalid characters', () => {
      expect(() => validatePrefix('prefix with spaces', context)).toThrow(McpError);
      expect(() => validatePrefix('prefix@invalid', context)).toThrow(McpError);
      expect(() => validatePrefix('prefix#hash', context)).toThrow(McpError);
    });

    it('should reject prefix with path traversal', () => {
      expect(() => validatePrefix('prefix/../malicious', context)).toThrow(McpError);
      expect(() => validatePrefix('..', context)).toThrow(McpError);
    });

    it('should throw McpError with ValidationError code', () => {
      const longPrefix = 'p'.repeat(513);
      expect(() => validatePrefix(longPrefix, context)).toThrow(McpError);

      try {
        validatePrefix(longPrefix, context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      }
    });
  });

  describe('validateStorageOptions', () => {
    it('should accept valid storage options', () => {
      expect(() => validateStorageOptions({ ttl: 3600 }, context)).not.toThrow();
      expect(() => validateStorageOptions({}, context)).not.toThrow();
      expect(() => validateStorageOptions(undefined, context)).not.toThrow();
    });

    it('should accept ttl of 0 (immediate expiration)', () => {
      expect(() => validateStorageOptions({ ttl: 0 }, context)).not.toThrow();
    });

    it('should accept large valid ttl values', () => {
      expect(() => validateStorageOptions({ ttl: 86400 * 365 }, context)).not.toThrow();
    });

    it('should reject negative ttl', () => {
      expect(() => validateStorageOptions({ ttl: -1 }, context)).toThrow(McpError);
    });

    it('should reject ttl that is not a number', () => {
      expect(() => validateStorageOptions({ ttl: 'invalid' as any }, context)).toThrow(McpError);
      expect(() => validateStorageOptions({ ttl: null as any }, context)).toThrow(McpError);
      expect(() => validateStorageOptions({ ttl: {} as any }, context)).toThrow(McpError);
    });

    it('should reject ttl that is Infinity', () => {
      expect(() => validateStorageOptions({ ttl: Infinity }, context)).toThrow(McpError);
      expect(() => validateStorageOptions({ ttl: -Infinity }, context)).toThrow(McpError);
    });

    it('should reject ttl that is NaN', () => {
      expect(() => validateStorageOptions({ ttl: NaN }, context)).toThrow(McpError);
    });

    it('should throw McpError with ValidationError code', () => {
      expect(() => validateStorageOptions({ ttl: -1 }, context)).toThrow(McpError);

      try {
        validateStorageOptions({ ttl: -1 }, context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      }
    });
  });

  describe('validateListOptions', () => {
    it('should accept valid list options', () => {
      expect(() => validateListOptions({ limit: 100 }, context)).not.toThrow();
      expect(() => validateListOptions({ cursor: 'abc123' }, context)).not.toThrow();
      expect(() => validateListOptions({}, context)).not.toThrow();
      expect(() => validateListOptions(undefined, context)).not.toThrow();
    });

    it('should accept valid base64 cursors', () => {
      const validCursor = encodeCursor('key', 'tenant');
      expect(() => validateListOptions({ cursor: validCursor }, context)).not.toThrow();
    });

    it('should reject negative limit', () => {
      expect(() => validateListOptions({ limit: -1 }, context)).toThrow(McpError);
    });

    it('should reject limit of 0', () => {
      expect(() => validateListOptions({ limit: 0 }, context)).toThrow(McpError);
    });

    it('should reject limit greater than maximum', () => {
      expect(() => validateListOptions({ limit: 10001 }, context)).toThrow(McpError);
    });

    it('should reject limit that is not a number', () => {
      expect(() => validateListOptions({ limit: 'invalid' as any }, context)).toThrow(McpError);
      expect(() => validateListOptions({ limit: null as any }, context)).toThrow(McpError);
    });

    it('should reject limit that is not an integer', () => {
      expect(() => validateListOptions({ limit: 10.5 }, context)).toThrow(McpError);
      expect(() => validateListOptions({ limit: 3.14 }, context)).toThrow(McpError);
    });

    it('should reject limit that is Infinity', () => {
      expect(() => validateListOptions({ limit: Infinity }, context)).toThrow(McpError);
      expect(() => validateListOptions({ limit: -Infinity }, context)).toThrow(McpError);
    });

    it('should reject cursor that is not a string', () => {
      expect(() => validateListOptions({ cursor: 123 as any }, context)).toThrow(McpError);
      expect(() => validateListOptions({ cursor: null as any }, context)).toThrow(McpError);
      expect(() => validateListOptions({ cursor: {} as any }, context)).toThrow(McpError);
    });

    it('should reject cursor that is empty or whitespace', () => {
      expect(() => validateListOptions({ cursor: '' }, context)).toThrow(McpError);
      expect(() => validateListOptions({ cursor: '   ' }, context)).toThrow(McpError);
    });

    it('should reject cursor with invalid base64 characters', () => {
      expect(() => validateListOptions({ cursor: 'invalid!@#$' }, context)).toThrow(McpError);
      expect(() => validateListOptions({ cursor: 'test cursor' }, context)).toThrow(McpError);
    });

    it('should throw McpError with ValidationError code', () => {
      expect(() => validateListOptions({ limit: -1 }, context)).toThrow(McpError);

      try {
        validateListOptions({ limit: -1 }, context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
      }
    });
  });

  describe('encodeCursor', () => {
    it('should encode cursor with lastKey and tenantId', () => {
      const cursor = encodeCursor('last-key', 'tenant-123');
      expect(cursor).toBeDefined();
      expect(typeof cursor).toBe('string');
      expect(cursor.length).toBeGreaterThan(0);
    });

    it('should produce different cursors for different inputs', () => {
      const cursor1 = encodeCursor('key1', 'tenant1');
      const cursor2 = encodeCursor('key2', 'tenant1');
      const cursor3 = encodeCursor('key1', 'tenant2');

      expect(cursor1).not.toBe(cursor2);
      expect(cursor1).not.toBe(cursor3);
      expect(cursor2).not.toBe(cursor3);
    });

    it('should be reversible via decodeCursor', () => {
      const lastKey = 'test-key-123';
      const tenantId = 'tenant-456';
      const cursor = encodeCursor(lastKey, tenantId);
      const decoded = decodeCursor(cursor, tenantId, context);

      expect(decoded).toBe(lastKey);
    });

    it('should handle keys with special characters', () => {
      const specialKeys = [
        'key/with/slashes',
        'key-with-hyphens',
        'key_with_underscores',
        'key.with.dots',
      ];

      for (const key of specialKeys) {
        const cursor = encodeCursor(key, 'tenant');
        const decoded = decodeCursor(cursor, 'tenant', context);
        expect(decoded).toBe(key);
      }
    });

    it('should handle very long keys', () => {
      const longKey = 'k'.repeat(1000);
      const cursor = encodeCursor(longKey, 'tenant');
      const decoded = decodeCursor(cursor, 'tenant', context);
      expect(decoded).toBe(longKey);
    });

    it('should handle empty keys', () => {
      const cursor = encodeCursor('', 'tenant');
      const decoded = decodeCursor(cursor, 'tenant', context);
      expect(decoded).toBe('');
    });
  });

  describe('decodeCursor', () => {
    it('should decode valid cursor', () => {
      const cursor = encodeCursor('my-key', 'my-tenant');
      const decoded = decodeCursor(cursor, 'my-tenant', context);

      expect(decoded).toBe('my-key');
    });

    it('should reject cursor for different tenant', () => {
      const cursor = encodeCursor('key', 'tenant1');

      expect(() => decodeCursor(cursor, 'tenant2', context)).toThrow(McpError);
    });

    it('should reject invalid cursor format', () => {
      expect(() => decodeCursor('invalid-cursor', 'tenant', context)).toThrow(McpError);
    });

    it('should reject malformed JSON in cursor', () => {
      // Create a base64-encoded invalid JSON
      const invalidJson = Buffer.from('{invalid json}').toString('base64');
      expect(() => decodeCursor(invalidJson, 'tenant', context)).toThrow(McpError);
    });

    it('should reject cursor with missing fields', () => {
      // Cursor missing 'k' field
      const missingK = Buffer.from(JSON.stringify({ t: 'tenant' })).toString('base64');
      expect(() => decodeCursor(missingK, 'tenant', context)).toThrow(McpError);

      // Cursor missing 't' field
      const missingT = Buffer.from(JSON.stringify({ k: 'key' })).toString('base64');
      expect(() => decodeCursor(missingT, 'tenant', context)).toThrow(McpError);

      // Cursor with neither field
      const missingBoth = Buffer.from(JSON.stringify({})).toString('base64');
      expect(() => decodeCursor(missingBoth, 'tenant', context)).toThrow(McpError);
    });

    it('should reject cursor that is not a valid object', () => {
      // Cursor that decodes to a string instead of an object
      const notObject = Buffer.from(JSON.stringify('string')).toString('base64');
      expect(() => decodeCursor(notObject, 'tenant', context)).toThrow(McpError);

      // Cursor that decodes to null
      const nullCursor = Buffer.from(JSON.stringify(null)).toString('base64');
      expect(() => decodeCursor(nullCursor, 'tenant', context)).toThrow(McpError);

      // Cursor that decodes to a number
      const numberCursor = Buffer.from(JSON.stringify(123)).toString('base64');
      expect(() => decodeCursor(numberCursor, 'tenant', context)).toThrow(McpError);
    });

    it('should reject cursor that is not valid base64', () => {
      expect(() => decodeCursor('not-base64!', 'tenant', context)).toThrow(McpError);
    });

    it('should throw McpError with InvalidParams code for invalid cursor', () => {
      expect(() => decodeCursor('invalid', 'tenant', context)).toThrow(McpError);

      try {
        decodeCursor('invalid', 'tenant', context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
      }
    });

    it('should throw McpError with InvalidParams code for tenant mismatch', () => {
      const cursor = encodeCursor('key', 'tenant1');

      expect(() => decodeCursor(cursor, 'tenant2', context)).toThrow(McpError);

      try {
        decodeCursor(cursor, 'tenant2', context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
      }
    });

    it('should not leak the internal error stack into McpError.data (issue #71)', () => {
      // Trigger the catch-all branch — JSON.parse throws on a base64-decoded
      // payload that isn't valid JSON. The pre-fix code would put the parser's
      // stack on `data.rawError`, which the framework forwards to clients via
      // structuredContent.error.data (tools) / JSON-RPC error.data (resources).
      const malformedPayload = stringToBase64('not-json{');
      const malformedCursor = encodeCursor('seed', 'tenant');
      // Splice the bad payload before the signature dot to hit the JSON.parse path
      const dotIndex = malformedCursor.lastIndexOf('.');
      const forged = `${malformedPayload}${malformedCursor.substring(dotIndex)}`;

      try {
        decodeCursor(forged, 'tenant', context);
        throw new Error('decodeCursor should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const data = (error as McpError).data ?? {};
        expect(data).not.toHaveProperty('rawError');
        // Sanity — public surface stays minimal: operation + request context only
        expect(Object.keys(data)).toEqual(expect.arrayContaining(['operation']));
      }
    });
  });

  describe('Function Export Verification', () => {
    it('should export all validation functions', () => {
      expect(validateTenantId).toBeDefined();
      expect(typeof validateTenantId).toBe('function');

      expect(validateKey).toBeDefined();
      expect(typeof validateKey).toBe('function');

      expect(validatePrefix).toBeDefined();
      expect(typeof validatePrefix).toBe('function');

      expect(validateStorageOptions).toBeDefined();
      expect(typeof validateStorageOptions).toBe('function');

      expect(validateListOptions).toBeDefined();
      expect(typeof validateListOptions).toBe('function');

      expect(encodeCursor).toBeDefined();
      expect(typeof encodeCursor).toBe('function');

      expect(decodeCursor).toBeDefined();
      expect(typeof decodeCursor).toBe('function');
    });
  });
});
