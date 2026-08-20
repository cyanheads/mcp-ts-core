/**
 * @fileoverview Diff formatter utility for comparing text and generating unified diffs.
 * Wraps the `diff` npm package (jsdiff) to produce git-style unified diff output with
 * configurable context lines and multiple output formats. All public methods are async
 * because the underlying `diff` library is loaded lazily on first use to avoid paying
 * the import cost when the formatter is not needed.
 * @module src/utils/formatting/diffFormatter
 */

import { JsonRpcErrorCode, McpError, validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';

const getDiff = lazyImport(
  () => import('diff'),
  'Install "diff" to use diff formatting: bun add diff',
);

import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';

/**
 * Diff output format options.
 * - `unified`: Standard unified diff hunks only — strips file/index headers (like `git diff` body).
 * - `patch`: Full patch format including `---`/`+++` file headers and index line.
 * - `inline`: No headers or hunk markers; additions wrapped as `[+text+]`, deletions as `[-text-]`.
 */
export type DiffFormat = 'unified' | 'patch' | 'inline';

/**
 * Configuration options for diff formatting.
 */
export interface DiffFormatterOptions {
  /**
   * Number of unchanged lines to show around each change (default: 3).
   * This is the "context" in unified diff format.
   */
  context?: number;

  /**
   * Output format for the diff. Defaults to `'unified'`.
   * See {@link DiffFormat} for a description of each format.
   */
  format?: DiffFormat;

  /**
   * Whether to include file headers in patch format (default: true).
   */
  includeHeaders?: boolean;

  /**
   * File path for new version (used in headers).
   */
  newPath?: string;

  /**
   * File path for old version (used in headers).
   */
  oldPath?: string;

  /**
   * Whether to include line numbers in the output (default: true).
   */
  showLineNumbers?: boolean;
}

/**
 * Utility class for generating diffs between text content.
 *
 * Wraps the `diff` npm package to produce git-style unified diff output. The `diff`
 * dependency is loaded lazily — all methods are `async` and will throw a
 * `ConfigurationError` if the package is not installed (`bun add diff`).
 *
 * Use the exported {@link diffFormatter} singleton rather than constructing instances
 * directly.
 */
export class DiffFormatter {
  /** Default formatting options applied when options are omitted or partially provided. */
  private readonly defaultOptions: Required<Omit<DiffFormatterOptions, 'oldPath' | 'newPath'>> = {
    context: 3,
    format: 'unified',
    showLineNumbers: true,
    includeHeaders: true,
  };

  /**
   * Generate a unified diff between two text strings.
   *
   * Compares content line-by-line using `diff.createPatch` and produces output
   * equivalent to `git diff`. This method is async because the `diff` package is
   * loaded lazily on first call.
   *
   * @param oldText - Original text content.
   * @param newText - Modified text content.
   * @param options - Diff formatting options. Defaults: `format: 'unified'`, `context: 3`,
   *   `showLineNumbers: true`, `includeHeaders: true`.
   * @param context - Optional request context for correlated logging. A new context is
   *   created automatically when omitted.
   * @returns Formatted diff string. Returns an empty string (or a no-change patch) when
   *   `oldText` and `newText` are identical.
   * @throws {McpError} With `ConfigurationError` if the `diff` package is not installed.
   * @throws {McpError} With `ValidationError` if either argument is not a string.
   * @throws {McpError} With `InternalError` if diff generation fails unexpectedly.
   *
   * @example
   * ```typescript
   * const oldCode = 'function hello() {\n  console.log("Hi");\n}';
   * const newCode = 'function hello(name) {\n  console.log(`Hello, ${name}!`);\n}';
   * const result = await diffFormatter.diff(oldCode, newCode, { context: 2 });
   * ```
   */
  async diff(
    oldText: string,
    newText: string,
    options?: DiffFormatterOptions,
    context?: RequestContext,
  ): Promise<string> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'DiffFormatter.diff',
      });

    // Validate inputs
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw validationError('Both oldText and newText must be strings', logContext);
    }

    const opts: Required<Omit<DiffFormatterOptions, 'oldPath' | 'newPath'>> &
      Pick<DiffFormatterOptions, 'oldPath' | 'newPath'> = {
      ...this.defaultOptions,
      ...options,
    };

    try {
      logger.debug(
        'Generating diff',
        withExtra(logContext, {
          oldLines: oldText.split('\n').length,
          newLines: newText.split('\n').length,
          format: opts.format,
        }),
      );

      // Generate diff using jsdiff library
      const Diff = await getDiff();
      const patches = Diff.createPatch(
        opts.oldPath || 'a/file',
        oldText,
        newText,
        opts.oldPath || 'old',
        opts.newPath || 'new',
        { context: opts.context },
      );

      // Format based on selected format
      const result = this.formatDiff(patches, opts);

      logger.debug(
        'Diff generated successfully',
        withExtra(logContext, { resultLength: result.length }),
      );

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to generate diff', withExtra(logContext, { error: message }));

      throw new McpError(JsonRpcErrorCode.InternalError, `Failed to generate diff: ${message}`, {
        ...logContext,
        originalError: stack,
      });
    }
  }

  /**
   * Generate a diff between two arrays of lines.
   *
   * A convenience wrapper around {@link diff} for callers that have already split
   * text into line arrays. Lines are joined with `\n` before diffing. This method
   * is async because it delegates to {@link diff}, which loads the `diff` package lazily.
   *
   * @param oldLines - Original lines (each element is one line, without a trailing newline).
   * @param newLines - Modified lines.
   * @param options - Diff formatting options. Passed through to {@link diff}.
   * @param context - Optional request context for correlated logging.
   * @returns Formatted diff string.
   * @throws {McpError} With `ValidationError` if either argument is not an array.
   * @throws {McpError} Propagates any error thrown by {@link diff}.
   *
   * @example
   * ```typescript
   * const oldLines = ['line 1', 'line 2', 'line 3'];
   * const newLines = ['line 1', 'modified line 2', 'line 3', 'line 4'];
   * const result = await diffFormatter.diffLines(oldLines, newLines);
   * ```
   */
  async diffLines(
    oldLines: string[],
    newLines: string[],
    options?: DiffFormatterOptions,
    context?: RequestContext,
  ): Promise<string> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'DiffFormatter.diffLines',
      });

    // Validate inputs
    if (!Array.isArray(oldLines) || !Array.isArray(newLines)) {
      throw validationError('Both oldLines and newLines must be arrays', logContext);
    }

    // Join arrays back into text and use main diff method
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');

    return await this.diff(oldText, newText, options, logContext);
  }

  /**
   * Generate a word-level diff between two text strings.
   *
   * Uses `diff.diffWords` to highlight changes at the word boundary rather than
   * at the line level. Output uses inline visual markers: added words are wrapped
   * as `[+word+]` and removed words as `[-word-]`. Unchanged words are emitted
   * as-is. This is particularly useful for diffing prose or documentation.
   *
   * This method is async because the `diff` package is loaded lazily on first call.
   *
   * @param oldText - Original text content.
   * @param newText - Modified text content.
   * @param context - Optional request context for correlated logging.
   * @returns Inline word-diff string with `[+added+]` and `[-removed-]` markers.
   * @throws {McpError} With `ConfigurationError` if the `diff` package is not installed.
   * @throws {McpError} With `ValidationError` if either argument is not a string.
   * @throws {McpError} With `InternalError` if diff generation fails unexpectedly.
   *
   * @example
   * ```typescript
   * const oldText = 'The quick brown fox';
   * const newText = 'The fast brown dog';
   * const result = await diffFormatter.diffWords(oldText, newText);
   * // => 'The [-quick-][+fast+] brown [-fox-][+dog+]'
   * ```
   */
  async diffWords(oldText: string, newText: string, context?: RequestContext): Promise<string> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'DiffFormatter.diffWords',
      });

    // Validate inputs
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw validationError('Both oldText and newText must be strings', logContext);
    }

    try {
      logger.debug('Generating word-level diff', logContext);

      const DiffMod = await getDiff();
      const changes = DiffMod.diffWords(oldText, newText);

      // Format word diff as inline changes
      const result = changes
        .map((part: { added?: boolean; removed?: boolean; value: string }) => {
          if (part.added) {
            return `[+${part.value}+]`;
          } else if (part.removed) {
            return `[-${part.value}-]`;
          }
          return part.value;
        })
        .join('');

      logger.debug(
        'Word diff generated successfully',
        withExtra(logContext, { changeCount: changes.length }),
      );

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to generate word diff', withExtra(logContext, { error: message }));

      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Failed to generate word diff: ${message}`,
        { ...logContext, originalError: stack },
      );
    }
  }

  /**
   * Dispatch to the appropriate formatter based on `options.format`.
   *
   * @param patch - Raw patch string produced by `diff.createPatch`.
   * @param options - Resolved formatting options (no optional fields except path names).
   * @returns Formatted diff string.
   */
  private formatDiff(
    patch: string,
    options: Required<Omit<DiffFormatterOptions, 'oldPath' | 'newPath'>> &
      Pick<DiffFormatterOptions, 'oldPath' | 'newPath'>,
  ): string {
    switch (options.format) {
      case 'patch':
        // Full patch format with headers
        return options.includeHeaders ? patch : this.stripHeaders(patch);

      case 'unified':
        // Standard unified diff (no file headers)
        return this.stripHeaders(patch);

      case 'inline':
        // Inline diff with context
        return this.formatInline(patch);

      default:
        return patch;
    }
  }

  /**
   * Strip the `Index:`, `===`, `---`, and `+++` header lines from a patch string,
   * returning only the `@@` hunk markers and diff body lines.
   *
   * @param patch - Raw patch string from `diff.createPatch`.
   * @returns Patch with file/index headers removed, starting from the first `@@` line.
   *   Returns `patch` unchanged if no `@@` line is found (no differences).
   */
  private stripHeaders(patch: string): string {
    const lines = patch.split('\n');
    // Skip first 4 lines (---, +++, Index, ===)
    const startIndex = lines.findIndex((line) => line.startsWith('@@'));
    if (startIndex === -1) {
      return patch;
    }
    return lines.slice(startIndex).join('\n');
  }

  /**
   * Convert a unified patch string to inline format.
   *
   * Strips all header lines (`Index:`, `===`, `---`, `+++`, `@@`, `\ No newline…`) and
   * rewrites each diff line using visual markers: lines beginning with `-` become
   * `[-content-]`, lines beginning with `+` become `[+content+]`, and context lines
   * (space-prefixed) are emitted without the leading space.
   *
   * @param patch - Raw patch string from `diff.createPatch`.
   * @returns Inline diff string with `[+..+]`/`[-..-]` markers and no header lines.
   */
  private formatInline(patch: string): string {
    const lines = patch.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      // Skip file headers and hunk markers
      if (
        line.startsWith('Index:') ||
        line.startsWith('===') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('@@') ||
        line.startsWith('\\ No newline')
      ) {
        continue;
      }

      if (line.startsWith('-')) {
        result.push(`[-${line.substring(1)}-]`);
      } else if (line.startsWith('+')) {
        result.push(`[+${line.substring(1)}+]`);
      } else if (line.startsWith(' ')) {
        result.push(line.substring(1));
      } else if (line !== '') {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  /**
   * Compute line-level statistics for the differences between two texts.
   *
   * Uses `diff.diffLines` to count added and deleted lines. The `changes` field is
   * the sum of `additions + deletions`. This method is async because the `diff`
   * package is loaded lazily on first call.
   *
   * @param oldText - Original text content.
   * @param newText - Modified text content.
   * @param context - Optional request context for correlated logging.
   * @returns `{ additions, deletions, changes }` — all values are line counts.
   *   `additions` and `deletions` are both `0` when the texts are identical.
   * @throws {McpError} With `ConfigurationError` if the `diff` package is not installed.
   * @throws {McpError} With `InternalError` if analysis fails unexpectedly.
   *
   * @example
   * ```typescript
   * const stats = await diffFormatter.getStats(oldText, newText);
   * console.log(`+${stats.additions} -${stats.deletions} (~${stats.changes} lines changed)`);
   * ```
   */
  async getStats(
    oldText: string,
    newText: string,
    context?: RequestContext,
  ): Promise<{ additions: number; deletions: number; changes: number }> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'DiffFormatter.getStats',
      });

    try {
      const DiffMod = await getDiff();
      const changes = DiffMod.diffLines(oldText, newText);

      const stats = changes.reduce(
        (
          acc: { additions: number; deletions: number },
          c: { added?: boolean; removed?: boolean; count?: number },
        ) => {
          if (c.added) acc.additions += c.count || 0;
          else if (c.removed) acc.deletions += c.count || 0;
          return acc;
        },
        { additions: 0, deletions: 0 },
      );

      return { ...stats, changes: stats.additions + stats.deletions };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      throw new McpError(JsonRpcErrorCode.InternalError, `Failed to get diff stats: ${message}`, {
        ...logContext,
        originalError: stack,
      });
    }
  }
}

/**
 * Singleton instance of {@link DiffFormatter}.
 *
 * All methods are async — they load the `diff` package lazily on first call.
 * Install the peer dependency if not already present: `bun add diff`.
 *
 * @example
 * ```typescript
 * import { diffFormatter } from '@/utils/formatting/diffFormatter.js';
 *
 * const oldCode = `function hello() {
 *   console.log('Hi');
 * }`;
 *
 * const newCode = `function hello(name: string) {
 *   console.log(\`Hello, \${name}!\`);
 * }`;
 *
 * // Standard unified diff (hunk headers, no file headers)
 * const unified = await diffFormatter.diff(oldCode, newCode);
 *
 * // Inline diff — additions as [+text+], deletions as [-text-]
 * const inline = await diffFormatter.diff(oldCode, newCode, { format: 'inline' });
 *
 * // Line-level change counts
 * const stats = await diffFormatter.getStats(oldCode, newCode);
 * console.log(`Changes: +${stats.additions} -${stats.deletions}`);
 *
 * // Word-level diff for prose
 * const wordDiff = await diffFormatter.diffWords('The quick brown fox', 'The fast brown dog');
 * ```
 */
export const diffFormatter = new DiffFormatter();
