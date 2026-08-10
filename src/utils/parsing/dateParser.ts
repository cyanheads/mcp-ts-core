/**
 * @fileoverview Provides utility functions for parsing natural language date strings
 * into Date objects or detailed parsing results using the `chrono-node` library.
 * @module src/utils/parsing/dateParser
 */
import type * as chrono from 'chrono-node';

import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext, RequestContextLike } from '@/utils/internal/requestContext.js';

const getChrono = lazyImport(
  () => import('chrono-node'),
  'Install "chrono-node" to use date parsing: bun add chrono-node',
);

/**
 * Parses a natural language date string into a JavaScript `Date` object.
 *
 * Uses `chrono-node`'s `parseDate` with `forwardDate: true` so ambiguous dates
 * (e.g. "next Friday") resolve to the nearest future occurrence. Returns `null`
 * if no date can be extracted from the text.
 *
 * Async due to lazy loading of the `chrono-node` peer dependency
 * (`bun add chrono-node`).
 *
 * @param text - The natural language date string to parse (e.g. `"next Friday at 3pm"`).
 * @param context - Context for correlated logging and error metadata. The handler
 *   `Context` is accepted directly.
 * @param refDate - Reference date for relative expressions. Defaults to the current date/time.
 * @returns A `Date` object if a date was found, or `null` if parsing yields no result.
 * @throws {McpError} With `ConfigurationError` if `chrono-node` is not installed.
 * @throws {McpError} With `ParseError` if an unexpected error occurs during parsing.
 */
export async function parseDateString(
  text: string,
  context: RequestContextLike | RequestContext,
  refDate?: Date,
): Promise<Date | null> {
  // Resolve dependency outside ErrorHandler.tryCatch — a missing peer dep is a
  // static configuration issue, not an operational error, and must not inflate
  // the mcp.errors.classified counter on every call.
  const chronoMod = await getChrono();

  const operation = 'parseDateString';
  const logContext = { ...context, operation, inputText: text, refDate };
  logger.debug(`Attempting to parse date string: "${text}"`, logContext);

  return await ErrorHandler.tryCatch(
    () => {
      const parsedDate = chronoMod.parseDate(text, refDate, { forwardDate: true });
      if (parsedDate) {
        logger.debug(`Successfully parsed "${text}" to ${parsedDate.toISOString()}`, logContext);
        return parsedDate;
      } else {
        logger.warning(`Failed to parse date string: "${text}"`, logContext);
        return null;
      }
    },
    {
      operation,
      context: logContext,
      input: { text, refDate },
      errorCode: JsonRpcErrorCode.ParseError,
    },
  );
}

/**
 * Parses a natural language date string and returns detailed `chrono-node` results.
 *
 * Unlike `parseDateString`, this function returns the full `ParsedResult[]` from
 * `chrono-node`, which includes each matched text span, its character index in the
 * input, and parsed date/time components (start, optional end). Useful for
 * multi-date strings or when the original matched text is needed.
 *
 * Uses `chrono-node`'s `parse` with `forwardDate: true`. Returns an empty array
 * if no dates are found.
 *
 * Async due to lazy loading of the `chrono-node` peer dependency
 * (`bun add chrono-node`).
 *
 * @param text - The natural language date string to parse.
 * @param context - Context for correlated logging and error metadata. The handler
 *   `Context` is accepted directly.
 * @param refDate - Reference date for relative expressions. Defaults to the current date/time.
 * @returns An array of `chrono.ParsedResult` objects — one per date expression found.
 *   Empty array if no dates are present in the text.
 * @throws {McpError} With `ConfigurationError` if `chrono-node` is not installed.
 * @throws {McpError} With `ParseError` if an unexpected error occurs during parsing.
 */
export async function parseDateStringDetailed(
  text: string,
  context: RequestContextLike | RequestContext,
  refDate?: Date,
): Promise<chrono.ParsedResult[]> {
  const chronoMod = await getChrono();

  const operation = 'parseDateStringDetailed';
  const logContext = { ...context, operation, inputText: text, refDate };
  logger.debug(`Attempting detailed parse of date string: "${text}"`, logContext);

  return await ErrorHandler.tryCatch(
    () => {
      const results = chronoMod.parse(text, refDate, { forwardDate: true });
      logger.debug(
        `Detailed parse of "${text}" resulted in ${results.length} result(s)`,
        logContext,
      );
      return results;
    },
    {
      operation,
      context: logContext,
      input: { text, refDate },
      errorCode: JsonRpcErrorCode.ParseError,
    },
  );
}

/**
 * Singleton object providing natural language date parsing via `chrono-node`.
 *
 * Both methods are async due to lazy loading of the `chrono-node` peer dependency
 * (`bun add chrono-node`). Use `parseDate` for a simple `Date | null` result and
 * `parse` when you need the full matched-text details.
 *
 * @example
 * ```typescript
 * import { dateParser } from '@/utils/parsing/dateParser.js';
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 *
 * const ctx = requestContextService.createRequestContext({ operation: 'myOp' });
 *
 * // Simple Date result
 * const date = await dateParser.parseDate('next Friday at 3pm', ctx);
 * if (date) console.log(date.toISOString());
 *
 * // Detailed results — useful for multi-date strings
 * const results = await dateParser.parse('Meeting on 2024-12-25 and another one tomorrow', ctx);
 * for (const r of results) {
 *   console.log(r.text, r.start.date());
 * }
 * ```
 */
export const dateParser = {
  /**
   * Parses a natural language date string and returns the full `chrono-node`
   * `ParsedResult[]`, including matched text spans and parsed components.
   *
   * Async due to lazy loading of `chrono-node` (`bun add chrono-node`).
   *
   * @param text - The natural language date string to parse.
   * @param context - Context for correlated logging and error metadata. The handler
   *   `Context` is accepted directly.
   * @param refDate - Reference date for relative expressions. Defaults to now.
   * @returns An array of `chrono.ParsedResult` objects; empty if no dates found.
   * @throws {McpError} With `ConfigurationError` if `chrono-node` is not installed.
   * @throws {McpError} With `ParseError` if an unexpected error occurs.
   */
  parse: parseDateStringDetailed,
  /**
   * Parses a natural language date string into a single JavaScript `Date` object.
   *
   * Async due to lazy loading of `chrono-node` (`bun add chrono-node`).
   *
   * @param text - The natural language date string to parse.
   * @param context - Context for correlated logging and error metadata. The handler
   *   `Context` is accepted directly.
   * @param refDate - Reference date for relative expressions. Defaults to now.
   * @returns A `Date` if a date expression was found, or `null` if none was recognized.
   * @throws {McpError} With `ConfigurationError` if `chrono-node` is not installed.
   * @throws {McpError} With `ParseError` if an unexpected error occurs.
   */
  parseDate: parseDateString,
};
