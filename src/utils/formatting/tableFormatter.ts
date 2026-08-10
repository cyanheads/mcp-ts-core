/**
 * @fileoverview Table formatter utility for creating tables in multiple formats.
 * Supports markdown, ASCII, grid (Unicode), and compact table styles with configurable
 * alignment, truncation, and formatting options.
 * @module src/utils/formatting/tableFormatter
 */

import { JsonRpcErrorCode, McpError, validationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from '@/utils/internal/requestContext.js';

/**
 * Table output style options.
 *
 * - `markdown`: GitHub-flavored markdown table with pipe delimiters and alignment indicators.
 * - `ascii`: Box-drawing table using `+`, `-`, and `|` characters; portable across terminals.
 * - `grid`: Unicode box-drawing table using `┌─┬─┐` characters; visually cleaner but requires Unicode support.
 * - `compact`: Borderless table with columns separated by spaces; minimal visual noise.
 *
 * @example
 * ```typescript
 * const style: TableStyle = 'grid';
 * ```
 */
export type TableStyle = 'markdown' | 'ascii' | 'grid' | 'compact';

/**
 * Column alignment options.
 *
 * Controls how cell content is padded within its column width.
 * - `left`: Content flush-left, trailing spaces fill the column.
 * - `center`: Content centred, padding split evenly (odd remainder goes right).
 * - `right`: Content flush-right, leading spaces fill the column.
 *
 * @example
 * ```typescript
 * const alignment: Alignment = 'right';
 * ```
 */
export type Alignment = 'left' | 'center' | 'right';

/**
 * Configuration options for table formatting.
 */
export interface TableFormatterOptions {
  /**
   * Column-specific alignment configuration.
   * Key is column name (for object arrays) or index (for raw arrays).
   * @example { name: 'left', age: 'right', email: 'center' }
   */
  alignment?: Record<string, Alignment>;

  /**
   * Header styling option.
   * - bold: Headers in bold (markdown only)
   * - uppercase: Convert headers to uppercase
   * - none: No special header formatting
   */
  headerStyle?: 'bold' | 'uppercase' | 'none';

  /**
   * Maximum width for any column. Content exceeding this will be truncated.
   */
  maxWidth?: number;

  /**
   * Minimum column width (default: 3).
   */
  minWidth?: number;

  /**
   * Padding around cell content (default: 1 space).
   */
  padding?: number;
  /**
   * Table style to use for rendering.
   * - markdown: GitHub-style markdown tables (| Header | Header |)
   * - ascii: ASCII box drawing with +, -, | characters
   * - grid: Unicode box-drawing characters (┌─┬─┐)
   * - compact: Space-separated columns (no borders)
   */
  style?: TableStyle;

  /**
   * Whether to truncate long content with ellipsis (default: true).
   * If false, content may wrap or overflow depending on style.
   */
  truncate?: boolean;
}

/**
 * Internal column metadata for rendering.
 * @private
 */
interface ColumnInfo {
  alignment: Alignment;
  name: string;
  width: number;
}

/**
 * Utility class for formatting tabular data into various table styles.
 *
 * Provides two rendering methods:
 * - {@link format} — accepts an array of objects and extracts headers automatically.
 * - {@link formatRaw} — accepts explicit headers and a 2D string array for full control.
 *
 * Column widths are computed from the widest value in each column, clamped by
 * `minWidth` and `maxWidth`. Content that exceeds `maxWidth` is truncated with
 * an ellipsis (`...`) when `truncate` is `true` (the default).
 *
 * @example
 * ```typescript
 * const data = [
 *   { name: 'Alice', score: 42 },
 *   { name: 'Bob',   score: 7  },
 * ];
 *
 * // Markdown (default style)
 * tableFormatter.format(data);
 * // | name  | score |
 * // | ----- | ----- |
 * // | Alice | 42    |
 * // | Bob   | 7     |
 *
 * // Unicode grid with right-aligned score column
 * tableFormatter.format(data, { style: 'grid', alignment: { score: 'right' } });
 * ```
 */
export class TableFormatter {
  /**
   * Default formatting options.
   * @private
   */
  private readonly defaultOptions: Required<TableFormatterOptions> = {
    style: 'markdown',
    alignment: {},
    maxWidth: 50,
    truncate: true,
    headerStyle: 'none',
    minWidth: 3,
    padding: 1,
  };

  /**
   * Format an array of objects as a table.
   *
   * Headers are derived from the keys of the first object. Every value is
   * converted to a string via an internal `stringify` helper that handles
   * primitives, arrays (JSON), objects (JSON), and special values (`null`,
   * `undefined`, functions, symbols).
   *
   * @template T - Type of objects in the array; must extend `Record<string, unknown>`.
   * @param data - Array of objects to render. Returns `''` immediately if empty.
   * @param options - Table formatting options. All fields are optional; defaults apply.
   * @param context - Optional request context used for correlated debug logging.
   *   A new context is created automatically when omitted.
   * @returns Formatted table string in the requested style, or `''` if `data` is empty.
   * @throws {McpError} With `ValidationError` code if `data` is not an array.
   * @throws {McpError} With `InternalError` code if rendering fails unexpectedly.
   *
   * @example
   * ```typescript
   * const data = [
   *   { name: 'Alice', age: 30, role: 'Engineer' },
   *   { name: 'Bob',   age: 25, role: 'Designer' },
   * ];
   *
   * // Default markdown output
   * tableFormatter.format(data);
   *
   * // Unicode grid with right-aligned age column
   * tableFormatter.format(data, { style: 'grid', alignment: { age: 'right' } });
   * ```
   */
  format<T extends Record<string, unknown>>(
    data: T[],
    options?: TableFormatterOptions,
    context?: RequestContextLike | RequestContext,
  ): string {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'TableFormatter.format',
      });

    if (!Array.isArray(data)) {
      throw validationError('Data must be an array', logContext);
    }

    if (data.length === 0) {
      logger.debug('Empty data array provided to table formatter', logContext);
      return '';
    }

    // Extract headers from first object (safe: length checked above)
    const firstRow = data[0] as T;
    const headers = Object.keys(firstRow);

    // Convert objects to 2D array
    const rows = data.map((obj) => headers.map((header) => this.stringify(obj[header])));

    logger.debug('Formatting table from object array', {
      ...logContext,
      rowCount: rows.length,
      columnCount: headers.length,
    });

    return this.formatRaw(headers, rows, options, context);
  }

  /**
   * Format a raw 2D string array with explicit headers.
   *
   * Unlike {@link format}, no automatic key extraction or value stringification
   * occurs — callers supply pre-serialized strings. All rows must have exactly
   * the same number of columns as `headers`; a mismatch throws immediately.
   *
   * @param headers - Non-empty array of column header strings.
   * @param rows - 2D array of string cell values. Every inner array must have
   *   the same length as `headers`. Returns `''` immediately if `rows` is empty.
   * @param options - Table formatting options. All fields are optional; defaults apply.
   * @param context - Optional request context used for correlated debug logging.
   *   A new context is created automatically when omitted.
   * @returns Formatted table string in the requested style, or `''` if `rows` is empty.
   * @throws {McpError} With `ValidationError` code if `headers` is empty or not an array,
   *   `rows` is not an array, or any row's column count differs from `headers.length`.
   * @throws {McpError} With `InternalError` code if rendering fails unexpectedly.
   *
   * @example
   * ```typescript
   * const headers = ['Name', 'Age', 'Role'];
   * const rows = [
   *   ['Alice', '30', 'Engineer'],
   *   ['Bob',   '25', 'Designer'],
   * ];
   * const table = tableFormatter.formatRaw(headers, rows, { style: 'ascii' });
   * ```
   */
  formatRaw(
    headers: string[],
    rows: string[][],
    options?: TableFormatterOptions,
    context?: RequestContextLike | RequestContext,
  ): string {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'TableFormatter.formatRaw',
      });

    // Validate inputs
    if (!Array.isArray(headers) || headers.length === 0) {
      throw validationError('Headers must be a non-empty array', logContext);
    }

    if (!Array.isArray(rows)) {
      throw validationError('Rows must be an array', logContext);
    }

    if (rows.length === 0) {
      logger.debug('Empty rows array provided to table formatter', logContext);
      return '';
    }

    // Validate row lengths
    const columnCount = headers.length;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]?.length !== columnCount) {
        throw validationError(
          `Row ${i} has ${rows[i]?.length} columns but expected ${columnCount}`,
          { ...logContext, rowIndex: i, expectedColumns: columnCount },
        );
      }
    }

    // Merge options with defaults
    const opts: Required<TableFormatterOptions> = {
      ...this.defaultOptions,
      ...options,
      alignment: { ...this.defaultOptions.alignment, ...options?.alignment },
    };

    // Apply header styling
    const styledHeaders = this.applyHeaderStyle(headers, opts.headerStyle);

    // Calculate column widths and metadata
    const columns = this.calculateColumns(styledHeaders, rows, opts, logContext);

    // Render table based on style
    try {
      const result = this.renderTable(columns, styledHeaders, rows, opts);

      logger.debug('Table formatted successfully', {
        ...logContext,
        style: opts.style,
        rows: rows.length,
        columns: columns.length,
      });

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to render table', {
        ...logContext,
        error: message,
      });

      throw new McpError(JsonRpcErrorCode.InternalError, `Failed to render table: ${message}`, {
        ...logContext,
        originalError: stack,
      });
    }
  }

  /**
   * Apply header styling transformations.
   * @private
   */
  private applyHeaderStyle(headers: string[], style: 'bold' | 'uppercase' | 'none'): string[] {
    switch (style) {
      case 'bold':
        return headers.map((h) => `**${h}**`);
      case 'uppercase':
        return headers.map((h) => h.toUpperCase());
      default:
        return headers;
    }
  }

  /**
   * Calculate column widths and metadata.
   * @private
   */
  private calculateColumns(
    headers: string[],
    rows: string[][],
    options: Required<TableFormatterOptions>,
    context: RequestContext,
  ): ColumnInfo[] {
    const columns: ColumnInfo[] = headers.map((header, index) => {
      // Determine alignment (use configured or default to left)
      const alignment = options.alignment[header] || options.alignment[index.toString()] || 'left';

      // Calculate max content width for this column
      const headerWidth = header.length;
      const maxContentWidth = Math.max(...rows.map((row) => (row[index] || '').length));

      // Determine final width (respecting min/max constraints)
      let width = Math.max(headerWidth, maxContentWidth);
      width = Math.max(width, options.minWidth);
      if (options.maxWidth && width > options.maxWidth) {
        width = options.maxWidth;
      }

      return { name: header, width, alignment };
    });

    logger.debug('Calculated column widths', {
      ...context,
      columns: columns.map((c) => ({ name: c.name, width: c.width })),
    });

    return columns;
  }

  /**
   * Render table using the specified style.
   * @private
   */
  private renderTable(
    columns: ColumnInfo[],
    headers: string[],
    rows: string[][],
    options: Required<TableFormatterOptions>,
  ): string {
    switch (options.style) {
      case 'markdown':
        return this.renderMarkdown(columns, headers, rows, options);
      case 'ascii':
        return this.renderAscii(columns, headers, rows, options);
      case 'grid':
        return this.renderGrid(columns, headers, rows, options);
      case 'compact':
        return this.renderCompact(columns, headers, rows, options);
      default:
        throw new Error(`Unknown table style: ${String(options.style)}`);
    }
  }

  /**
   * Render markdown-style table.
   * @private
   */
  private renderMarkdown(
    columns: ColumnInfo[],
    headers: string[],
    rows: string[][],
    options: Required<TableFormatterOptions>,
  ): string {
    const lines: string[] = [];
    const pad = ' '.repeat(options.padding);

    // Header row
    const headerCells = headers.map((header, i) =>
      this.formatCell(header, columns[i] as ColumnInfo, options),
    );
    lines.push(`|${pad}${headerCells.join(`${pad}|${pad}`)}${pad}|`);

    // Separator row (with alignment indicators for markdown)
    const separators = columns.map((col) => {
      switch (col.alignment) {
        case 'right':
          return `${'-'.repeat(Math.max(col.width - 1, 1))}:`;
        case 'center':
          return `:${'-'.repeat(Math.max(col.width - 2, 1))}:`;
        default:
          return '-'.repeat(col.width);
      }
    });
    lines.push(`|${pad}${separators.join(`${pad}|${pad}`)}${pad}|`);

    // Data rows
    for (const row of rows) {
      const cells = row.map((cell, i) => this.formatCell(cell, columns[i] as ColumnInfo, options));
      lines.push(`|${pad}${cells.join(`${pad}|${pad}`)}${pad}|`);
    }

    return lines.join('\n');
  }

  /**
   * Render ASCII box-drawing table.
   * @private
   */
  private renderAscii(
    columns: ColumnInfo[],
    headers: string[],
    rows: string[][],
    options: Required<TableFormatterOptions>,
  ): string {
    const lines: string[] = [];
    const pad = ' '.repeat(options.padding);

    // Top border
    const topBorder = columns.map((col) => '-'.repeat(col.width + options.padding * 2)).join('+');
    lines.push(`+${topBorder}+`);

    // Header row
    const headerCells = headers.map((header, i) =>
      this.formatCell(header, columns[i] as ColumnInfo, options),
    );
    lines.push(`|${pad}${headerCells.join(`${pad}|${pad}`)}${pad}|`);

    // Header separator
    const headerSep = columns.map((col) => '-'.repeat(col.width + options.padding * 2)).join('+');
    lines.push(`+${headerSep}+`);

    // Data rows
    for (const row of rows) {
      const cells = row.map((cell, i) => this.formatCell(cell, columns[i] as ColumnInfo, options));
      lines.push(`|${pad}${cells.join(`${pad}|${pad}`)}${pad}|`);
    }

    // Bottom border
    const bottomBorder = columns
      .map((col) => '-'.repeat(col.width + options.padding * 2))
      .join('+');
    lines.push(`+${bottomBorder}+`);

    return lines.join('\n');
  }

  /**
   * Render Unicode grid table.
   * @private
   */
  private renderGrid(
    columns: ColumnInfo[],
    headers: string[],
    rows: string[][],
    options: Required<TableFormatterOptions>,
  ): string {
    const lines: string[] = [];
    const pad = ' '.repeat(options.padding);

    // Top border
    const topBorder = columns.map((col) => '─'.repeat(col.width + options.padding * 2)).join('┬');
    lines.push(`┌${topBorder}┐`);

    // Header row
    const headerCells = headers.map((header, i) =>
      this.formatCell(header, columns[i] as ColumnInfo, options),
    );
    lines.push(`│${pad}${headerCells.join(`${pad}│${pad}`)}${pad}│`);

    // Header separator
    const headerSep = columns.map((col) => '─'.repeat(col.width + options.padding * 2)).join('┼');
    lines.push(`├${headerSep}┤`);

    // Data rows
    for (const row of rows) {
      const cells = row.map((cell, i) => this.formatCell(cell, columns[i] as ColumnInfo, options));
      lines.push(`│${pad}${cells.join(`${pad}│${pad}`)}${pad}│`);
    }

    // Bottom border
    const bottomBorder = columns
      .map((col) => '─'.repeat(col.width + options.padding * 2))
      .join('┴');
    lines.push(`└${bottomBorder}┘`);

    return lines.join('\n');
  }

  /**
   * Render compact space-separated table.
   * @private
   */
  private renderCompact(
    columns: ColumnInfo[],
    headers: string[],
    rows: string[][],
    options: Required<TableFormatterOptions>,
  ): string {
    const lines: string[] = [];
    const pad = ' '.repeat(options.padding * 2);

    // Header row
    const headerCells = headers.map((header, i) =>
      this.formatCell(header, columns[i] as ColumnInfo, options),
    );
    lines.push(headerCells.join(pad));

    // Data rows
    for (const row of rows) {
      const cells = row.map((cell, i) => this.formatCell(cell, columns[i] as ColumnInfo, options));
      lines.push(cells.join(pad));
    }

    return lines.join('\n');
  }

  /**
   * Format a single cell with alignment and truncation.
   * @private
   */
  private formatCell(
    content: string,
    column: ColumnInfo,
    options: Required<TableFormatterOptions>,
  ): string {
    let text = content;

    // Truncate if needed
    if (options.truncate && text.length > column.width) {
      const visibleChars = Math.max(column.width - 3, 0);
      text = `${text.substring(0, visibleChars)}...`;
    }

    // Apply alignment padding
    const padding = column.width - text.length;
    if (padding <= 0) {
      return text;
    }

    switch (column.alignment) {
      case 'left':
        return text + ' '.repeat(padding);
      case 'right':
        return ' '.repeat(padding) + text;
      case 'center': {
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
      }
      default:
        return text;
    }
  }

  /**
   * Convert any value to a string for display in table.
   * @private
   */
  private stringify(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'boolean') return value.toString();
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return '[Function]';
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '[Object]';
      }
    }
    return '[Unknown]';
  }
}

