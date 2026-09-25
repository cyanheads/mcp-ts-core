/**
 * @fileoverview Tests for the JsonParser utility.
 * @module tests/utils/parsing/jsonParser.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { Allow, JsonParser, jsonParser } from '../../../../src/utils/parsing/jsonParser.js';

describe('JsonParser', () => {
  let parser: JsonParser;
  let context: ReturnType<typeof requestContextService.createRequestContext>;

  beforeEach(() => {
    parser = new JsonParser();
    context = requestContextService.createRequestContext({
      additionalContext: { toolName: 'test-json-parser' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should parse a valid, complete JSON string', async () => {
    const jsonString = '{"key": "value", "number": 123}';
    const result = await parser.parse(jsonString, Allow.ALL, context);
    expect(result).toEqual({ key: 'value', number: 123 });
  });

  it('should parse a partial JSON object string, stopping at the last valid token', async () => {
    const partialJsonString = '{"key": "value", "number": 12';
    const result = await parser.parse(partialJsonString, Allow.OBJ, context);
    expect(result).toEqual({ key: 'value' });
  });

  it('should parse a partial JSON array string', async () => {
    const partialJsonString = '["a", "b", 1,';
    const result = await parser.parse(partialJsonString, Allow.ARR, context);
    expect(result).toEqual(['a', 'b', 1]);
  });

  it('should handle a <think> block and parse the remaining JSON', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    const stringWithThinkBlock = '<think>This is a thought.</think>  {"key": "value"}';
    const result = await parser.parse(stringWithThinkBlock, Allow.ALL, context);
    expect(result).toEqual({ key: 'value' });
    expect(debugSpy).toHaveBeenCalledWith(
      'LLM <think> block detected and logged.',
      expect.objectContaining({
        extra: expect.objectContaining({ thinkContent: 'This is a thought.' }),
      }),
    );
  });

  it('should handle an empty <think> block and log it', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    const stringWithEmptyThinkBlock = '<think></think>{"key": "value"}';
    const result = await parser.parse(stringWithEmptyThinkBlock, Allow.ALL, context);
    expect(result).toEqual({ key: 'value' });
    expect(debugSpy).toHaveBeenCalledWith('Empty LLM <think> block detected.', expect.any(Object));
  });

  it('should create its own context for logging if none is provided', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    const stringWithThinkBlock = '<think>No context here.</think>{"key": "value"}';
    await parser.parse(stringWithThinkBlock);
    expect(debugSpy).toHaveBeenCalledWith(
      'LLM <think> block detected and logged.',
      expect.objectContaining({ operation: 'JsonParser.thinkBlock' }),
    );
  });

  it.each([
    ['nothing', '<think>some thoughts</think>'],
    ['only whitespace', '<think>thoughts</think>   '],
  ])('should throw an McpError when %s follows the <think> block', async (_label, input) => {
    const error = await parser.parse(input, Allow.ALL, context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((error as McpError).message).toContain('JSON string is empty');
  });

  it('should handle leading/trailing whitespace in the JSON string', async () => {
    const jsonWithWhitespace = '  {"key": "value"}  ';
    const result = await parser.parse(jsonWithWhitespace, Allow.ALL, context);
    expect(result).toEqual({ key: 'value' });
  });

  it('should wrap a parsing error in McpError and log it', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const invalidJson = 'this is not json'; // Unambiguously invalid JSON
    await expect(parser.parse(invalidJson, Allow.ALL, context)).rejects.toThrow(McpError);
    try {
      await parser.parse(invalidJson, Allow.ALL, context);
    } catch (error) {
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcpError.message).toContain('Failed to parse JSON');
      expect(errorSpy).toHaveBeenCalledWith('Failed to parse JSON content.', expect.any(Object));
    }
  });

  it('carries the parser diagnostic in the message and keeps the sample and stack out of data', async () => {
    const marker = 'TAIL_MARKER_NOT_IN_DIAGNOSTIC';
    const failure = (await parser
      .parse(`not-json ${'x'.repeat(400)} ${marker}`, Allow.ALL, context)
      .catch((error: unknown) => error)) as McpError;
    const cause = failure.cause as Error;

    expect(cause).toBeInstanceOf(Error);
    expect(failure.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(failure.message).toBe(`Failed to parse JSON content: ${cause.message}`);
    expect(failure.data).toEqual({ reason: 'json_parse_failed' });
    expect(JSON.stringify({ message: failure.message, data: failure.data })).not.toContain(marker);
  });

  it('logs parse failures with an auto-created context when none is provided', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      await parser.parse('still invalid json');
      throw new Error('Expected parser.parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
    }
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to parse JSON content.',
      expect.objectContaining({ operation: 'JsonParser.parseError' }),
    );
    errorSpy.mockRestore();
  });

  it('provides a singleton instance that can parse JSON without explicit options', async () => {
    const result = await jsonParser.parse('{"singleton": true}');
    expect(result).toEqual({ singleton: true });
  });
});
