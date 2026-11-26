/**
 * @fileoverview Custom Vitest matchers for MCP-specific assertions.
 * Registered globally via `tests/setup.ts` so every test file has them
 * available without an import.
 * @module tests/helpers/matchers
 */
import { expect } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

/** Format a matcher hint line using the standard `expect()`/`.not.` convention. */
function hint(context: { isNot: boolean }, name: string, arg = ''): string {
  return `expect(received).${context.isNot ? 'not.' : ''}${name}(${arg})`;
}

/** Lookup a `JsonRpcErrorCode` name from its numeric value for readable messages. */
function codeName(code: JsonRpcErrorCode | undefined): string {
  if (code === undefined) return 'undefined';
  const name = (JsonRpcErrorCode as unknown as Record<number, string>)[code];
  return name ? `${name}(${code})` : String(code);
}

expect.extend({
  /**
   * Asserts the received value is an instance of `McpError`.
   * Optionally asserts the `code` field matches a specific {@link JsonRpcErrorCode}.
   *
   * @example
   *   expect(err).toBeMcpError();
   *   expect(err).toBeMcpError(JsonRpcErrorCode.NotFound);
   */
  toBeMcpError(received: unknown, expectedCode?: JsonRpcErrorCode) {
    const isMcp = received instanceof McpError;
    if (!isMcp) {
      return {
        pass: false,
        message: () =>
          `${hint(this, 'toBeMcpError')}\n\nExpected value to be an McpError, received: ${
            received === null ? 'null' : typeof received
          } (${this.utils.stringify(received)})`,
      };
    }
    if (expectedCode !== undefined && received.code !== expectedCode) {
      return {
        pass: false,
        actual: codeName(received.code),
        expected: codeName(expectedCode),
        message: () =>
          `${hint(this, 'toBeMcpError', codeName(expectedCode))}\n\n` +
          `Expected code: ${codeName(expectedCode)}\nReceived code: ${codeName(received.code)}\n` +
          `Message: ${received.message}`,
      };
    }
    return {
      pass: true,
      message: () =>
        `${hint(this, 'toBeMcpError', expectedCode !== undefined ? codeName(expectedCode) : '')}\n\n` +
        `Received McpError with code ${codeName(received.code)}: ${received.message}`,
    };
  },

  /**
   * Asserts a thrown or returned error exposes the given JSON-RPC error code.
   * Works with `McpError` and any plain object shaped `{ code: number }`.
   */
  toHaveJsonRpcCode(received: unknown, expectedCode: JsonRpcErrorCode) {
    const actualCode = (received as { code?: unknown } | null | undefined)?.code;
    const pass = actualCode === expectedCode;
    return {
      pass,
      actual: codeName(actualCode as JsonRpcErrorCode | undefined),
      expected: codeName(expectedCode),
      message: () =>
        `${hint(this, 'toHaveJsonRpcCode', codeName(expectedCode))}\n\n` +
        `Expected code: ${codeName(expectedCode)}\nReceived code: ${codeName(
          actualCode as JsonRpcErrorCode | undefined,
        )}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Type augmentation for the custom matchers. Vitest derives both `expect()`
// assertions and the asymmetric `expect.*` forms from `Matchers<R, T>`, where
// `R` is `void` for a synchronous assertion and `Promise<void>` through
// `.resolves` / `.rejects`.
// ---------------------------------------------------------------------------
declare module 'vitest' {
  interface Matchers<R, T> {
    toBeMcpError(code?: JsonRpcErrorCode): R;
    toHaveJsonRpcCode(code: JsonRpcErrorCode): R;
  }
}
