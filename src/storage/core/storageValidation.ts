/**
 * @fileoverview Input validation utilities for storage operations.
 *
 * This module provides centralized validation for all storage inputs to prevent:
 * - Path traversal attacks (via tenant ID, key, and prefix validation)
 * - Resource exhaustion (via length limits and pagination controls)
 * - Injection attacks (via character allowlists)
 * - Cross-tenant data access (via cursor validation with tenant binding)
 *
 * Security Model:
 * - Defense in depth: validation at service layer AND provider layer
 * - Fail closed: invalid input throws McpError, never coerced
 * - Audit trail: all validation failures logged with context
 * - Immutable: validation functions are pure (no side effects)
 *
 * All validation functions are synchronous and throw McpError on failure.
 * Callers should NOT catch validation errors - let them bubble to handlers.
 *
 * @module src/storage/core/storageValidation
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { invalidParams, McpError, validationError } from '@/types-global/errors.js';
import { base64ToString, stringToBase64 } from '@/utils/internal/encoding.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import type { ListOptions, StorageOptions } from './IStorageProvider.js';

/**
 * Per-process HMAC key for cursor integrity. Generated once at module load.
 * Does not need to survive restarts — cursors are ephemeral pagination tokens.
 */
const CURSOR_HMAC_KEY = randomBytes(32);

/**
 * Maximum length for tenant IDs and keys to prevent abuse.
 * These constants are security-critical and must not be modified at runtime.
 *
 * Rationale:
 * - MAX_TENANT_ID_LENGTH (128): Accommodates UUIDs, org slugs, and email-based IDs
 * - MAX_KEY_LENGTH (1024): Balances between deep hierarchies and URL limits
 * - MAX_PREFIX_LENGTH (512): Half of key length, enough for namespace prefixes
 * - MAX_LIST_LIMIT (10000): Prevents memory exhaustion while allowing bulk operations
 */
const MAX_TENANT_ID_LENGTH = 128 as const;
const MAX_KEY_LENGTH = 1024 as const;
const MAX_PREFIX_LENGTH = 512 as const;

/**
 * Maximum page size to prevent memory exhaustion attacks.
 */
const MAX_LIST_LIMIT = 10000 as const;

/**
 * Pattern for valid tenant IDs (alphanumeric, hyphens, underscores, dots).
 * More restrictive than key pattern - no slashes allowed to prevent path traversal.
 * Single character: must be alphanumeric.
 * Multiple characters: must start and end with alphanumeric, middle can include ._-
 * @readonly
 */
const VALID_TENANT_ID_PATTERN = /^[a-zA-Z0-9]$|^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/;

/**
 * Pattern for valid keys and prefixes (alphanumeric, hyphens, underscores, dots, slashes).
 * @readonly
 */
const VALID_KEY_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;

/**
 * Validates a tenant ID for storage operations.
 *
 * Security constraints:
 * - Must be non-empty string
 * - Maximum length: 128 characters
 * - Allowed characters: alphanumeric, hyphens, underscores, dots
 * - Cannot contain slashes or path traversal sequences
 * - Cannot start or end with special characters
 *
 * @param tenantId The tenant ID to validate.
 * @param context The request context for error reporting.
 * @throws {McpError} JsonRpcErrorCode.InvalidParams - If tenant ID is not a string, empty, too long, contains invalid characters, or has path traversal sequences.
 */
export function validateTenantId(tenantId: string, context: RequestContext): void {
  if (typeof tenantId !== 'string') {
    throw invalidParams('Tenant ID must be a string.', {
      ...context,
      tenantId,
    });
  }

  const trimmedTenantId = tenantId.trim();

  if (trimmedTenantId.length === 0) {
    throw invalidParams('Tenant ID cannot be an empty string.', {
      ...context,
      tenantId,
    });
  }

  if (trimmedTenantId.length > MAX_TENANT_ID_LENGTH) {
    throw invalidParams(`Tenant ID exceeds maximum length of ${MAX_TENANT_ID_LENGTH} characters.`, {
      ...context,
      tenantIdLength: trimmedTenantId.length,
    });
  }

  if (!VALID_TENANT_ID_PATTERN.test(trimmedTenantId)) {
    throw invalidParams(
      'Tenant ID contains invalid characters. Only alphanumeric characters, hyphens, underscores, and dots are allowed. Must start and end with alphanumeric characters.',
      { ...context, tenantId: trimmedTenantId },
    );
  }

  if (trimmedTenantId.includes('..')) {
    throw invalidParams('Tenant ID contains consecutive dots, which are not allowed.', {
      ...context,
      tenantId: trimmedTenantId,
    });
  }
}

