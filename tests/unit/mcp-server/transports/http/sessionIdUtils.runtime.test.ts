/**
 * @fileoverview Session ID generation draws from Web Crypto on every runtime.
 * @module tests/mcp-server/transports/http/sessionIdUtils.runtime.test
 */

import { describe, expect, it, vi } from 'vitest';

import {
  generateSecureSessionId,
  validateSessionIdFormat,
} from '@/mcp-server/transports/http/sessionIdUtils.js';

describe('generateSecureSessionId', () => {
  it('hex-encodes 32 bytes from crypto.getRandomValues', () => {
    const getRandomValues = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        for (let i = 0; i < bytes.length; i++) bytes[i] = i;
        return array;
      });

    try {
      const id = generateSecureSessionId();

      expect(getRandomValues).toHaveBeenCalledOnce();
      expect(id).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      expect(validateSessionIdFormat(id)).toBe(true);
    } finally {
      getRandomValues.mockRestore();
    }
  });
});
