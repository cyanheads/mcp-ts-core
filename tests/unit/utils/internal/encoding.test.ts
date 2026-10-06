/**
 * @fileoverview Tests for the cross-platform encoding helper.
 * @module tests/utils/internal/encoding.test
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  arrayBufferToBase64,
  base64ToString,
  stringToBase64,
} from '../../../../src/utils/internal/encoding.js';
import { runtimeCaps } from '../../../../src/utils/internal/runtime.js';

/**
 * The no-Buffer branch calls the native `Uint8Array` base64 methods, which Bun
 * and workerd ship and Node 24 does not. On Node that branch never runs in
 * production — `Buffer` is always present — so its cases run only where the
 * runtime can execute it; `tests/worker/encoding.worker.test.ts` covers workerd.
 */
const HAS_NATIVE_TO_BASE64 = typeof Uint8Array.prototype.toBase64 === 'function';
const HAS_NATIVE_FROM_BASE64 = typeof Uint8Array.fromBase64 === 'function';

describe('arrayBufferToBase64', () => {
  const originalHasBuffer = runtimeCaps.hasBuffer;

  afterEach(() => {
    runtimeCaps.hasBuffer = originalHasBuffer;
  });

  it('encodes using Buffer when available', () => {
    runtimeCaps.hasBuffer = true;
    const encoder = new TextEncoder();
    const buffer = encoder.encode('hello world');

    const result = arrayBufferToBase64(buffer.buffer as ArrayBuffer);

    expect(result).toBe(Buffer.from('hello world').toString('base64'));
  });

  it.skipIf(!HAS_NATIVE_TO_BASE64)('uses Uint8Array.toBase64() when Buffer is unavailable', () => {
    runtimeCaps.hasBuffer = false;

    const bytes = new Uint8Array([0, 1, 2, 3]);
    const result = arrayBufferToBase64(bytes.buffer);

    expect(result).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('stringToBase64', () => {
  const originalHasBuffer = runtimeCaps.hasBuffer;

  afterEach(() => {
    runtimeCaps.hasBuffer = originalHasBuffer;
  });

  it('encodes a string using Buffer when available', () => {
    runtimeCaps.hasBuffer = true;
    const result = stringToBase64('hello world');
    expect(result).toBe(Buffer.from('hello world', 'utf-8').toString('base64'));
  });

  it.skipIf(!HAS_NATIVE_TO_BASE64)(
    'falls back to TextEncoder + Uint8Array.toBase64() when Buffer is unavailable',
    () => {
      runtimeCaps.hasBuffer = false;
      const result = stringToBase64('hello world');
      expect(result).toBe(Buffer.from('hello world', 'utf-8').toString('base64'));
    },
  );

  it.skipIf(!HAS_NATIVE_TO_BASE64)('encodes multi-byte UTF-8 characters without Buffer', () => {
    runtimeCaps.hasBuffer = false;
    const emoji = '🚀';
    const result = stringToBase64(emoji);
    expect(result).toBe(Buffer.from(emoji, 'utf-8').toString('base64'));
  });
});

describe('base64ToString', () => {
  const originalHasBuffer = runtimeCaps.hasBuffer;

  afterEach(() => {
    runtimeCaps.hasBuffer = originalHasBuffer;
  });

  it('decodes using Buffer when available', () => {
    runtimeCaps.hasBuffer = true;
    const encoded = Buffer.from('hello world', 'utf-8').toString('base64');
    expect(base64ToString(encoded)).toBe('hello world');
  });

  it.skipIf(!HAS_NATIVE_FROM_BASE64)(
    'uses Uint8Array.fromBase64() + TextDecoder when Buffer is unavailable',
    () => {
      runtimeCaps.hasBuffer = false;
      const encoded = Buffer.from('hello world', 'utf-8').toString('base64');
      expect(base64ToString(encoded)).toBe('hello world');
    },
  );
});
