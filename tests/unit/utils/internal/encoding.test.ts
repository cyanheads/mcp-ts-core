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

  it('uses Uint8Array.toBase64() when Buffer is unavailable', () => {
    runtimeCaps.hasBuffer = false;

    const bytes = new Uint8Array([0, 1, 2, 3]);
    const result = arrayBufferToBase64(bytes.buffer);

    expect(result).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('handles an empty ArrayBuffer', () => {
    runtimeCaps.hasBuffer = true;
    const result = arrayBufferToBase64(new ArrayBuffer(0));
    expect(result).toBe('');
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

  it('falls back to TextEncoder + btoa when Buffer is unavailable', () => {
    runtimeCaps.hasBuffer = false;
    const result = stringToBase64('hello world');
    expect(result).toBe(Buffer.from('hello world', 'utf-8').toString('base64'));
  });

  it('handles an empty string', () => {
    runtimeCaps.hasBuffer = true;
    expect(stringToBase64('')).toBe('');
  });

  it('encodes multi-byte UTF-8 characters', () => {
    runtimeCaps.hasBuffer = true;
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

  it('uses Uint8Array.fromBase64() + TextDecoder when Buffer is unavailable', () => {
    runtimeCaps.hasBuffer = false;
    const encoded = Buffer.from('hello world', 'utf-8').toString('base64');
    expect(base64ToString(encoded)).toBe('hello world');
  });

  it('handles an empty base64 string', () => {
    runtimeCaps.hasBuffer = true;
    expect(base64ToString('')).toBe('');
  });

  it('round-trips with stringToBase64', () => {
    runtimeCaps.hasBuffer = true;
    const original = 'round-trip test 123!@#';
    expect(base64ToString(stringToBase64(original))).toBe(original);
  });
});
