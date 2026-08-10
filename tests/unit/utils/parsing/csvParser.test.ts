/**
 * @fileoverview Unit tests for the CSV parser utility.
 * @module tests/utils/parsing/csvParser.test
 */

import type { ParseError, ParseResult } from 'papaparse';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { csvParser } from '@/utils/parsing/csvParser.js';

// vi.hoisted runs before vi.mock hoisting, making mockParse available in the factory.
const { mockParse } = vi.hoisted(() => ({
  mockParse: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realParseFn: any;

vi.mock('papaparse', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await importOriginal()) as any;
  const realModule = actual.default ?? actual;
  realParseFn = realModule.parse.bind(realModule);
  mockParse.mockImplementation(realParseFn);
  return {
    ...actual,
    default: {
      ...realModule,
      parse: mockParse,
    },
  };
});

beforeAll(async () => {
  // Resolve the lazy peer mock before any test installs a per-case parser
  // implementation. Otherwise a shuffled first test can have the async mock
  // factory overwrite its implementation with the real parser.
  await import('papaparse');
});

beforeEach(() => {
  mockParse.mockImplementation(realParseFn);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockParse.mockImplementation(realParseFn);
});

describe('csvParser.parse', () => {
  const createContext = () =>
    requestContextService.createRequestContext({
      operation: 'csv-parser-test',
    });

  it('parses a basic CSV string with headers', async () => {
    const csv = 'name,age\nAda,36\nGrace,45';
    const result = await csvParser.parse<{ name: string; age: string }>(csv, {
      header: true,
    });

    expect(result.data).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '45' },
    ]);
  });

  it('strips a <think> block before parsing and logs through provided context', async () => {
    const context = createContext();
    const csv = '<think>pre-computation</think>name,age\nAda,36';
    const result = await csvParser.parse<{ name: string; age: string }>(
      csv,
      { header: true },
      context,
    );

    expect(result.data).toEqual([{ name: 'Ada', age: '36' }]);
  });

  it('throws when the CSV content is empty after removing the think block', async () => {
    try {
      await csvParser.parse('<think>thoughts</think>   ');
      throw new Error('Expected csvParser.parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcpError.message).toContain('CSV string is empty');
    }
  });

  it('wraps parser errors into an McpError', async () => {
    const context = createContext();
    const parserError: ParseError = {
      type: 'Quotes',
      code: 'MissingQuotes',
      message: 'Mismatched quotes',
    };

    const parseResult: ParseResult<unknown> = {
      data: [],
      errors: [parserError],
      meta: {
        delimiter: ',',
        linebreak: '\n',
        aborted: false,
        truncated: false,
        cursor: 0,
      },
    };

    mockParse.mockImplementation(() => parseResult as never);

    try {
      await csvParser.parse('name,age\n"Ada,36', undefined, context);
      throw new Error('Expected csvParser.parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcpError.message).toContain('Failed to parse CSV');
      expect(mcpError.data).toMatchObject({ errors: [parserError] });
    }
  });

  it('logs an empty think block and auto-creates a context when none is supplied', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const csv = '<think>   </think>name,age\nAda,36';

    const result = await csvParser.parse<{ name: string; age: string }>(csv, {
      header: true,
    });

    expect(result.data).toEqual([{ name: 'Ada', age: '36' }]);
    expect(debugSpy).toHaveBeenCalledWith(
      'Empty LLM <think> block detected.',
      expect.objectContaining({ operation: 'CsvParser.thinkBlock' }),
    );

    debugSpy.mockRestore();
  });

  it('logs parser errors with an auto-generated context when none is supplied', async () => {
    const parserError: ParseError = {
      type: 'Quotes',
      code: 'MissingQuotes',
      message: 'Mismatched quotes',
    };

    const parseResult: ParseResult<unknown> = {
      data: [],
      errors: [parserError],
      meta: {
        delimiter: ',',
        linebreak: '\n',
        aborted: false,
        truncated: false,
        cursor: 0,
      },
    };

    mockParse.mockImplementation(() => parseResult as never);

    const errorSpy = vi.spyOn(logger, 'error');

    await expect(csvParser.parse('name,age\n"Ada,36')).rejects.toThrow(McpError);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to parse CSV content.',
      expect.objectContaining({ operation: 'CsvParser.parseError' }),
    );

    errorSpy.mockRestore();
  });
});
