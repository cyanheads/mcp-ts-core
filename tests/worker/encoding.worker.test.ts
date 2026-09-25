/**
 * @fileoverview Worker-runtime tests for the encoding utilities.
 * Runs under `tests/config/vitest.worker.ts` (Cloudflare workerd pool via @cloudflare/vitest-pool-workers).
 * The pool enables `nodejs_compat`, which populates a global `Buffer`, so the
 * utils would take the Buffer fast-path here. The suite forces
 * `runtimeCaps.hasBuffer = false` so the native `Uint8Array.toBase64()` /
 * `Uint8Array.fromBase64()` branch runs under workerd, and checks it against
 * `btoa` as an independent reference.
 * @module tests/worker/encoding.worker.test
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToString,
  stringToBase64,
} from '../../src/utils/internal/encoding.js';
import { runtimeCaps } from '../../src/utils/internal/runtime.js';

/** Base64 of raw bytes via `btoa` — a reference independent of the utils under test. */
function referenceBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('encoding utils under workerd (no-Buffer branch)', () => {
  const originalHasBuffer = runtimeCaps.hasBuffer;

  beforeAll(() => {
    runtimeCaps.hasBuffer = false;
  });

  afterAll(() => {
    runtimeCaps.hasBuffer = originalHasBuffer;
  });

  it('arrayBufferToBase64 matches the reference encoding for all byte values 0–255', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(arrayBufferToBase64(bytes.buffer as ArrayBuffer)).toBe(referenceBase64(bytes));
  });

  it('arrayBufferToBase64 encodes a known vector', () => {
    const input = new TextEncoder().encode('hello workerd');
    expect(arrayBufferToBase64(input.buffer as ArrayBuffer)).toBe('aGVsbG8gd29ya2VyZA==');
  });

  it('stringToBase64 encodes UTF-8 and base64ToString decodes it losslessly (multibyte)', () => {
    const original = 'round-trip test 🚀 — multibyte OK';
    const encoded = stringToBase64(original);
    expect(encoded).toBe(referenceBase64(new TextEncoder().encode(original)));
    expect(base64ToString(encoded)).toBe(original);
  });

  it('handles empty inputs', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
    expect(base64ToString('')).toBe('');
  });
});
