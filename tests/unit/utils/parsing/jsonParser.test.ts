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
      toolName: 'test-json-parser',
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
      expect.objectContaining({ thinkContent: 'This is a thought.' }),
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

  it('should throw an McpError if the string is empty after removing the <think> block', async () => {
    const stringWithOnlyThinkBlock = '<think>some thoughts</think>';
    await expect(parser.parse(stringWithOnlyThinkBlock, Allow.ALL, context)).rejects.toThrow(
      McpError,
    );
    try {
      await parser.parse(stringWithOnlyThinkBlock, Allow.ALL, context);
    } catch (error) {
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcpError.message).toContain('JSON string is empty');
    }
  });

  it('should correctly parse an incomplete JSON object with a partial string value', async () => {
    const partialJson = '{"key": "value"';
    const result = await parser.parse(partialJson, Allow.ALL, context);
    expect(result).toEqual({ key: 'value' });
  });

  it('should throw an McpError if the string contains only whitespace after the <think> block', async () => {
    const stringWithWhitespace = '<think>thoughts</think>   ';
    try {
      await parser.parse(stringWithWhitespace, Allow.ALL, context);
      expect.unreachable('Expected McpError to be thrown');
    } catch (error) {
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcpError.message).toContain('JSON string is empty');
    }
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

  it('truncates the original content sample to 200 chars on long invalid input', async () => {
    const longInvalid = 'this is not json '.repeat(20); // > 200 chars, unparseable
    try {
      await parser.parse(longInvalid, Allow.ALL, context);
      throw new Error('Expected parser.parse to throw');
    } catch (error) {
      const sample = (error as McpError).data?.originalContentSample as string;
      expect(sample.endsWith('...')).toBe(true);
      expect(sample).toHaveLength(203); // 200 chars + ellipsis
    }
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

  it('should create a default context when none is provided', async () => {
    const jsonString = '{"test": "value"}';
    await expect(parser.parse(jsonString, Allow.ALL)).resolves.not.toThrow();
    const result = await parser.parse(jsonString, Allow.ALL);
    expect(result).toEqual({ test: 'value' });
  });

  it('provides a singleton instance that can parse JSON without explicit options', async () => {
    const result = await jsonParser.parse('{"singleton": true}');
    expect(result).toEqual({ singleton: true });
  });
});
