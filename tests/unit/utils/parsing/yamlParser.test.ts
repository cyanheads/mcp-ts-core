/**
 * @fileoverview Unit tests for the YAML parser utility.
 * @module tests/utils/parsing/yamlParser.test
 */
import { describe, expect, it, vi } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { yamlParser } from '@/utils/parsing/yamlParser.js';

describe('yamlParser.parse', () => {
  const createContext = () =>
    requestContextService.createRequestContext({
      operation: 'yaml-parser-test',
    });

  it('parses YAML content successfully', async () => {
    const yamlString = 'name: Ada\nrole: Engineer';
    const result = await yamlParser.parse<Record<string, string>>(yamlString);
    expect(result).toEqual({ name: 'Ada', role: 'Engineer' });
  });

  it('parses YAML content after stripping a think block', async () => {
    const context = createContext();
    const yamlString = '<think>deliberation</think>name: Grace\nrole: Admiral';
    const result = await yamlParser.parse<Record<string, string>>(yamlString, context);
    expect(result).toEqual({ name: 'Grace', role: 'Admiral' });
  });

  it('throws when the remaining content is empty', async () => {
    await expect(yamlParser.parse('<think>only thoughts</think>   ')).rejects.toThrow(McpError);
  });

  it('wraps parser failures in an McpError', async () => {
    const context = createContext();
    try {
      await yamlParser.parse('invalid: [unterminated', context);
      throw new Error('Expected yamlParser.parse to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcpError.message).toContain('Failed to parse YAML');
    }
  });

  it('carries the parser diagnostic in the message and keeps the sample and stack out of data', async () => {
    const marker = 'TAIL_MARKER_NOT_IN_DIAGNOSTIC';
    const document = [
      `first: ${marker}`,
      'second: ok',
      'third: ok',
      'fourth: ok',
      'bad: [unterminated',
    ].join('\n');
    const failure = (await yamlParser.parse(document).catch((error: unknown) => error)) as McpError;
    const cause = failure.cause as Error;

    expect(cause).toBeInstanceOf(Error);
    expect(failure.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(failure.message).toBe(`Failed to parse YAML content: ${cause.message}`);
    expect(failure.data).toEqual({ reason: 'yaml_parse_failed' });
    expect(JSON.stringify({ message: failure.message, data: failure.data })).not.toContain(marker);
  });

  it('logs parse failures with an auto-generated context when none is provided', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    await expect(yamlParser.parse('invalid: [unterminated')).rejects.toThrow(McpError);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to parse YAML content.',
      expect.objectContaining({ operation: 'YamlParser.parseError' }),
    );
    errorSpy.mockRestore();
  });

  it('logs an empty think block with an auto-generated context when none is provided', async () => {
    const debugSpy = vi.spyOn(logger, 'debug');
    const yamlString = '<think></think>key: value';

    const result = await yamlParser.parse<Record<string, string>>(yamlString);

    expect(result).toEqual({ key: 'value' });
    expect(debugSpy).toHaveBeenCalledWith(
      'Empty LLM <think> block detected.',
      expect.objectContaining({ operation: 'YamlParser.thinkBlock' }),
    );

    debugSpy.mockRestore();
  });

  it('applies YAML 1.1 schema semantics (yes/no → boolean) via YAML11_SCHEMA', async () => {
    const result = await yamlParser.parse<Record<string, boolean>>('enabled: yes\ndisabled: no');
    expect(result).toEqual({ enabled: true, disabled: false });
  });
});
