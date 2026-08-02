/**
 * @fileoverview Tests for TableFormatter utility
 * @module tests/utils/formatting/tableFormatter.test
 */
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { TableFormatter, tableFormatter } from '@/utils/formatting/tableFormatter.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

describe('TableFormatter', () => {
  const sampleData = [
    { name: 'Alice', age: 30, role: 'Engineer' },
    { name: 'Bob', age: 25, role: 'Designer' },
    { name: 'Charlie', age: 35, role: 'Manager' },
  ];

  describe('Singleton instance', () => {
    it('should export a singleton instance', () => {
      expect(tableFormatter).toBeInstanceOf(TableFormatter);
      expect(tableFormatter.format).toBeInstanceOf(Function);
      expect(tableFormatter.formatRaw).toBeInstanceOf(Function);
    });
  });

  describe('format() with object arrays', () => {
    it('should format simple data in markdown style (default)', () => {
      const result = tableFormatter.format(sampleData);

      expect(result).toContain('| name');
      expect(result).toContain('| age');
      expect(result).toContain('| role');
      expect(result).toContain('Alice');
      expect(result).toContain('30');
      expect(result).toContain('Engineer');
    });

    it('should format data with custom style', () => {
      const result = tableFormatter.format(sampleData, { style: 'grid' });

      expect(result).toContain('┌');
      expect(result).toContain('┐');
      expect(result).toContain('│');
      expect(result).toContain('Alice');
    });

    it('should handle single-row data', () => {
      const singleRow = [{ name: 'Alice', age: 30 }];
      const result = tableFormatter.format(singleRow);

      expect(result).toContain('Alice');
      expect(result).toContain('30');
    });

    it('should handle various data types', () => {
      const mixedData = [{ str: 'text', num: 42, bool: true, nul: null, arr: [1, 2] }];
      const result = tableFormatter.format(mixedData);

      expect(result).toContain('text');
      expect(result).toContain('42');
      expect(result).toContain('true');
      expect(result).toContain('null');
      expect(result).toContain('[1,2]');
    });

    it('should handle undefined values', () => {
      const data = [{ a: 'hello', b: undefined }];
      const result = tableFormatter.format(data);

      expect(result).toContain('hello');
      expect(result).toContain('undefined');
    });

    it('should handle nested objects', () => {
      const data = [{ name: 'test', config: { key: 'value' } }];
      const result = tableFormatter.format(data);

      expect(result).toContain('test');
      expect(result).toContain('{"key":"value"}');
    });

    it('should handle circular objects gracefully', () => {
      const circular: Record<string, unknown> = { name: 'test' };
      circular.self = circular;
      const data = [circular];
      const result = tableFormatter.format(data);

      expect(result).toContain('test');
      expect(result).toContain('[Object]');
    });

    it('stringifies bigint, symbol, and function values', () => {
      const result = tableFormatter.format([
        {
          bigint: 9007199254740993n,
          symbol: Symbol.for('table-value'),
          function: () => 'value',
        },
      ]);

      expect(result).toContain('9007199254740993');
      expect(result).toContain('Symbol(table-value)');
      expect(result).toContain('[Function]');
    });
  });

  describe('formatRaw() with headers and rows', () => {
    const headers = ['Name', 'Age', 'Role'];
    const rows = [
      ['Alice', '30', 'Engineer'],
      ['Bob', '25', 'Designer'],
    ];

    it('should format raw data with markdown style', () => {
      const result = tableFormatter.formatRaw(headers, rows);

      expect(result).toContain('Name');
      expect(result).toContain('Age');
      expect(result).toContain('Role');
      expect(result).toContain('Alice');
      expect(result).toContain('30');
      expect(result).toContain('Engineer');
    });

    it('should format raw data with ascii style', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'ascii',
      });

      expect(result).toContain('+');
      expect(result).toContain('|');
      expect(result).toContain('-');
      expect(result).toContain('Alice');
    });

    it('should format raw data with grid style', () => {
      const result = tableFormatter.formatRaw(headers, rows, { style: 'grid' });

      expect(result).toContain('┌');
      expect(result).toContain('┬');
      expect(result).toContain('┐');
      expect(result).toContain('│');
      expect(result).toContain('├');
      expect(result).toContain('┤');
      expect(result).toContain('└');
      expect(result).toContain('┴');
      expect(result).toContain('┘');
      expect(result).toContain('Alice');
    });

    it('should format raw data with compact style', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'compact',
      });

      expect(result).not.toContain('|');
      expect(result).not.toContain('+');
      expect(result).not.toContain('─');
      expect(result).toContain('Alice');
      expect(result).toContain('30');
    });

    it('measures an empty cell as zero-width content', () => {
      const result = tableFormatter.formatRaw(['A'], [['']], {
        style: 'compact',
        minWidth: 1,
      });

      expect(result.split('\n')).toEqual(['A', ' ']);
    });
  });

  describe('Alignment options', () => {
    const headers = ['Name', 'Age', 'Score'];
    const rows = [
      ['Alice', '30', '95'],
      ['Bob', '25', '88'],
    ];

    it('should align columns to the left (default)', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'compact',
      });

      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(0);
    });

    it('should render right-alignment indicators in markdown separators', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        alignment: { Age: 'right', Score: 'right' },
      });

      // Right-aligned columns use trailing colon in separator
      const separatorLine = result.split('\n')[1];
      expect(separatorLine).toMatch(/-+:/);
      expect(result).toContain('Age');
      expect(result).toContain('Score');
    });

    it('should render center-alignment indicators in markdown separators', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        alignment: { Name: 'center' },
      });

      // Center-aligned columns use leading and trailing colons in separator
      const separatorLine = result.split('\n')[1];
      expect(separatorLine).toMatch(/:-+:/);
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    it('should support mixed alignment', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'grid',
        alignment: {
          Name: 'left',
          Age: 'center',
          Score: 'right',
        },
      });

      expect(result).toContain('Alice');
      expect(result).toContain('30');
      expect(result).toContain('95');
    });

    it('should support alignment by column index string', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        alignment: { '1': 'right', '2': 'right' },
      });

      // Index-based alignment should produce same separator indicators as name-based
      const separatorLine = result.split('\n')[1];
      expect(separatorLine).toMatch(/-+:/);
    });

    it('returns unpadded content for an unknown alignment', () => {
      const result = tableFormatter.formatRaw(['Column'], [['x']], {
        style: 'compact',
        alignment: { Column: 'decimal' as never },
      });

      expect(result).toBe('Column\nx');
    });
  });

  describe('Truncation and maxWidth', () => {
    it('should truncate long content when truncate is true', () => {
      const longData = [{ short: 'OK', long: 'This is a very long string that exceeds limits' }];

      const result = tableFormatter.format(longData, {
        maxWidth: 15,
        truncate: true,
      });

      expect(result).toContain('...');
      expect(result).not.toContain('that exceeds limits');
    });

    it('should respect maxWidth setting', () => {
      const data = [{ col: 'A'.repeat(100) }];

      const result = tableFormatter.format(data, {
        maxWidth: 20,
        truncate: true,
      });

      const lines = result.split('\n');
      expect(lines.some((line) => line.length < 150)).toBe(true); // Truncated
    });

    it('should handle truncate: false', () => {
      const data = [{ text: 'Short text' }];

      const result = tableFormatter.format(data, {
        truncate: false,
      });

      expect(result).toContain('Short text');
    });
  });

  describe('Header styling', () => {
    const headers = ['Name', 'Age'];
    const rows = [['Alice', '30']];

    it('should apply uppercase header style', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        headerStyle: 'uppercase',
      });

      expect(result).toContain('NAME');
      expect(result).toContain('AGE');
      expect(result).not.toContain('Name');
      expect(result).not.toContain('Age');
    });

    it('should apply none header style (default)', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        headerStyle: 'none',
      });

      expect(result).toContain('Name');
      expect(result).toContain('Age');
    });

    it('should apply bold header style (markdown wrapping)', () => {
      const result = tableFormatter.formatRaw(headers, rows, {
        headerStyle: 'bold',
      });

      expect(result).toContain('**Name**');
      expect(result).toContain('**Age**');
    });
  });

  describe('Edge cases', () => {
    it('should return empty string for empty data array', () => {
      const result = tableFormatter.format([]);
      expect(result).toBe('');
    });

    it('should return empty string for empty rows array', () => {
      const result = tableFormatter.formatRaw(['Header'], []);
      expect(result).toBe('');
    });

    it('should handle single column data', () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }];
      const result = tableFormatter.format(data);

      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    it('should handle wide content with compact style', () => {
      const data = [
        { a: 'A'.repeat(50), b: 'B'.repeat(50) },
        { a: 'Short', b: 'Text' },
      ];

      const result = tableFormatter.format(data, { style: 'compact' });
      expect(result).toBeTruthy();
    });

    it('should handle special characters in content', () => {
      const data = [{ text: 'Hello\nWorld' }, { text: 'Foo\tBar' }];
      const result = tableFormatter.format(data);

      expect(result).toBeTruthy();
    });

    it('should log debug messages for empty data', () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      tableFormatter.format([]);

      expect(debugSpy).toHaveBeenCalledWith(
        'Empty data array provided to table formatter',
        expect.any(Object),
      );

      debugSpy.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should throw McpError for non-array data', () => {
      expect(() => {
        // @ts-expect-error Testing invalid input
        tableFormatter.format('not an array');
      }).toThrow(McpError);

      try {
        // @ts-expect-error Testing invalid input
        tableFormatter.format('not an array');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('array');
      }
    });

    it('should throw McpError for empty headers', () => {
      expect(() => {
        tableFormatter.formatRaw([], [['data']]);
      }).toThrow(McpError);

      try {
        tableFormatter.formatRaw([], [['data']]);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('Headers');
      }
    });

    it('should throw McpError for non-array rows', () => {
      expect(() => {
        // @ts-expect-error Testing invalid input
        tableFormatter.formatRaw(['Header'], 'not an array');
      }).toThrow(McpError);
    });

    it('should throw McpError for mismatched row lengths', () => {
      const headers = ['A', 'B', 'C'];
      const rows = [
        ['1', '2', '3'],
        ['4', '5'], // Missing column
      ];

      expect(() => {
        tableFormatter.formatRaw(headers, rows);
      }).toThrow(McpError);

      try {
        tableFormatter.formatRaw(headers, rows);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('columns');
      }
    });

    it('should log errors with context', () => {
      const errorSpy = vi.spyOn(logger, 'error');
      const context = requestContextService.createRequestContext({
        operation: 'test',
      });

      try {
        // @ts-expect-error Testing invalid input
        tableFormatter.format('invalid', {}, context);
      } catch {
        // Expected to throw
      }

      errorSpy.mockRestore();
    });

    it('normalizes an unknown table style as an internal rendering error', () => {
      expect(() => tableFormatter.formatRaw(['A'], [['1']], { style: 'future' as never })).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InternalError,
          message: 'Failed to render table: Unknown table style: future',
        }),
      );
    });

    it('normalizes a non-Error rendering failure', () => {
      const formatter = new TableFormatter();
      const internals = formatter as unknown as { renderTable: () => string };
      vi.spyOn(internals, 'renderTable').mockImplementation(() => {
        throw 'renderer rejected';
      });

      expect(() => formatter.formatRaw(['A'], [['1']])).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InternalError,
          message: 'Failed to render table: renderer rejected',
        }),
      );
    });
  });

  describe('Context logging', () => {
    it('should log successful formatting with context', () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const context = requestContextService.createRequestContext({
        operation: 'test-table-format',
      });

      const data = [{ name: 'Test' }];
      tableFormatter.format(data, {}, context);

      expect(debugSpy).toHaveBeenCalledWith(
        'Table formatted successfully',
        expect.objectContaining({
          operation: 'test-table-format',
        }),
      );

      debugSpy.mockRestore();
    });

    it('should create auto-generated context when none provided', () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const data = [{ name: 'Test' }];

      tableFormatter.format(data);

      expect(debugSpy).toHaveBeenCalledWith(
        'Table formatted successfully',
        expect.objectContaining({
          operation: 'TableFormatter.formatRaw',
        }),
      );

      debugSpy.mockRestore();
    });
  });

  describe('Styling variations', () => {
    const headers = ['Col1', 'Col2'];
    const rows = [
      ['A', 'B'],
      ['C', 'D'],
    ];

    it('should produce different outputs for each style', () => {
      const markdown = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
      });
      const ascii = tableFormatter.formatRaw(headers, rows, { style: 'ascii' });
      const grid = tableFormatter.formatRaw(headers, rows, { style: 'grid' });
      const compact = tableFormatter.formatRaw(headers, rows, {
        style: 'compact',
      });

      // All should contain data
      [markdown, ascii, grid, compact].forEach((result) => {
        expect(result).toContain('A');
        expect(result).toContain('B');
        expect(result).toContain('C');
        expect(result).toContain('D');
      });

      // Each should be unique
      expect(markdown).not.toBe(ascii);
      expect(markdown).not.toBe(grid);
      expect(markdown).not.toBe(compact);
      expect(ascii).not.toBe(grid);
    });
  });

  describe('Padding options', () => {
    it('should apply custom padding', () => {
      const headers = ['A'];
      const rows = [['1']];

      const noPadding = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        padding: 0,
      });

      const withPadding = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        padding: 3,
      });

      expect(noPadding).not.toBe(withPadding);
      expect(withPadding.length).toBeGreaterThan(noPadding.length);
    });
  });

  describe('MinWidth options', () => {
    it('should enforce minimum column width', () => {
      const headers = ['A'];
      const rows = [['1']];

      const withMinWidth = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        minWidth: 10,
      });

      const withoutMinWidth = tableFormatter.formatRaw(headers, rows, {
        style: 'markdown',
        minWidth: 1,
      });

      // Table with minWidth should be wider than without
      expect(withMinWidth.length).toBeGreaterThan(withoutMinWidth.length);
      expect(withMinWidth).toContain('A');
      expect(withMinWidth).toContain('1');
    });
  });
});