/**
 * Validates a storage key.
 * @param key The key to validate.
 * @param context The request context for error reporting.
 * @throws {McpError} JsonRpcErrorCode.ValidationError - If key is not a non-empty string, too long, contains invalid characters, or has path traversal sequences.
 */
export function validateKey(key: string, context: RequestContext): void {
  if (!key || typeof key !== 'string') {
    throw validationError('Key must be a non-empty string.', {
      ...context,
      key,
    });
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw validationError(`Key exceeds maximum length of ${MAX_KEY_LENGTH} characters.`, {
      ...context,
      key: `${key.substring(0, 50)}...`,
    });
  }

  if (!VALID_KEY_PATTERN.test(key)) {
    throw validationError(
      'Key contains invalid characters. Only alphanumeric, hyphens, underscores, dots, and slashes are allowed.',
      { ...context, key },
    );
  }

  if (key.includes('..')) {
    throw validationError('Key must not contain ".." (path traversal attempt).', {
      ...context,
      key,
    });
  }
}

/**
 * Validates a prefix for list operations.
 *
 * Security constraints:
 * - Can be empty string (matches all keys within tenant)
 * - Maximum length: 512 characters
 * - No path traversal sequences allowed
 * - Only valid path characters allowed
 *
 * @param prefix The prefix to validate (empty string is valid).
 * @param context The request context for error reporting.
 * @throws {McpError} JsonRpcErrorCode.ValidationError - If prefix is not a string, too long, contains invalid characters, or has path traversal sequences.
 */
export function validatePrefix(prefix: string, context: RequestContext): void {
  if (typeof prefix !== 'string') {
    throw validationError('Prefix must be a string.', {
      ...context,
      operation: 'validatePrefix',
      prefix,
    });
  }

  // Empty prefix is valid (matches all keys)
  if (prefix === '') {
    return;
  }

  if (prefix.length > MAX_PREFIX_LENGTH) {
    throw validationError(`Prefix exceeds maximum length of ${MAX_PREFIX_LENGTH} characters.`, {
      ...context,
      operation: 'validatePrefix',
      prefix: `${prefix.substring(0, 50)}...`,
    });
  }

  // Only validate pattern if non-empty
  if (!VALID_KEY_PATTERN.test(prefix)) {
    throw validationError(
      'Prefix contains invalid characters. Only alphanumeric, hyphens, underscores, dots, and slashes are allowed.',
      {
        ...context,
        operation: 'validatePrefix',
        prefix: prefix.length > 50 ? `${prefix.substring(0, 50)}...` : prefix,
      },
    );
  }

  if (prefix.includes('..')) {
    throw validationError('Prefix must not contain ".." (path traversal attempt).', {
      ...context,
      operation: 'validatePrefix',
      prefix,
    });
  }
}

/**
 * Validates storage options.
 * @param options The storage options to validate.
 * @param context The request context for error reporting.
 * @throws {McpError} JsonRpcErrorCode.ValidationError - If TTL is not a number, negative, or not finite.
 */
export function validateStorageOptions(
  options: StorageOptions | undefined,
  context: RequestContext,
): void {
  if (!options) {
    return;
  }

  if (options.ttl !== undefined) {
    if (typeof options.ttl !== 'number') {
      throw validationError('TTL must be a number (seconds).', {
        ...context,
        ttl: options.ttl,
      });
    }

    if (options.ttl < 0) {
      throw validationError('TTL must be a non-negative number. Use 0 for immediate expiration.', {
        ...context,
        ttl: options.ttl,
      });
    }

    if (!Number.isFinite(options.ttl)) {
      throw validationError('TTL must be a finite number.', {
        ...context,
        ttl: options.ttl,
      });
    }
  }
}

/**
 * Validates list operation options.
 *
 * Security constraints:
 * - Limit must be positive integer between 1 and 10000
 * - Cursor must be valid base64 string if provided
 * - Prevents memory exhaustion via oversized page requests
 *
 * @param options The list options to validate.
 * @param context The request context for error reporting.
 * @throws {McpError} If the options are invalid.
 */
export function validateListOptions(
  options: ListOptions | undefined,
  context: RequestContext,
): void {
  if (!options) {
    return;
  }

  if (options.limit !== undefined) {
    if (typeof options.limit !== 'number') {
      throw validationError('List limit must be a number.', {
        ...context,
        operation: 'validateListOptions',
        limit: options.limit,
      });
    }

    if (!Number.isInteger(options.limit)) {
      throw validationError('List limit must be an integer.', {
        ...context,
        operation: 'validateListOptions',
        limit: options.limit,
      });
    }

    if (options.limit < 1) {
      throw validationError('List limit must be at least 1.', {
        ...context,
        operation: 'validateListOptions',
        limit: options.limit,
      });
    }

    if (options.limit > MAX_LIST_LIMIT) {
      throw validationError(`List limit exceeds maximum of ${MAX_LIST_LIMIT}.`, {
        ...context,
        operation: 'validateListOptions',
        limit: options.limit,
      });
    }
  }

  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string') {
      throw validationError('Cursor must be a string.', {
        ...context,
        operation: 'validateListOptions',
      });
    }

    if (options.cursor.trim() === '') {
      throw validationError('Cursor must not be an empty string.', {
        ...context,
        operation: 'validateListOptions',
      });
    }

    // Basic format validation: base64 chars plus '.' separator (payload.signature)
    // More thorough HMAC verification happens in decodeCursor
    if (!/^[A-Za-z0-9+/=.]+$/.test(options.cursor)) {
      throw validationError('Cursor contains invalid characters.', {
        ...context,
        operation: 'validateListOptions',
      });
    }
  }
}

