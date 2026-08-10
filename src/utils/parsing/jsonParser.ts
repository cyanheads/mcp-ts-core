/**
 * @fileoverview Provides a utility class for parsing potentially partial JSON strings.
 * It wraps the 'partial-json' npm library and includes functionality to handle
 * optional <think>...</think> blocks often found at the beginning of LLM outputs.
 * @module src/utils/parsing/jsonParser
 */
import { validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from '@/utils/internal/requestContext.js';
import { assertTextInputBudget, type ParserInputBudgetOptions } from './inputBudget.js';
import { thinkBlockRegex } from './thinkBlock.js';

const getPartialJson = lazyImport(
  () => import('partial-json'),
  'Install "partial-json" to use partial JSON parsing: bun add partial-json',
);

/**
 * Bit flags specifying which partial JSON types are permissible during parsing.
 * Mirrors `partial-json`'s `Allow` constants. Combine flags with bitwise OR
 * to allow multiple partial types simultaneously.
 *
 * @example
 * ```typescript
 * // Allow only partial strings and arrays
 * const result = await jsonParser.parse(str, Allow.STR | Allow.ARR);
 *
 * // Allow everything (default)
 * const result = await jsonParser.parse(str, Allow.ALL);
 * ```
 */
export const Allow = {
  /** Allow partial strings. */
  STR: 0x1,
  /** Allow partial numbers. */
  NUM: 0x2,
  /** Allow partial arrays. */
  ARR: 0x4,
  /** Allow partial objects. */
  OBJ: 0x8,
  /** Allow partial null values. */
  NULL: 0x10,
  /** Allow partial booleans. */
  BOOL: 0x20,
  /** Allow NaN values. */
  NAN: 0x40,
  /** Allow positive Infinity. */
  INFINITY: 0x80,
  /** Allow negative Infinity. */
  _INFINITY: 0x100,
  /** Allow both positive and negative Infinity (`INFINITY | _INFINITY`). */
  INF: 0x80 | 0x100,
  /** Allow all special values: NULL, BOOL, NAN, INFINITY, _INFINITY. */
  SPECIAL: 0x10 | 0x20 | 0x40 | 0x80 | 0x100,
  /** Allow all atomic types: STR, NUM, NULL, BOOL, NAN, INFINITY, _INFINITY. */
  ATOM: 0x1 | 0x2 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100,
  /** Allow partial collections: ARR and OBJ. */
  COLLECTION: 0x4 | 0x8,
  /** Allow all partial types. */
  ALL: 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100,
} as const;

/**
 * Utility class for parsing potentially partial JSON strings.
 * Wraps the `partial-json` library for robust JSON parsing, handling
 * incomplete structures and optional `<think>` blocks from LLM outputs.
 *
 * All parse methods are async due to lazy loading of the `partial-json` peer dependency.
 * Install it with: `bun add partial-json`
 */
export class JsonParser {
  /**
   * Parses a JSON string, which may be partial or prefixed with a `<think>` block.
   *
   * If a `<think>...</think>` block is present at the start of the string, its content
   * is logged at debug level and stripped before parsing. The remainder is then parsed
   * using `partial-json`, which tolerates incomplete JSON structures.
   *
   * This method is async due to lazy loading of the `partial-json` peer dependency
   * (`bun add partial-json`).
   *
   * @template T - The expected type of the parsed result. Defaults to `unknown`.
   * @param jsonString - The raw string to parse. May include a leading `<think>` block
   *   and/or be a partial (incomplete) JSON value.
   * @param allowPartial - Bitwise OR combination of `Allow` flags controlling which
   *   partial JSON types are accepted. Defaults to `Allow.ALL`.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @param budget - Optional UTF-8 byte budget for the input. Unbounded when omitted.
   * @returns The parsed JavaScript value cast to `T`.
   * @throws {McpError} With `ValidationError` if the string is empty after stripping the
   *   `<think>` block and trimming, or if `partial-json` fails to parse the content.
   * @throws {McpError} With `ConfigurationError` if the `partial-json` package is not installed.
   * @example
   * ```typescript
   * import { jsonParser, Allow } from '@/utils/parsing/jsonParser.js';
   *
   * // Parse complete JSON
   * const obj = await jsonParser.parse<{ key: string }>('{"key": "value"}');
   * console.log(obj.key); // "value"
   *
   * // Parse partial JSON with a <think> prefix
   * const partial = '<think>reasoning...</think>{"items": [1, 2,';
   * const result = await jsonParser.parse(partial, Allow.ALL);
   * console.log(result); // { items: [1, 2] }
   * ```
   */
  async parse<T = unknown>(
    jsonString: string,
    allowPartial: number = Allow.ALL,
    context?: RequestContextLike | RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<T> {
    assertTextInputBudget(jsonString, budget);

    let stringToParse = jsonString;
    const match = jsonString.match(thinkBlockRegex);

    if (match) {
      const thinkContent = match[1]?.trim() ?? '';
      const restOfString = match[2] ?? '';

      const logContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'JsonParser.thinkBlock',
        });
      if (thinkContent) {
        logger.debug('LLM <think> block detected and logged.', {
          ...logContext,
          thinkContent,
        });
      } else {
        logger.debug('Empty LLM <think> block detected.', logContext);
      }
      stringToParse = restOfString;
    }

    stringToParse = stringToParse.trim();

    if (!stringToParse) {
      throw validationError(
        'JSON string is empty after removing <think> block and trimming.',
        context,
      );
    }

    try {
      const { parse: parsePartialJson } = await getPartialJson();
      return parsePartialJson(stringToParse, allowPartial) as T;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      const errorLogContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'JsonParser.parseError',
        });
      logger.error('Failed to parse JSON content.', {
        ...errorLogContext,
        errorDetails: error.message,
        contentAttempted: stringToParse.substring(0, 200),
      });

      throw validationError(
        `Failed to parse JSON content: ${error.message}`,
        { reason: 'json_parse_failed' },
        { cause: error },
      );
    }
  }
}

/**
 * Singleton instance of `JsonParser`.
 *
 * Provides partial JSON parsing with `<think>` block stripping. Methods are async
 * due to lazy loading of the `partial-json` peer dependency (`bun add partial-json`).
 *
 * @example
 * ```typescript
 * import { jsonParser, Allow } from '@/utils/parsing/jsonParser.js';
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 *
 * const ctx = requestContextService.createRequestContext({ operation: 'myOp' });
 *
 * // Full JSON
 * const obj = await jsonParser.parse<{ key: string }>('{"key": "value"}', Allow.ALL, ctx);
 * console.log(obj.key); // "value"
 *
 * // Partial JSON with think block
 * const raw = '<think>reasoning...</think>{"key": "value", "arr": [1,';
 * const partial = await jsonParser.parse(raw, Allow.ALL, ctx);
 * console.log(partial); // { key: 'value', arr: [1] }
 * ```
 */
export const jsonParser = new JsonParser();
