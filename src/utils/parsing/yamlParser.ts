/**
 * @fileoverview Provides a utility class for parsing YAML strings.
 * Wraps the `js-yaml` peer dependency (lazy-loaded on first use) and strips
 * optional `<think>...</think>` blocks that LLMs sometimes prepend to structured
 * output before parsing.
 *
 * Peer dependency: `js-yaml` — install with `bun add js-yaml`.
 * @module src/utils/parsing/yamlParser
 */
import { validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import { type RequestContext, requestContextService } from '@/utils/internal/requestContext.js';
import { thinkBlockRegex } from './thinkBlock.js';

const getYaml = lazyImport(
  () => import('js-yaml'),
  'Install "js-yaml" to use YAML parsing: bun add js-yaml',
);

/**
 * Utility class for parsing YAML strings.
 *
 * Lazily loads `js-yaml` on first use (peer dependency — install with `bun add js-yaml`).
 * Handles optional `<think>...</think>` blocks that some LLMs prepend to structured output;
 * the block's content is logged at debug level and stripped before parsing.
 */
export class YamlParser {
  /**
   * Parses a YAML string into a typed JavaScript object.
   *
   * This method is async because `js-yaml` is loaded lazily on first call.
   * If the input begins with a `<think>...</think>` block, that block is stripped
   * and its content logged before parsing the remainder. Uses `js-yaml`'s
   * `YAML11_SCHEMA` (YAML 1.1 load semantics) for parsing.
   *
   * @template T - The expected type of the parsed result. Defaults to `unknown`.
   * @param yamlString - The YAML string to parse. May be prefixed with a `<think>` block.
   * @param context - Optional request context for correlated logging and error metadata.
   * @returns A promise resolving to the parsed object cast to `T`.
   * @throws {McpError} With code `ConfigurationError` if `js-yaml` is not installed.
   * @throws {McpError} With code `ValidationError` if the string is empty after stripping
   *   the `<think>` block, or if `js-yaml` fails to parse the content.
   * @example
   * ```typescript
   * import { yamlParser } from '@/utils/parsing/yamlParser.js';
   *
   * const result = await yamlParser.parse<{ key: string }>('key: value');
   * console.log(result.key); // 'value'
   *
   * // LLM output with a <think> preamble
   * const fromLlm = await yamlParser.parse('<think>reasoning</think>\nkey: value');
   * console.log(fromLlm); // { key: 'value' }
   * ```
   */
  async parse<T = unknown>(yamlString: string, context?: RequestContext): Promise<T> {
    let stringToParse = yamlString;
    const match = yamlString.match(thinkBlockRegex);

    if (match) {
      const thinkContent = match[1]?.trim() ?? '';
      const restOfString = match[2] ?? '';

      const logContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'YamlParser.thinkBlock',
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
        'YAML string is empty after removing <think> block and trimming.',
        context,
      );
    }

    try {
      const yaml = await getYaml();
      // js-yaml v5 removed DEFAULT_SCHEMA and defaults load() to the stricter 1.2
      // CORE_SCHEMA; YAML11_SCHEMA preserves the prior 1.1 load semantics
      // (yes/no/on/off → boolean, !!timestamp → Date) that LLM YAML output relies on.
      return yaml.load(stringToParse, { schema: yaml.YAML11_SCHEMA }) as T;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      const errorLogContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'YamlParser.parseError',
        });
      logger.error('Failed to parse YAML content.', {
        ...errorLogContext,
        errorDetails: error.message,
        contentAttempted: stringToParse.substring(0, 200),
      });

      throw validationError(`Failed to parse YAML: ${error.message}`, {
        ...context,
        originalContentSample:
          stringToParse.substring(0, 200) + (stringToParse.length > 200 ? '...' : ''),
        rawError: error instanceof Error ? error.stack : String(error),
      });
    }
  }
}

/**
 * Singleton instance of {@link YamlParser}.
 *
 * Prefer this over constructing a new `YamlParser` directly. Lazily loads `js-yaml`
 * on first call, so there is no startup cost if YAML parsing is never used.
 *
 * @example
 * ```typescript
 * import { yamlParser } from '@/utils/parsing/yamlParser.js';
 *
 * // Basic parse
 * const result = await yamlParser.parse<{ name: string }>('name: Claude');
 * console.log(result.name); // 'Claude'
 *
 * // With request context for correlated logging
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 * const ctx = requestContextService.createRequestContext({ operation: 'parseConfig' });
 * const config = await yamlParser.parse<AppConfig>(rawYaml, ctx);
 *
 * // Strips LLM <think> preamble automatically
 * const fromLlm = await yamlParser.parse('<think>let me think</think>\nkey: value');
 * console.log(fromLlm); // { key: 'value' }
 * ```
 */
export const yamlParser = new YamlParser();
