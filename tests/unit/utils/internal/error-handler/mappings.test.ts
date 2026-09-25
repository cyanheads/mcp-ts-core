/**
 * @fileoverview Test suite for error handler mappings — pattern compilation, caching,
 * and error classification via ERROR_TYPE_MAPPINGS, COMPILED_ERROR_PATTERNS, COMPILED_PROVIDER_PATTERNS.
 * @module tests/utils/internal/error-handler/mappings.test
 */

import { describe, expect, it } from 'vitest';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import {
  CANVAS_CAPACITY_EXHAUSTED_REASON,
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
      // The caller went away — neither a server fault nor an upstream one, so
      // it must not land in the bucket dashboards read as "this server broke".
      [JsonRpcErrorCode.RequestCancelled, 'client'],
    ] as const)('classifies %s as %s', (code, category) => {
      expect(getErrorCategory(code)).toBe(category);
    });

    // Issue #275 — one numeric code carries two sources. `RateLimited` is
    // upstream throttling everywhere except the canvas tenant cap, which is a
    // local capacity decision and says so through `data.reason`.
    describe('local capacity under RateLimited (#275)', () => {
      it('files the canvas capacity reason as server', () => {
        expect(
          getErrorCategory(JsonRpcErrorCode.RateLimited, {
            reason: CANVAS_CAPACITY_EXHAUSTED_REASON,
          }),
        ).toBe('server');
      });

      it.each([
        ['no data at all', undefined],
        ['data carrying no reason', { tenantId: 'default' }],
        ['an unrelated reason', { reason: 'upstream_quota_exceeded' }],
        ['a non-string reason', { reason: 42 }],
      ])('leaves RateLimited upstream for %s', (_label, data) => {
        expect(getErrorCategory(JsonRpcErrorCode.RateLimited, data)).toBe('upstream');
      });

      it('does not move a different code that carries the same reason', () => {
        // The reason is scoped to the code it disambiguates; nothing else
        // should shift bucket because a throw happens to reuse the string.
        expect(
          getErrorCategory(JsonRpcErrorCode.NotFound, {
            reason: CANVAS_CAPACITY_EXHAUSTED_REASON,
          }),
        ).toBe('client');
      });
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
    it('maps exactly these constructor names, leaving TypeError to the message patterns', () => {
      expect(ERROR_TYPE_MAPPINGS).toEqual({
        SyntaxError: JsonRpcErrorCode.ValidationError,
        RangeError: JsonRpcErrorCode.ValidationError,
        URIError: JsonRpcErrorCode.ValidationError,
        ZodError: JsonRpcErrorCode.ValidationError,
        EvalError: JsonRpcErrorCode.InternalError,
        ReferenceError: JsonRpcErrorCode.InternalError,
        AggregateError: JsonRpcErrorCode.InternalError,
      });
    });
  });

  // ─── COMPILED_ERROR_PATTERNS ─────────────────────────────────────────────────

  describe('COMPILED_ERROR_PATTERNS', () => {
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

    it('should match "zoderror" as ValidationError', () => {
      const match = COMPILED_ERROR_PATTERNS.find((p) => p.compiledPattern.test('zoderror'));
      expect(match?.errorCode).toBe(JsonRpcErrorCode.ValidationError);
    });
  });

  // ─── COMPILED_PROVIDER_PATTERNS ──────────────────────────────────────────────

  describe('COMPILED_PROVIDER_PATTERNS', () => {
    // AWS patterns
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
