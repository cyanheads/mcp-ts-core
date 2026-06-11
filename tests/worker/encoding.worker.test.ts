/**
 * @fileoverview Worker-runtime tests for the encoding utilities.
 * Runs under `vitest.worker.ts` (Cloudflare workerd pool via @cloudflare/vitest-pool-workers).
 * The pool enables `nodejs_compat`, which populates a global `Buffer`, so the
 * utils take the Buffer fast-path in this suite. These tests therefore assert
 * two things separately: (1) workerd ships the native `Uint8Array.toBase64()`
 * / `Uint8Array.fromBase64()` primitives the no-Buffer branch relies on, and
 * (2) the native branch produces output identical to the utils' primary path.
 * @module tests/worker/encoding.worker.test
 */

import { describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToString,
  stringToBase64,
} from '../../src/utils/internal/encoding.js';

describe('encoding utils under workerd', () => {
  it('workerd ships the native Uint8Array base64 methods used by the no-Buffer branch', () => {
    expect(typeof Uint8Array.prototype.toBase64).toBe('function');
    expect(typeof Uint8Array.fromBase64).toBe('function');
  });

  it('native toBase64 output matches arrayBufferToBase64 for all byte values 0–255', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(bytes.toBase64()).toBe(arrayBufferToBase64(bytes.buffer as ArrayBuffer));
  });

  it('native fromBase64 inverts arrayBufferToBase64 losslessly', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const decoded = Uint8Array.fromBase64(arrayBufferToBase64(bytes.buffer as ArrayBuffer));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('arrayBufferToBase64 encodes a known vector', () => {
    const input = new TextEncoder().encode('hello workerd');
    expect(arrayBufferToBase64(input.buffer as ArrayBuffer)).toBe('aGVsbG8gd29ya2VyZA==');
  });

  it('stringToBase64 → base64ToString is a lossless round-trip (multibyte)', () => {
    const original = 'round-trip test 🚀 — multibyte OK';
    expect(base64ToString(stringToBase64(original))).toBe(original);
  });

  it('handles empty inputs', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
    expect(base64ToString('')).toBe('');
  });
});