/**
 * Cursor encoding/decoding utilities for pagination.
 * Cursors are opaque strings that should not be constructed or parsed by clients.
 *
 * Format: `<base64-payload>.<base64-hmac>` where:
 * - payload is JSON `{ k: lastKey, t: tenantId }`
 * - hmac is a truncated HMAC-SHA256 of the payload using a per-process random key
 *
 * The HMAC prevents cursor forgery for key enumeration within a tenant namespace.
 * The key is ephemeral (per-process) so cursors do not survive restarts, which is
 * fine — they are short-lived pagination tokens.
 */

const CURSOR_HMAC_ALGO = 'sha256';
const CURSOR_HMAC_BYTES = 16; // 128-bit truncated tag — sufficient for pagination tokens

/** Computes a truncated HMAC tag for the given payload string. */
function signCursor(payload: string): string {
  const mac = createHmac(CURSOR_HMAC_ALGO, CURSOR_HMAC_KEY)
    .update(payload)
    .digest()
    .subarray(0, CURSOR_HMAC_BYTES);
  return stringToBase64(mac.toString('binary'));
}

/** Verifies the HMAC tag for a cursor payload. Returns true if valid. */
function verifyCursorSignature(payload: string, signature: string): boolean {
  const expected = signCursor(payload);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

interface CursorData {
  /** The last key from the previous page */
  k: string;
  /** The tenant ID for validation */
  t: string;
}

/**
 * Encodes pagination cursor data into an opaque, HMAC-signed string.
 * @param lastKey The last key from the current page.
 * @param tenantId The tenant ID for validation.
 * @returns An opaque cursor string in the format `payload.signature`.
 */
export function encodeCursor(lastKey: string, tenantId: string): string {
  const data: CursorData = { k: lastKey, t: tenantId };
  const payload = stringToBase64(JSON.stringify(data));
  const signature = signCursor(payload);
  return `${payload}.${signature}`;
}

/**
 * Decodes and validates an opaque, HMAC-signed cursor string.
 * @param cursor The cursor string to decode.
 * @param tenantId The expected tenant ID for validation.
 * @param context The request context for error reporting.
 * @returns The last key from the cursor.
 * @throws {McpError} If the cursor is invalid, tampered with, or has a bad signature.
 */
export function decodeCursor(cursor: string, tenantId: string, context: RequestContext): string {
  try {
    const dotIndex = cursor.lastIndexOf('.');
    if (dotIndex === -1) {
      throw invalidParams('Invalid cursor format: missing signature.', {
        ...context,
        operation: 'decodeCursor',
      });
    }

    const payload = cursor.substring(0, dotIndex);
    const signature = cursor.substring(dotIndex + 1);

    if (!verifyCursorSignature(payload, signature)) {
      throw invalidParams(
        'Cursor signature verification failed. The cursor may be expired (e.g. server restart or isolate change) or tampered with.',
        {
          ...context,
          operation: 'decodeCursor',
        },
      );
    }

    const decoded = base64ToString(payload);
    const data = JSON.parse(decoded) as CursorData;

    if (!data || typeof data !== 'object' || !('k' in data) || !('t' in data)) {
      throw invalidParams('Invalid cursor format.', {
        ...context,
        operation: 'decodeCursor',
      });
    }

    if (data.t !== tenantId) {
      throw invalidParams('Cursor tenant ID mismatch. Cursor may have been tampered with.', {
        ...context,
        operation: 'decodeCursor',
      });
    }

    return data.k;
  } catch (error: unknown) {
    if (error instanceof McpError) {
      throw error;
    }
    // Stack stays in the server log; McpError.data is wire-visible.
    logger.warning('Failed to decode cursor', {
      ...context,
      operation: 'decodeCursor',
      error: error instanceof Error ? error.stack : String(error),
    });
    throw invalidParams('Failed to decode cursor. Cursor may be corrupted or invalid.', {
      ...context,
      operation: 'decodeCursor',
    });
  }
}