/**
 * Singleton instance of {@link TableFormatter}.
 *
 * Prefer this over constructing `new TableFormatter()` directly. Use
 * {@link TableFormatter.format} for object arrays and
 * {@link TableFormatter.formatRaw} for pre-serialized 2D string arrays.
 *
 * @example
 * ```typescript
 * import { tableFormatter } from '@/utils/formatting/tableFormatter.js';
 *
 * const data = [
 *   { name: 'Alice', age: 30, role: 'Engineer' },
 *   { name: 'Bob',   age: 25, role: 'Designer' },
 * ];
 *
 * // Markdown table (default style)
 * console.log(tableFormatter.format(data));
 *
 * // Unicode grid with right-aligned age column
 * console.log(tableFormatter.format(data, {
 *   style: 'grid',
 *   alignment: { age: 'right' },
 * }));
 *
 * // Compact borderless table with uppercase headers
 * console.log(tableFormatter.format(data, {
 *   style: 'compact',
 *   headerStyle: 'uppercase',
 * }));
 *
 * // Raw 2D array (no automatic key extraction)
 * console.log(tableFormatter.formatRaw(
 *   ['Name', 'Age'],
 *   [['Alice', '30'], ['Bob', '25']],
 *   { style: 'ascii' },
 * ));
 * ```
 */
export const tableFormatter = new TableFormatter();
