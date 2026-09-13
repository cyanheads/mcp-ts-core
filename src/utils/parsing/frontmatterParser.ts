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
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { assertTextInputBudget, type ParserInputBudgetOptions } from './inputBudget.js';
import { yamlParser } from './yamlParser.js';

/** The `---` fence that opens and closes a frontmatter block. */
const DELIMITER = '---';

/** Single-character `\s` test — no quantifier, so no backtracking. */
const WHITESPACE = /\s/;

/**
 * Positions a regex `^` matches under the `m` flag: the start of input, and
 * anything immediately after a LineTerminator (LF, CR, LS, PS).
 */
function isLineTerminator(char: string): boolean {
  return char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
}

/** Index just past the next line terminator at or after `from`, or `-1`. */
function nextLineStart(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (isLineTerminator(text.charAt(i))) return i + 1;
  }
  return -1;
}

/**
 * End of an opening `---` fence — the index just past the last newline in the
 * whitespace run that follows it, or `-1` when that run carries no newline.
 * Mirrors greedy `\s*` backtracking to the final `\n` it can leave for the
 * literal `\n` that follows.
 */
function endOfOpeningFence(text: string, from: number): number {
  let lastNewline = -1;
  for (let i = from; i < text.length && WHITESPACE.test(text.charAt(i)); i++) {
    if (text.charAt(i) === '\n') lastNewline = i;
  }
  return lastNewline === -1 ? -1 : lastNewline + 1;
}

/** Index of the next line-initial `---` at or after `from`, or `-1`. */
function findClosingFence(text: string, from: number): number {
  for (let i = from; i >= 0 && i <= text.length; i = nextLineStart(text, i)) {
    if (text.startsWith(DELIMITER, i)) return i;
  }
  return -1;
}

/**
 * Splits a markdown document into its YAML frontmatter block and the content
 * after it, or returns `null` when no complete block is present.
 *
 * A linear-time index walk replacing the equivalent
 * `/^---\s*\n([\s\S]*?)^---\s*([\s\S]*)$/m`, whose lazy `[\s\S]*?` between two
 * line-anchored fences takes time quadratic in the input when the closing fence
 * is absent — reachable whenever a server hands this parser markdown it
 * received over the wire (CodeQL `js/polynomial-redos`).
 *
 * Behavior is preserved exactly, including the shapes the regex decided
 * implicitly: the opening fence is the first line-initial `---` followed by a
 * whitespace run containing a newline (not necessarily the document's first
 * line); the closing fence is the next line-initial `---`, so a `----` line
 * closes the block and leaves its fourth dash on the content, and a `---`
 * inside the YAML that is not line-initial does not; and the whitespace after
 * the closing fence belongs to neither half.
 *
 * @param markdown - Document to split.
 * @returns The YAML source and the content that follows it, or `null`.
 */
function splitFrontmatter(markdown: string): { content: string; yaml: string } | null {
  for (let open = 0; open >= 0 && open <= markdown.length; open = nextLineStart(markdown, open)) {
    if (!markdown.startsWith(DELIMITER, open)) continue;

    const yamlStart = endOfOpeningFence(markdown, open + DELIMITER.length);
    if (yamlStart === -1) continue;

    const close = findClosingFence(markdown, yamlStart);
    // No closing fence after the earliest viable opening fence means none after
    // a later one either — every later search window is a subset of this one.
    if (close === -1) return null;

    let contentStart = close + DELIMITER.length;
    while (contentStart < markdown.length && WHITESPACE.test(markdown.charAt(contentStart))) {
      contentStart++;
    }

    return { yaml: markdown.slice(yamlStart, close), content: markdown.slice(contentStart) };
  }
  return null;
}

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
   * Looks for a `---`-delimited block opening on the first line that starts
   * with `---`. If found, the YAML inside is parsed via {@link yamlParser} and
   * the markdown after the closing fence is returned separately. An empty
   * `---\n---` block is accepted and returns `frontmatter: {}` with
   * `hasFrontmatter: true`. If no complete block is present, the original
   * string is returned unchanged.
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
   * // result.content     → '# Body'
   * // result.hasFrontmatter → true
   * ```
   */
  async parse<T = unknown>(
    markdown: string,
    context?: RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<FrontmatterResult<T>> {
    assertTextInputBudget(markdown, budget);

    const match = splitFrontmatter(markdown);

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

    const yamlContent = match.yaml;
    const markdownContent = match.content;

    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'FrontmatterParser.parse',
      });

    logger.debug(
      'Frontmatter detected, extracting and parsing.',
      withExtra(logContext, {
        yamlLength: yamlContent.length,
        contentLength: markdownContent.length,
      }),
    );

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

      logger.debug(
        'Frontmatter parsed successfully.',
        withExtra(logContext, {
          frontmatterKeys:
            parsedFrontmatter &&
            typeof parsedFrontmatter === 'object' &&
            !Array.isArray(parsedFrontmatter)
              ? Object.keys(parsedFrontmatter)
              : [],
        }),
      );

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

      logger.error(
        'Failed to parse frontmatter YAML content.',
        withExtra(errorLogContext, {
          errorDetails: error.message,
          yamlContentSample: yamlContent.substring(0, 200),
        }),
      );

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
 * console.log(result.content);        // '# Note Content\nThis is the actual note.'
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
