/**
 * @fileoverview The one sensitive-field list behind log redaction and log sanitization.
 * @module tests/unit/utils/security/sensitiveFields.test
 */

import { describe, expect, it } from 'vitest';

import { sanitization } from '@/utils/security/sanitization.js';
import { DEFAULT_SENSITIVE_FIELDS, toPinoRedactPaths } from '@/utils/security/sensitiveFields.js';

describe('sensitiveFields', () => {
  it('expands each field to top-level, one-deep, and two-deep pino paths', () => {
    expect(toPinoRedactPaths(['token', 'apiKey'])).toEqual([
      'token',
      '*.token',
      '*.*.token',
      'apiKey',
      '*.apiKey',
      '*.*.apiKey',
    ]);
  });

  it('seeds Sanitization with the shared default list', () => {
    expect(sanitization.getSensitiveFields()).toEqual([...DEFAULT_SENSITIVE_FIELDS]);
    expect(sanitization.getSensitivePinoFields()).toEqual(
      toPinoRedactPaths(DEFAULT_SENSITIVE_FIELDS),
    );
  });

  it('covers the credential-bearing names redaction depends on', () => {
    for (const field of ['password', 'token', 'secret', 'apiKey', 'authorization', 'cookie']) {
      expect(DEFAULT_SENSITIVE_FIELDS).toContain(field);
    }
  });
});
