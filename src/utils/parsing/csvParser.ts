/**
 * @fileoverview Provides a utility class for parsing CSV strings.
 * Wraps the `papaparse` peer dependency (lazy-loaded on first use) and strips
 * optional `<think>...</think>` blocks that LLMs sometimes prepend to structured
 * output before parsing. Handles CJS/ESM interop for the `papaparse` module.
 *
 * Peer dependency: `papaparse` — install with `bun add papaparse`.
 * @module src/utils/parsing/csvParser
 */
import type Papa from 'papaparse';

import { validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from '@/utils/internal/requestContext.js';
import { thinkBlockRegex } from './thinkBlock.js';

const importPapa = lazyImport(
  () => import('papaparse'),
  'Install "papaparse" to use CSV parsing: bun add papaparse',
);

let _papa: typeof Papa | undefined;
async function getPapa() {
  if (!_papa) {
    const mod = await importPapa();
    // Handle CJS/ESM interop — papaparse uses `export =`
    _papa = ('default' in mod ? (mod.default as typeof Papa) : mod) as typeof Papa;
  }
  return _papa;
}

/**
 * Utility class for parsing CSV strings.
 *
 * Lazily loads `papaparse` on first use (peer dependency — install with `bun add papaparse`).
 * Handles CJS/ESM interop for the `papaparse` module automatically. Handles optional
 * `<think>...</think>` blocks that some LLMs prepend to structured output; the block's
 * content is logged at debug level and stripped before parsing.
 */
export class CsvParser {
  /**
   * Parses a CSV string into a `Papa.ParseResult`.
   *
   * This method is async because `papaparse` is loaded lazily on first call.
   * If the input begins with a `<think>...</think>` block, that block is stripped
   * and its content logged before parsing the remainder. Parse options (delimiter,
   * headers, etc.) are forwarded directly to `Papa.parse()`.
   *
   * If `papaparse` reports any parse errors in `result.errors`, an `McpError` is thrown
   * with all error messages joined and the raw `errors` array attached as context.
   *
   * @template T - The type of each parsed row. Defaults to `unknown`.
   * @param csvString - The CSV string to parse. May be prefixed with a `<think>` block.
   * @param options - Optional `Papa.ParseConfig` forwarded directly to `Papa.parse()`.
   *   Common options: `header` (boolean), `delimiter` (string), `dynamicTyping` (boolean).
   * @param context - Optional request context for correlated logging and error metadata.
   * @returns A promise resolving to `Papa.ParseResult<T>` containing `data`, `errors`, and `meta`.
   * @throws {McpError} With code `ConfigurationError` if `papaparse` is not installed.
   * @throws {McpError} With code `ValidationError` if the string is empty after stripping
   *   the `<think>` block, or if `papaparse` reports parse errors.
   * @example
   * ```typescript
   * import { csvParser } from '@/utils/parsing/csvParser.js';
   *
   * // Parse with header row — rows typed as objects
   * const result = await csvParser.parse<{ name: string; age: string }>(
   *   'name,age\nAlice,30\nBob,25',
   *   { header: true },
   * );
   * console.log(result.data[0].name); // 'Alice'
   *
   * // LLM output with a <think> preamble
   * const fromLlm = await csvParser.parse('<think>reasoning</think>\na,b\n1,2', { header: true });
   * console.log(fromLlm.data[0]); // { a: '1', b: '2' }
   * ```
   */
  async parse<T = unknown>(
    csvString: string,
    options?: Papa.ParseConfig,
    context?: RequestContextLike | RequestContext,
  ): Promise<Papa.ParseResult<T>> {
    let stringToParse = csvString;
    const match = csvString.match(thinkBlockRegex);

    if (match) {
      const thinkContent = match[1]?.trim() ?? '';
      const restOfString = match[2] ?? '';

      const logContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'CsvParser.thinkBlock',
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
        'CSV string is empty after removing <think> block and trimming.',
        context,
      );
    }

    const papa = await getPapa();
    const result = papa.parse<T>(stringToParse, options);

    if (result.errors.length > 0) {
      const errorLogContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'CsvParser.parseError',
        });
      logger.error('Failed to parse CSV content.', {
        ...errorLogContext,
        errors: result.errors,
        contentAttempted: stringToParse.substring(0, 200),
      });

      throw validationError(
        `Failed to parse CSV: ${result.errors.map((e) => e.message).join(', ')}`,
        {
          ...context,
          errors: result.errors,
          originalContentSample:
            stringToParse.substring(0, 200) + (stringToParse.length > 200 ? '...' : ''),
        },
      );
    }

    return result;
  }
}

/**
 * Singleton instance of {@link CsvParser}.
 *
 * Prefer this over constructing a new `CsvParser` directly. Lazily loads `papaparse`
 * on first call, so there is no startup cost if CSV parsing is never used.
 *
 * @example
 * ```typescript
 * import { csvParser } from '@/utils/parsing/csvParser.js';
 *
 * // Parse with header row
 * const result = await csvParser.parse<{ a: string; b: string }>('a,b\n1,2', { header: true });
 * console.log(result.data[0]); // { a: '1', b: '2' }
 *
 * // With request context for correlated logging
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 * const ctx = requestContextService.createRequestContext({ operation: 'importData' });
 * const imported = await csvParser.parse(rawCsv, { header: true, dynamicTyping: true }, ctx);
 *
 * // Strips LLM <think> preamble automatically
 * const fromLlm = await csvParser.parse('<think>let me think</think>\na,b\n1,2', { header: true });
 * console.log(fromLlm.data[0]); // { a: '1', b: '2' }
 * ```
 */
export const csvParser = new CsvParser();
