import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { frontmatterParser } from '@/utils/parsing/frontmatterParser.js';
import { htmlExtractor } from '@/utils/parsing/htmlExtractor.js';
import {
  assertBinaryInputBudget,
  assertTextInputBudget,
  DEFAULT_BINARY_PARSER_MAX_BYTES,
  DEFAULT_TEXT_PARSER_MAX_BYTES,
  utf8ByteLength,
} from '@/utils/parsing/inputBudget.js';
import { Allow, jsonParser } from '@/utils/parsing/jsonParser.js';
import { pdfParser } from '@/utils/parsing/pdfParser.js';
import { xmlParser } from '@/utils/parsing/xmlParser.js';
import { yamlParser } from '@/utils/parsing/yamlParser.js';

const expectBudgetError = async (
  operation: Promise<unknown>,
  sizeBytes: number,
  limitBytes: number,
) => {
  const error = (await operation.catch((cause: unknown) => cause)) as McpError;
  expect(error).toBeInstanceOf(McpError);
  expect(error).toMatchObject({
    code: JsonRpcErrorCode.ValidationError,
    message: 'Parser input exceeds the maximum allowed byte size.',
    data: {
      reason: 'parser_input_too_large',
      sizeBytes,
      limitBytes,
    },
  });
  expect(JSON.stringify({ message: error.message, data: error.data })).not.toMatch(
    /SUPERSECRET|\/Users\/private|at parser/,
  );
};

describe('parser input budgets', () => {
  it('counts UTF-8 bytes, including multibyte and surrogate inputs', () => {
    const inputs = ['ascii', 'é', '漢字', '😀', '\ud800', 'a😀é漢'];
    const encoder = new TextEncoder();

    for (const input of inputs) {
      expect(utf8ByteLength(input)).toBe(encoder.encode(input).byteLength);
    }
  });

  it('accepts exact text and binary boundaries and rejects boundary + 1', () => {
    expect(assertTextInputBudget('é', { maxBytes: 2 })).toBe(2);
    expect(() => assertTextInputBudget('éx', { maxBytes: 2 })).toThrow(McpError);
    expect(assertBinaryInputBudget(new Uint8Array(2), { maxBytes: 2 })).toBe(2);
    expect(() => assertBinaryInputBudget(new Uint8Array(3), { maxBytes: 2 })).toThrow(McpError);
  });

  it('rejects invalid caller overrides without exposing their value', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertTextInputBudget('x', { maxBytes })).toThrowError(
        expect.objectContaining({
          data: {
            reason: 'parser_input_limit_invalid',
            limitBytes: DEFAULT_TEXT_PARSER_MAX_BYTES,
          },
        }),
      );
    }
  });

  it('lets a caller raise the budget above the default for known-large documents', () => {
    const oversized = 'x'.repeat(DEFAULT_TEXT_PARSER_MAX_BYTES + 1);
    expect(() => assertTextInputBudget(oversized)).toThrow(McpError);
    expect(assertTextInputBudget(oversized, { maxBytes: oversized.length })).toBe(oversized.length);

    const binary = new Uint8Array(DEFAULT_BINARY_PARSER_MAX_BYTES + 1);
    expect(() => assertBinaryInputBudget(binary)).toThrow(McpError);
    expect(assertBinaryInputBudget(binary, { maxBytes: binary.byteLength })).toBe(
      binary.byteLength,
    );
  });

  it('enforces the JSON budget before think-block stripping', async () => {
    const exact = '{"é":1}';
    const exactBytes = utf8ByteLength(exact);
    await expect(
      jsonParser.parse(exact, Allow.ALL, undefined, { maxBytes: exactBytes }),
    ).resolves.toEqual({ é: 1 });

    const oversized = `<think>SUPERSECRET at parser (/Users/private/json.ts:1:1)</think>${exact}`;
    await expectBudgetError(
      jsonParser.parse(oversized, Allow.ALL, undefined, { maxBytes: exactBytes }),
      utf8ByteLength(oversized),
      exactBytes,
    );
  });

  it('enforces exact and boundary + 1 limits for XML and YAML', async () => {
    const xml = '<root>é</root>';
    const xmlBytes = utf8ByteLength(xml);
    await expect(xmlParser.parse(xml, undefined, { maxBytes: xmlBytes })).resolves.toEqual({
      root: 'é',
    });
    await expectBudgetError(
      xmlParser.parse(`${xml} `, undefined, { maxBytes: xmlBytes }),
      xmlBytes + 1,
      xmlBytes,
    );

    const yaml = 'key: é';
    const yamlBytes = utf8ByteLength(yaml);
    await expect(yamlParser.parse(yaml, undefined, { maxBytes: yamlBytes })).resolves.toEqual({
      key: 'é',
    });
    await expectBudgetError(
      yamlParser.parse(`${yaml}\n`, undefined, { maxBytes: yamlBytes }),
      yamlBytes + 1,
      yamlBytes,
    );
  });

  it('budgets the complete frontmatter document before extraction', async () => {
    const markdown = '---\nkey: é\n---\nbody';
    const sizeBytes = utf8ByteLength(markdown);
    await expect(
      frontmatterParser.parse(markdown, undefined, { maxBytes: sizeBytes }),
    ).resolves.toMatchObject({ frontmatter: { key: 'é' }, content: 'body' });

    await expectBudgetError(
      frontmatterParser.parse(`${markdown}x`, undefined, { maxBytes: sizeBytes }),
      sizeBytes + 1,
      sizeBytes,
    );
  });

  it('budgets complete HTML before DOM construction', async () => {
    const html = '<html><body><article><h1>é</h1><p>body text</p></article></body></html>';
    const sizeBytes = utf8ByteLength(html);
    await expect(htmlExtractor.extract(html, { maxBytes: sizeBytes })).resolves.toEqual(
      expect.objectContaining({ content: expect.any(String) }),
    );

    await expectBudgetError(
      htmlExtractor.extract(`${html} `, { maxBytes: sizeBytes }),
      sizeBytes + 1,
      sizeBytes,
    );
  });

  it('budgets Uint8Array and ArrayBuffer PDF inputs at exact and boundary + 1 sizes', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    const bytes = await source.save();
    await expect(
      pdfParser.loadDocument(bytes, undefined, { maxBytes: bytes.byteLength }),
    ).resolves.toBeInstanceOf(PDFDocument);

    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes);
    await expectBudgetError(
      pdfParser.loadDocument(padded.buffer, undefined, { maxBytes: bytes.byteLength }),
      padded.byteLength,
      bytes.byteLength,
    );
  });
});
