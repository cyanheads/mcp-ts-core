/**
 * @fileoverview Test suite for storage validation utilities
 * @module tests/storage/core/storageValidation.test
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

    it.each<[string, string, string]>([
      ['an empty string', '', 'cannot be an empty string'],
      ['whitespace only', '   ', 'cannot be an empty string'],
      ['more than 128 characters', 'a'.repeat(129), 'exceeds maximum length'],
      ['../ path traversal', '../malicious', 'invalid characters'],
      ['..\\ path traversal', '..\\malicious', 'invalid characters'],
      ['consecutive dots', 'tenant..id', 'consecutive dots'],
      ['a forward slash', 'tenant/id', 'invalid characters'],
      ['a backslash', 'tenant\\id', 'invalid characters'],
      ['a space', 'tenant id', 'invalid characters'],
      ['"!"', 'tenant!id', 'invalid characters'],
      ['"@"', 'tenant@id', 'invalid characters'],
      ['"#"', 'tenant#id', 'invalid characters'],
      ['"$"', 'tenant$id', 'invalid characters'],
      ['"%"', 'tenant%id', 'invalid characters'],
      ['a leading hyphen', '-tenant123', 'invalid characters'],
      ['a trailing dot', 'tenant123.', 'invalid characters'],
    ])('rejects a tenant ID with %s as InvalidParams', (_label, tenantId, message) => {
      expect(() => validateTenantId(tenantId, context)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining(message),
        }),
      );
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
  });

  describe('decodeCursor', () => {
    it('rejects a cursor with no signature separator as InvalidParams', () => {
      expect(() => decodeCursor('invalid-cursor', 'tenant', context)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InvalidParams,
          message: expect.stringContaining('missing signature'),
        }),
      );
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

    it('rejects a cursor whose payload was tampered to enumerate a different key (HMAC forgery)', () => {
      // Attack: take a validly-signed cursor and swap its base64 payload to point
      // at another key inside the same tenant, keeping the original signature.
      // The HMAC must reject it, blocking key enumeration by cursor forgery.
      const valid = encodeCursor('user:alice', 'tenant');
      const dotIndex = valid.lastIndexOf('.');
      const originalSignature = valid.substring(dotIndex + 1);
      const forgedPayload = stringToBase64(JSON.stringify({ k: 'user:victim', t: 'tenant' }));
      const forged = `${forgedPayload}.${originalSignature}`;

      expect(() => decodeCursor(forged, 'tenant', context)).toThrow(McpError);
      try {
        decodeCursor(forged, 'tenant', context);
      } catch (error) {
        expect((error as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
      }
    });
  });

  /**
   * A correctly signed cursor is the only way past the signature check, so the
   * payload branches (JSON parse, shape check, catch-all) are reached by pinning
   * the per-process HMAC key and signing malformed payloads with it.
   */
  describe('decodeCursor payload validation (pinned HMAC key)', () => {
    const hmacKey = Buffer.alloc(32, 7);
    let pinnedDecode: typeof decodeCursor;

    /** Signs a raw payload exactly as `signCursor` does, under the pinned key. */
    const signed = (payloadText: string): string => {
      const payload = stringToBase64(payloadText);
      const mac = createHmac('sha256', hmacKey).update(payload).digest().subarray(0, 16);
      return `${payload}.${stringToBase64(mac.toString('binary'))}`;
    };

    beforeAll(async () => {
      vi.resetModules();
      const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
      vi.doMock('node:crypto', () => ({ ...actual, randomBytes: () => hmacKey }));
      ({ decodeCursor: pinnedDecode } = await import('@/storage/core/storageValidation.js'));
    });

    afterAll(() => {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    });

    it('accepts a well-formed payload signed with the pinned key', () => {
      expect(
        pinnedDecode(signed(JSON.stringify({ k: 'key-1', t: 'tenant' })), 'tenant', context),
      ).toBe('key-1');
    });

    it.each([
      ['missing k', { t: 'tenant' }],
      ['missing t', { k: 'key' }],
      ['an empty object', {}],
      ['a string', 'string'],
      ['null', null],
      ['a number', 123],
    ])('rejects a signed payload that decodes to %s as an invalid shape', (_label, value) => {
      expect(() => pinnedDecode(signed(JSON.stringify(value)), 'tenant', context)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InvalidParams,
          message: 'Invalid cursor format.',
        }),
      );
    });

    it('rejects a signed non-JSON payload without leaking the parser error into data (issue #71)', () => {
      // The catch-all branch: JSON.parse throws on the verified payload. The
      // pre-fix code put the parser's stack on `data.rawError`, which the
      // framework forwards to clients via structuredContent.error.data (tools)
      // and JSON-RPC error.data (resources).
      let thrown: unknown;
      try {
        pinnedDecode(signed('not-json{'), 'tenant', context);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: expect.stringContaining('Failed to decode cursor'),
      });
      expect((thrown as McpError).data).toEqual({ ...context, operation: 'decodeCursor' });
    });
  });
});
