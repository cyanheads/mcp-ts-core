/**
 * @fileoverview Unit tests for the CSV parser utility.
 * @module tests/utils/parsing/csvParser.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { csvParser } from '@/utils/parsing/csvParser.js';

/** An unterminated quote: papaparse reports it in `errors` rather than throwing. */
const MALFORMED_CSV = 'name,age\n"Ada,36';

afterEach(() => {
  vi.restoreAllMocks();
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
      expect(mcpError.data).toEqual({ reason: 'parser_input_empty' });
    }
  });

  it('wraps parser errors into an McpError', async () => {
    const context = createContext();

    const failure = (await csvParser
      .parse(MALFORMED_CSV, undefined, context)
      .catch((error: unknown) => error)) as McpError;

    expect(failure).toBeInstanceOf(McpError);
    expect(failure.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(failure.message).toMatch(/^Failed to parse CSV: Quoted field unterminated/);
    expect(failure.data).toMatchObject({ reason: 'csv_parse_failed' });
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
  });

  it('logs parser errors with an auto-generated context when none is supplied', async () => {
    const errorSpy = vi.spyOn(logger, 'error');

    await expect(csvParser.parse(MALFORMED_CSV)).rejects.toThrow(McpError);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to parse CSV content.',
      expect.objectContaining({ operation: 'CsvParser.parseError' }),
    );
  });
});
