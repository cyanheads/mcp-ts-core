/**
 * @fileoverview Provides a utility class for extracting and parsing YAML frontmatter from markdown.
 * Supports Obsidian-style and Jekyll-style frontmatter (YAML between --- delimiters).
 * Leverages the existing yamlParser for parsing extracted YAML content.
 * @module src/utils/parsing/frontmatterParser
 */
import { McpError, validationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from '@/utils/internal/requestContext.js';
import { assertTextInputBudget, type ParserInputBudgetOptions } from './inputBudget.js';
import { yamlParser } from './yamlParser.js';

/**
 * Regular expression to extract frontmatter from markdown.
 * Matches YAML content between --- delimiters at the start of the document.
 * - Group 1: YAML content between delimiters
 * - Group 2: Remaining markdown content
 * @private
 */
const frontmatterRegex = /^---\s*\n([\s\S]*?)^---\s*([\s\S]*)$/m;

/**
 * Result of parsing markdown with frontmatter.
 * @template T The expected type of the parsed frontmatter object.
 */
export interface FrontmatterResult<T = unknown> {
  /**
   * Remaining markdown content after frontmatter extraction.
   * If no frontmatter exists, contains the original markdown.
   */
  content: string;
  /**
   * Parsed frontmatter object. Empty object if no frontmatter found.
   */
  frontmatter: T;
  /**
   * Indicates whether frontmatter was found and extracted.
   */
  hasFrontmatter: boolean;
}

/**
 * Utility class for extracting and parsing YAML frontmatter from markdown documents.
 * Supports Obsidian-style and Jekyll-style frontmatter (YAML between `---` delimiters).
 * Delegates YAML parsing to {@link yamlParser}.
 */
export class FrontmatterParser {
  /**
   * Extracts and parses YAML frontmatter from a markdown string.
   *
   * Looks for a `---`-delimited block at the very start of the document. If
   * found, the YAML inside is parsed via {@link yamlParser} and the remaining
   * markdown is returned separately. An empty `---\n---` block is accepted and
   * returns `frontmatter: {}` with `hasFrontmatter: true`. If no frontmatter
   * block is present, the original string is returned unchanged.
   *
   * @template T - The expected shape of the parsed frontmatter object. Defaults to `unknown`.
   * @param markdown - The markdown string that may contain a frontmatter block.
   * @param context - Optional context for correlated logging. The handler `Context`
   *   is accepted directly.
   * @param budget - Optional UTF-8 byte budget for the input. Unbounded when omitted.
   * @returns A {@link FrontmatterResult} with `frontmatter`, `content`, and `hasFrontmatter`.
   * @throws {McpError} With code `ValidationError` if the YAML content is present but malformed.
   * @example
   * ```typescript
   * import { frontmatterParser } from './frontmatterParser.js';
   *
   * const md = `---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body`;
   * const result = await frontmatterParser.parse<{ title: string; tags: string[] }>(md);
   * // result.frontmatter → { title: 'Hello', tags: ['a', 'b'] }
   * // result.content     → '\n# Body'
   * // result.hasFrontmatter → true
   * ```
   */
  async parse<T = unknown>(
    markdown: string,
    context?: RequestContextLike | RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<FrontmatterResult<T>> {
    assertTextInputBudget(markdown, budget);

    const match = markdown.match(frontmatterRegex);

    if (!match) {
      // No frontmatter found - return original content
      const logContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'FrontmatterParser.noFrontmatter',
        });
      logger.debug('No frontmatter detected in markdown.', logContext);

      return {
        frontmatter: {} as T,
        content: markdown,
        hasFrontmatter: false,
      };
    }

    const yamlContent = match[1] ?? '';
    const markdownContent = match[2] ?? '';

    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'FrontmatterParser.parse',
      });

    logger.debug('Frontmatter detected, extracting and parsing.', {
      ...logContext,
      yamlLength: yamlContent.length,
      contentLength: markdownContent.length,
    });

    // Validate that we have YAML content
    const trimmedYaml = yamlContent.trim();
    if (!trimmedYaml) {
      logger.debug('Empty frontmatter block detected.', logContext);
      return {
        frontmatter: {} as T,
        content: markdownContent,
        hasFrontmatter: true,
      };
    }

    try {
      // Use existing yamlParser for parsing (handles <think> blocks too)
      const parsedFrontmatter = await yamlParser.parse<T>(yamlContent, context, budget);

      logger.debug('Frontmatter parsed successfully.', {
        ...logContext,
        frontmatterKeys:
          parsedFrontmatter &&
          typeof parsedFrontmatter === 'object' &&
          !Array.isArray(parsedFrontmatter)
            ? Object.keys(parsedFrontmatter)
            : [],
      });

      return {
        frontmatter: parsedFrontmatter,
        content: markdownContent,
        hasFrontmatter: true,
      };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      const errorLogContext =
        context ||
        requestContextService.createRequestContext({
          operation: 'FrontmatterParser.parseError',
        });

      logger.error('Failed to parse frontmatter YAML content.', {
        ...errorLogContext,
        errorDetails: error.message,
        yamlContentSample: yamlContent.substring(0, 200),
      });

      // Re-throw McpError from yamlParser or create new one
      if (error instanceof McpError) {
        throw error;
      }

      throw validationError(
        `Failed to parse frontmatter content: ${error.message}`,
        { reason: 'frontmatter_parse_failed' },
        { cause: error },
      );
    }
  }
}

/**
 * Singleton instance of {@link FrontmatterParser}.
 *
 * Use this shared instance to extract and parse YAML frontmatter from markdown
 * documents rather than constructing a new parser per call.
 *
 * @example
 * ```typescript
 * import { frontmatterParser } from './frontmatterParser.js';
 * import { requestContextService } from '@/utils/internal/requestContext.js';
 *
 * const context = requestContextService.createRequestContext({ operation: 'ParseObsidianNote' });
 *
 * // Markdown with frontmatter
 * const markdown = `---
 * title: My Note
 * tags: [productivity, notes]
 * date: 2025-01-15
 * ---
 *
 * # Note Content
 * This is the actual note.`;
 *
 * const result = await frontmatterParser.parse(markdown, context);
 * console.log(result.frontmatter);    // { title: 'My Note', tags: [...], date: '2025-01-15' }
 * console.log(result.content);        // '\n# Note Content\nThis is the actual note.'
 * console.log(result.hasFrontmatter); // true
 *
 * // Markdown without frontmatter
 * const plainMarkdown = '# Just Content';
 * const result2 = await frontmatterParser.parse(plainMarkdown, context);
 * console.log(result2.frontmatter);    // {}
 * console.log(result2.content);        // '# Just Content'
 * console.log(result2.hasFrontmatter); // false
 * ```
 */
export const frontmatterParser = new FrontmatterParser();
