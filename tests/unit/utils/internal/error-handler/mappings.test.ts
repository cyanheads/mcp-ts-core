/**
 * @fileoverview Test suite for error handler mappings — pattern compilation, caching,
 * and error classification via ERROR_TYPE_MAPPINGS, COMPILED_ERROR_PATTERNS, COMPILED_PROVIDER_PATTERNS.
 * @module tests/utils/internal/error-handler/mappings.test
 */

import { describe, expect, it } from 'vitest';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import {
  COMPILED_ERROR_PATTERNS,
  COMPILED_PROVIDER_PATTERNS,
  ERROR_TYPE_MAPPINGS,
  getCompiledPattern,
  getErrorCategory,
} from '@/utils/internal/error-handler/mappings.js';

describe('Error Handler Mappings', () => {
  describe('getErrorCategory', () => {
    it.each([
      [JsonRpcErrorCode.Timeout, 'upstream'],
      [JsonRpcErrorCode.InternalError, 'server'],
      [JsonRpcErrorCode.InvalidParams, 'client'],
    ] as const)('classifies %s as %s', (code, category) => {
      expect(getErrorCategory(code)).toBe(category);
    });
  });

  // ─── getCompiledPattern ──────────────────────────────────────────────────────

  describe('getCompiledPattern', () => {
    it('should compile string to case-insensitive RegExp', () => {
      const regex = getCompiledPattern('test-pattern');
      expect(regex).toBeInstanceOf(RegExp);
      expect(regex.flags).toContain('i');
      expect(regex.test('TEST-PATTERN')).toBe(true);
    });

    it('should strip global flag from RegExp input', () => {
      const regex = getCompiledPattern(/global-test/gi);
      expect(regex.flags).not.toContain('g');
    });

    it('should add case-insensitive flag to RegExp without it', () => {
      const regex = getCompiledPattern(/case-test/);
      expect(regex.flags).toContain('i');
    });

    it('should return cached instance for identical string input', () => {
      const key = 'unique-cache-test-mappings';
      const a = getCompiledPattern(key);
      const b = getCompiledPattern(key);
      expect(a).toBe(b);
    });

    it('should cache different entries for different inputs', () => {
      const a = getCompiledPattern('input-alpha');
      const b = getCompiledPattern('input-beta');
      expect(a).not.toBe(b);
    });
  });

  // ─── ERROR_TYPE_MAPPINGS ─────────────────────────────────────────────────────

  describe('ERROR_TYPE_MAPPINGS', () => {
    it('should map SyntaxError to ValidationError', () => {
      expect(ERROR_TYPE_MAPPINGS.SyntaxError).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should not map TypeError (falls through to message patterns or InternalError)', () => {
      expect(ERROR_TYPE_MAPPINGS.TypeError).toBeUndefined();
    });

    it('should map RangeError to ValidationError', () => {
      expect(ERROR_TYPE_MAPPINGS.RangeError).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should map URIError to ValidationError', () => {
      expect(ERROR_TYPE_MAPPINGS.URIError).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should map EvalError to InternalError', () => {
      expect(ERROR_TYPE_MAPPINGS.EvalError).toBe(JsonRpcErrorCode.InternalError);
    });

    it('should map ReferenceError to InternalError', () => {
      expect(ERROR_TYPE_MAPPINGS.ReferenceError).toBe(JsonRpcErrorCode.InternalError);
    });

    it('should map AggregateError to InternalError', () => {
      expect(ERROR_TYPE_MAPPINGS.AggregateError).toBe(JsonRpcErrorCode.InternalError);
    });

    it('should map ZodError to ValidationError', () => {
      expect(ERROR_TYPE_MAPPINGS.ZodError).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should have exactly 7 entries', () => {
      expect(Object.keys(ERROR_TYPE_MAPPINGS)).toHaveLength(7);
    });
  });

  // ─── COMPILED_ERROR_PATTERNS ─────────────────────────────────────────────────

  describe('COMPILED_ERROR_PATTERNS', () => {
    it('should have compiledPattern on every entry', () => {
      for (const entry of COMPILED_ERROR_PATTERNS) {
        expect(entry.compiledPattern).toBeInstanceOf(RegExp);
      }
    });

    it('should match "unauthorized" as Unauthorized', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('unauthorized'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Unauthorized);
    });

    it('should match "expired token" as Unauthorized', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('expired token'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Unauthorized);
    });

    it('should NOT match bare "auth" as Unauthorized', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('auth'));
      // bare "auth" should not trigger Unauthorized — it's too ambiguous
      expect(match?.errorCode).not.toBe(JsonRpcErrorCode.Unauthorized);
    });

    it('should classify "Invalid auth token format" as ValidationError not Unauthorized', () => {
      // Simulates the full resolution chain: first match wins across all patterns
      const msg = 'Invalid auth token format';
      let matchedCode: JsonRpcErrorCode | undefined;
      for (const p of COMPILED_ERROR_PATTERNS) {
        if (p.compiledPattern.test(msg)) {
          matchedCode = p.errorCode;
          break;
        }
      }
      expect(matchedCode).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should match "permission denied" as Forbidden', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) =>
        p.compiledPattern.test('permission denied'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Forbidden);
    });

    it('should match "access denied" as Forbidden', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('access denied'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Forbidden);
    });

    it('should match "not found" as NotFound', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('not found'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.NotFound);
    });

    it('should classify "missing required field" as ValidationError not NotFound', () => {
      const msg = 'missing required field: name';
      let matchedCode: JsonRpcErrorCode | undefined;
      for (const p of COMPILED_ERROR_PATTERNS) {
        if (p.compiledPattern.test(msg)) {
          matchedCode = p.errorCode;
          break;
        }
      }
      expect(matchedCode).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should match "invalid input" as ValidationError', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) =>
        p.compiledPattern.test('invalid input format'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ValidationError);
    });

    it('should match "already exists" as Conflict', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('already exists'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Conflict);
    });

    it('should match "rate limit" as RateLimited', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('rate limit'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('should match "timed out" as Timeout', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('timed out'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Timeout);
    });

    it('should match "cancelled" as Timeout', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('cancelled'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Timeout);
    });

    it('should match "service unavailable" as ServiceUnavailable', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) =>
        p.compiledPattern.test('service unavailable'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('should match "zoderror" as ValidationError', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('zoderror'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ValidationError);
    });
  });

  // ─── COMPILED_PROVIDER_PATTERNS ──────────────────────────────────────────────

  describe('COMPILED_PROVIDER_PATTERNS', () => {
    it('should have compiledPattern on every entry', () => {
      for (const entry of COMPILED_PROVIDER_PATTERNS) {
        expect(entry.compiledPattern).toBeInstanceOf(RegExp);
      }
    });

    // AWS patterns
    it('should match AWS ThrottlingException as RateLimited', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('ThrottlingException'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('should match AWS AccessDenied as Forbidden', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) => p.compiledPattern.test('AccessDenied'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Forbidden);
    });

    it('should match AWS ResourceNotFoundException as NotFound', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('ResourceNotFoundException'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.NotFound);
    });

    // HTTP status patterns
    it('should match status code 401 as Unauthorized', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('status code 401'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Unauthorized);
    });

    it('should match status code 403 as Forbidden', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('status code 403'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Forbidden);
    });

    it('should match status code 404 as NotFound', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('status code 404'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.NotFound);
    });

    it('should match status code 429 as RateLimited', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('status code 429'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('should match status code 500 as ServiceUnavailable', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('status code 500'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    // Database patterns
    it('should match ECONNREFUSED as ServiceUnavailable', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) => p.compiledPattern.test('ECONNREFUSED'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('should match ETIMEDOUT as Timeout', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) => p.compiledPattern.test('ETIMEDOUT'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Timeout);
    });

    it('should match "unique constraint" as Conflict', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('unique constraint violation'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Conflict);
    });

    it('should match "foreign key constraint" as ValidationError', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('foreign key constraint'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ValidationError);
    });

    // Supabase patterns
    it('should match "JWT expired" as Unauthorized', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) => p.compiledPattern.test('JWT expired'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Unauthorized);
    });

    it('should match "row level security" as Forbidden', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('row level security'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.Forbidden);
    });

    // LLM patterns
    it('should match "insufficient_quota" as RateLimited', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('insufficient_quota'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('should match "model_not_found" as NotFound', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('model_not_found'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.NotFound);
    });

    it('should match "context_length_exceeded" as ValidationError', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) =>
        p.compiledPattern.test('context_length_exceeded'),
      );
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ValidationError);
    });

    // Network patterns
    it('should match ENOTFOUND as ServiceUnavailable', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) => p.compiledPattern.test('ENOTFOUND'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });

    it('should match ECONNRESET as ServiceUnavailable', () => {
      const match = COMPILED_PROVIDER_PATTERNS.find((p) => p.compiledPattern.test('ECONNRESET'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ServiceUnavailable);
    });
  });
});
