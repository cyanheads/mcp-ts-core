/**
 * @fileoverview Provides cross-platform encoding utilities.
 * @module src/utils/internal/encoding
 */
import { runtimeCaps } from './runtime.js';

/**
 * Encodes an ArrayBuffer into a base64 string in a cross-platform manner.
 * Prefers Node.js Buffer for performance if available, otherwise uses a
 * chunked `btoa` fallback to avoid stack overflow on large buffers.
 *
 * @param buffer - The ArrayBuffer to encode.
 * @returns The base64-encoded string.
 * @example
 * ```typescript
 * const buf = new TextEncoder().encode('hello').buffer;
 * arrayBufferToBase64(buf); // 'aGVsbG8='
 * ```
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (runtimeCaps.hasBuffer) {
    // Node.js/Bun environment — Buffer is fastest
    return Buffer.from(buffer).toString('base64');
  } else {
    // workerd/browser — Uint8Array.toBase64() is available on V8 25+ / workerd
    return new Uint8Array(buffer).toBase64();
  }
}

/**
 * Encodes a UTF-8 string to base64 in a cross-platform manner.
 * Prefers Node.js Buffer for performance if available, otherwise uses
 * TextEncoder + {@link arrayBufferToBase64} for Cloudflare Workers compatibility.
 *
 * @param str - The UTF-8 string to encode.
 * @returns The base64-encoded string.
 * @example
 * ```typescript
 * stringToBase64('hello'); // 'aGVsbG8='
 * ```
 */
export function stringToBase64(str: string): string {
  if (runtimeCaps.hasBuffer) {
    // Node.js environment - most performant
    return Buffer.from(str, 'utf-8').toString('base64');
  } else {
    // Worker/Browser environment - use Web APIs
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    return arrayBufferToBase64(bytes.buffer as ArrayBuffer);
  }
}

/**
 * Decodes a base64-encoded string to UTF-8 in a cross-platform manner.
 * Prefers Node.js Buffer for performance if available, otherwise uses
 * `atob` + TextDecoder for Cloudflare Workers compatibility.
 *
 * @param base64 - The base64-encoded string to decode.
 * @returns The decoded UTF-8 string.
 * @throws {Error} If the input is not valid base64 (thrown by `Buffer` or `atob`).
 * @example
 * ```typescript
 * base64ToString('aGVsbG8='); // 'hello'
 * ```
 */
export function base64ToString(base64: string): string {
  if (runtimeCaps.hasBuffer) {
    // Node.js/Bun environment — Buffer is fastest
    return Buffer.from(base64, 'base64').toString('utf-8');
  } else {
    // workerd/browser — Uint8Array.fromBase64() is available on V8 25+ / workerd
    return new TextDecoder().decode(Uint8Array.fromBase64(base64));
  }
}
