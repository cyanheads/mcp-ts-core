import type { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { frontmatterParser } from '@/utils/parsing/frontmatterParser.js';
import { HtmlExtractor } from '@/utils/parsing/htmlExtractor.js';
import { Allow, JsonParser } from '@/utils/parsing/jsonParser.js';
import { PdfParser } from '@/utils/parsing/pdfParser.js';
import { XmlParser } from '@/utils/parsing/xmlParser.js';
import { YamlParser } from '@/utils/parsing/yamlParser.js';

const dependencyCalls = vi.hoisted(() => ({
  defuddleModule: vi.fn(),
  linkedomModule: vi.fn(),
  partialJsonModule: vi.fn(),
  pdfLibModule: vi.fn(),
  unpdfModule: vi.fn(),
  xmlModule: vi.fn(),
  yamlModule: vi.fn(),
}));

vi.mock('partial-json', () => {
  dependencyCalls.partialJsonModule();
  return { parse: vi.fn() };
});

vi.mock('fast-xml-parser', () => {
  dependencyCalls.xmlModule();
  return { XMLParser: vi.fn() };
});

vi.mock('js-yaml', () => {
  dependencyCalls.yamlModule();
  return { load: vi.fn(), YAML11_SCHEMA: {} };
});

vi.mock('defuddle/node', () => {
  dependencyCalls.defuddleModule();
  return { Defuddle: vi.fn() };
});

vi.mock('linkedom', () => {
  dependencyCalls.linkedomModule();
  return { parseHTML: vi.fn() };
});

vi.mock('pdf-lib', () => {
  dependencyCalls.pdfLibModule();
  return { PDFDocument: { create: vi.fn(), load: vi.fn() } };
});

vi.mock('unpdf', () => {
  dependencyCalls.unpdfModule();
  return { extractText: vi.fn(), getDocumentProxy: vi.fn() };
});

describe('oversized parser inputs', () => {
  it('reject before loading or invoking optional parser dependencies', async () => {
    const json = new JsonParser().parse('{}', Allow.ALL, undefined, { maxBytes: 1 });
    const xml = new XmlParser().parse('<x/>', undefined, { maxBytes: 1 });
    const yaml = new YamlParser().parse('x: y', undefined, { maxBytes: 1 });
    const frontmatter = frontmatterParser.parse('---\nx: y\n---\nbody', undefined, {
      maxBytes: 1,
    });
    const html = new HtmlExtractor().extract('<article>x</article>', { maxBytes: 1 });

    const pdfParser = new PdfParser();
    const load = pdfParser.loadDocument(new Uint8Array(2), undefined, { maxBytes: 1 });
    const merge = pdfParser.mergePdfs([new Uint8Array(1), new Uint8Array(1)], undefined, {
      maxBytes: 1,
    });
    const split = pdfParser.splitPdf(new Uint8Array(2), [], undefined, { maxBytes: 1 });
    const extract = pdfParser.extractText(new Uint8Array(2), { maxBytes: 1 });
    const embedPng = vi.fn();
    const embed = pdfParser.embedImage({ embedPng } as unknown as PDFDocument, {
      format: 'png',
      imageBytes: new Uint8Array(2),
      maxBytes: 1,
    });

    for (const operation of [
      json,
      xml,
      yaml,
      frontmatter,
      html,
      load,
      merge,
      split,
      extract,
      embed,
    ]) {
      await expect(operation).rejects.toMatchObject({
        data: { reason: 'parser_input_too_large', limitBytes: 1 },
      });
    }

    expect(embedPng).not.toHaveBeenCalled();
    for (const dependency of Object.values(dependencyCalls)) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });
});
