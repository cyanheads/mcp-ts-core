/**
 * @fileoverview Provides a utility class for parsing XML strings.
 * Wraps the `fast-xml-parser` peer dependency (lazy-loaded on first use) and strips
 * optional `<think>...</think>` blocks that LLMs sometimes prepend to structured
 * output before parsing. The underlying `XMLParser` instance is created once with
 * `processEntities: false` and `htmlEntities: false` and reused for all calls.
 *
 * Peer dependency: `fast-xml-parser` — install with `bun add fast-xml-parser`.
 * @module src/utils/parsing/xmlParser
 */
import { configurationError, validationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { assertTextInputBudget, type ParserInputBudgetOptions } from './inputBudget.js';
import { thinkBlockRegex } from './thinkBlock.js';

interface FxpModule {
  XMLParser: new (opts?: Record<string, unknown>) => { parse(data: string): unknown };
}

let _fxp: FxpModule | undefined;
let _xmlParserInstance: { parse(data: string): unknown } | undefined;

const FXP_MODULE = 'fast-xml-parser';

async function getFxp(): Promise<FxpModule> {
  if (_fxp) return _fxp;
  _fxp = await (import(FXP_MODULE) as Promise<FxpModule>).catch(() => {
    throw configurationError(
      'Install "fast-xml-parser" to use XML parsing: bun add fast-xml-parser',
    );
  });
  return _fxp;
}

/**
 * Utility class for parsing XML strings.
 *
 * Lazily loads `fast-xml-parser` on first use (peer dependency — install with
 * `bun add fast-xml-parser`). The `XMLParser` instance is constructed once at first
 * call with `{ processEntities: false, htmlEntities: false }` and cached for subsequent
 * calls. Handles optional `<think>...</think>` blocks that some LLMs prepend to
 * structured output; the block's content is logged at debug level and stripped before
 * parsing.
 */
export class XmlParser {
  /**
   * Parses an XML string into a typed JavaScript object.
   *
   * This method is async because `fast-xml-parser` is loaded lazily on first call.
   * If the input begins with a `<think>...</think>` block, that block is stripped
   * and its content logged before parsing the remainder. The parser is configured with
   * `processEntities: false` and `htmlEntities: false` — entity references are passed
   * through as-is.
   *
   * @template T - The expected type of the parsed result. Defaults to `unknown`.
   * @param xmlString - The XML string to parse. May be prefixed with a `<think>` block.
   * @param context - Optional request context for correlated logging and error metadata.
   * @param budget - Optional UTF-8 byte budget for the input. Unbounded when omitted.
   * @returns A promise resolving to the parsed object cast to `T`.
   * @throws {McpError} With code `ConfigurationError` if `fast-xml-parser` is not installed.
   * @throws {McpError} With code `ValidationError` if the string is empty after stripping
   *   the `<think>` block, or if `fast-xml-parser` throws during parsing.
   * @example
   * ```typescript
   * import { xmlParser } from '@/utils/parsing/xmlParser.js';
   *
   * const result = await xmlParser.parse<{ root: { key: string } }>('<root><key>value</key></root>');
   * console.log(result.root.key); // 'value'
   *
   * // LLM output with a <think> preamble
   * const fromLlm = await xmlParser.parse('<think>reasoning</think>\n<root><key>value</key></root>');
   * console.log(fromLlm); // { root: { key: 'value' } }
   * ```
   */
  async parse<T = unknown>(
    xmlString: string,
    context?: RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<T> {
    assertTextInputBudget(xmlString, budget);

    let stringToParse = xmlString;
    const match = xmlString.match(thinkBlockRegex);

    if (match) {
      const thinkContent = match[1]?.trim() ?? '';
      const restOfString = match[2] ?? '';

      const logContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'XmlParser.thinkBlock',
        });
      if (thinkContent) {
        logger.debug(
          'LLM <think> block detected and logged.',
          withExtra(logContext, { thinkContent }),
        );
      } else {
        logger.debug('Empty LLM <think> block detected.', logContext);
      }
      stringToParse = restOfString;
    }

    stringToParse = stringToParse.trim();

    if (!stringToParse) {
      throw validationError(
        'XML string is empty after removing <think> block and trimming.',
        context,
      );
    }

    try {
      const fxp = await getFxp();
      _xmlParserInstance ??= new fxp.XMLParser({
        processEntities: false,
        htmlEntities: false,
      });
      return _xmlParserInstance.parse(stringToParse) as T;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      const errorLogContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'XmlParser.parseError',
        });
      logger.error(
        'Failed to parse XML content.',
        withExtra(errorLogContext, {
          errorDetails: error.message,
          contentAttempted: stringToParse.substring(0, 200),
        }),
      );

      throw validationError(
        `Failed to parse XML content: ${error.message}`,
        { reason: 'xml_parse_failed' },
        { cause: error },
      );
    }
  }
}

/**
 * Singleton instance of {@link XmlParser}.
 *
 * Prefer this over constructing a new `XmlParser` directly. Lazily loads `fast-xml-parser`
 * on first call and caches the `XMLParser` instance, so there is no startup cost if XML
 * parsing is never used.
 *
 * @example
 * ```typescript
 * import { xmlParser } from '@/utils/parsing/xmlParser.js';
 *
 * // Basic parse
 * const result = await xmlParser.parse<{ root: { id: string } }>('<root><id>42</id></root>');
 * console.log(result.root.id); // '42'
 *
 * // With request context for correlated logging
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 * const ctx = requestContextService.createRequestContext({ operation: 'parseResponse' });
 * const data = await xmlParser.parse<ApiResponse>(rawXml, ctx);
 *
 * // Strips LLM <think> preamble automatically
 * const fromLlm = await xmlParser.parse('<think>let me think</think>\n<root><key>value</key></root>');
 * console.log(fromLlm); // { root: { key: 'value' } }
 * ```
 */
export const xmlParser = new XmlParser();
