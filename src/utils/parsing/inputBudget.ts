/**
 * @fileoverview Input byte budgets shared by the parsing utilities. Bounds the
 * work a single parse can schedule, so a hostile document cannot amplify a
 * modest request into unbounded CPU or memory in the parser dependency.
 * @module src/utils/parsing/inputBudget
 */

import { validationError } from '@/types-global/errors.js';

/** Default UTF-8 input budget for text parsers (1 MiB). */
export const DEFAULT_TEXT_PARSER_MAX_BYTES = 1024 * 1024;

/** Default input budget for binary parsers (25 MiB). */
export const DEFAULT_BINARY_PARSER_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Caller override for a parser's input budget. The defaults are a safe starting
 * point rather than a security boundary — the input is already resident in
 * memory by the time a parser sees it — so a caller that knowingly handles
 * larger documents may raise as well as lower the limit.
 */
export interface ParserInputBudgetOptions {
  maxBytes?: number;
}

function resolveLimit(options: ParserInputBudgetOptions | undefined, defaultLimit: number): number {
  const requested = options?.maxBytes;
  if (requested === undefined) return defaultLimit;

  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw validationError('Parser input byte limit must be a positive safe integer.', {
      reason: 'parser_input_limit_invalid',
      limitBytes: defaultLimit,
    });
  }

  return requested;
}

/** Return the UTF-8 byte length without allocating a second copy of the input. */
export function utf8ByteLength(input: string): number {
  let bytes = 0;

  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < input.length &&
      input.charCodeAt(index + 1) >= 0xdc00 &&
      input.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      // BMP characters and unpaired surrogates both encode as three bytes.
      bytes += 3;
    }
  }

  return bytes;
}

function assertWithinLimit(sizeBytes: number, limitBytes: number): number {
  if (sizeBytes > limitBytes) {
    throw validationError('Parser input exceeds the maximum allowed byte size.', {
      reason: 'parser_input_too_large',
      sizeBytes,
      limitBytes,
    });
  }

  return sizeBytes;
}

/** Assert a text input fits its budget. Returns the input's UTF-8 byte length. */
export function assertTextInputBudget(input: string, options?: ParserInputBudgetOptions): number {
  const limitBytes = resolveLimit(options, DEFAULT_TEXT_PARSER_MAX_BYTES);
  return assertWithinLimit(utf8ByteLength(input), limitBytes);
}

/** Assert a binary input fits its budget. Returns the input's byte length. */
export function assertBinaryInputBudget(
  input: Uint8Array | ArrayBuffer,
  options?: ParserInputBudgetOptions,
): number {
  const limitBytes = resolveLimit(options, DEFAULT_BINARY_PARSER_MAX_BYTES);
  return assertWithinLimit(input.byteLength, limitBytes);
}

/** Assert a set of binary inputs fits one shared budget. Returns their combined byte length. */
export function assertBinaryInputsBudget(
  inputs: readonly (Uint8Array | ArrayBuffer)[],
  options?: ParserInputBudgetOptions,
): number {
  const limitBytes = resolveLimit(options, DEFAULT_BINARY_PARSER_MAX_BYTES);
  const sizeBytes = inputs.reduce((total, input) => total + input.byteLength, 0);
  return assertWithinLimit(sizeBytes, limitBytes);
}
