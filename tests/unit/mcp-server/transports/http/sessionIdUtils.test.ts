/**
 * @fileoverview Tests for session ID generation and validation utilities.
 * @module tests/mcp-server/transports/http/sessionIdUtils.test
 */
import { describe, expect, it } from 'vitest';

import {
  generateSecureSessionId,
  validateSessionIdFormat,
} from '../../../../../src/mcp-server/transports/http/sessionIdUtils.js';

describe('generateSecureSessionId', () => {
  it('returns a 64-character hex string', () => {
    const id = generateSecureSessionId();
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSecureSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe('validateSessionIdFormat', () => {
  it('accepts a manually constructed valid ID', () => {
    const valid = 'a'.repeat(64);
    expect(validateSessionIdFormat(valid)).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(validateSessionIdFormat('')).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(validateSessionIdFormat('abc123')).toBe(false);
  });

  it('rejects a string that is too long', () => {
    expect(validateSessionIdFormat('a'.repeat(65))).toBe(false);
  });

  it('rejects uppercase hex characters', () => {
    const upper = 'A'.repeat(64);
    expect(validateSessionIdFormat(upper)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    const bad = 'g'.repeat(64);
    expect(validateSessionIdFormat(bad)).toBe(false);
  });

  it('rejects IDs with spaces', () => {
    const padded = ` ${'a'.repeat(62)} `;
    expect(validateSessionIdFormat(padded)).toBe(false);
  });
});
