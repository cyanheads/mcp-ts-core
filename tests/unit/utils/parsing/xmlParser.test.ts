/**
 * @fileoverview Tests for the XmlParser utility handling <think> blocks and errors.
 * @module tests/utils/parsing/xmlParser.test
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/internal/logger.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { XmlParser } from '../../../../src/utils/parsing/xmlParser.js';

describe('XmlParser', () => {
  const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('parses XML without a think block', async () => {
    const parser = new XmlParser();
    const xml = '<root><item>value</item></root>';

    const result = await parser.parse(xml);

    expect(result).toEqual({ root: { item: 'value' } });
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('parses XML and logs when a think block has content', async () => {
    const parser = new XmlParser();
    const xml = '<think> Reasoning notes </think><root><item>value</item></root>';

    const result = await parser.parse(xml);

    expect(result).toEqual({ root: { item: 'value' } });
    expect(debugSpy).toHaveBeenCalledWith(
      'LLM <think> block detected and logged.',
      expect.objectContaining({
        extra: expect.objectContaining({ thinkContent: 'Reasoning notes' }),
      }),
    );
  });

  it('parses XML and logs when a think block is empty', async () => {
    const parser = new XmlParser();
    const xml = '<think>   </think><root><item>value</item></root>';

    const result = await parser.parse(xml);

    expect(result).toEqual({ root: { item: 'value' } });
    expect(debugSpy).toHaveBeenCalledWith(
      'Empty LLM <think> block detected.',
      expect.objectContaining({ operation: 'XmlParser.thinkBlock' }),
    );
  });

  it('throws an McpError when XML is empty after trimming', async () => {
    const parser = new XmlParser();

    try {
      await parser.parse('   ');
      throw new Error('parse should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      if (error instanceof McpError) {
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.message).toBe(
          'XML string is empty after removing <think> block and trimming.',
        );
      }
    }
  });

  it('wraps parser errors in an McpError and logs details', async () => {
    const parser = new XmlParser();
    const marker = 'TAIL_MARKER_NOT_IN_DIAGNOSTIC';
    const xml = `<\n${'x'.repeat(400)} ${marker}`; // triggers fast-xml-parser failure

    const failure = (await parser.parse(xml).catch((error: unknown) => error)) as McpError;
    const cause = failure.cause as Error;

    expect(failure).toBeInstanceOf(McpError);
    expect(cause).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: `Failed to parse XML content: ${cause.message}`,
      data: { reason: 'xml_parse_failed' },
    });
    expect(JSON.stringify({ message: failure.message, data: failure.data })).not.toContain(marker);

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to parse XML content.',
      expect.objectContaining({
        extra: expect.objectContaining({
          errorDetails: expect.any(String),
          contentAttempted: xml.substring(0, 200),
        }),
      }),
    );
  });

  it("rejects XML nested beyond fast-xml-parser's own depth bound", async () => {
    const parser = new XmlParser();
    const nested = `${'<node>'.repeat(102)}value${'</node>'.repeat(102)}`;

    await expect(parser.parse(nested)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'xml_parse_failed' },
    });
  });

  it('does not expand document-defined entities', async () => {
    const parser = new XmlParser();
    const xml = '<!DOCTYPE root [<!ENTITY secret "expanded">]><root>&secret;</root>';

    await expect(parser.parse(xml)).resolves.toEqual({ root: '&secret;' });
  });
});
