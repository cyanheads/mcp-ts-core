/**
 * @fileoverview Boundary and failure-shape tests for PdfParser.
 * @module tests/unit/utils/parsing/pdfParser.branches.test
 */

import { PDFDocument, type PDFImage } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { PdfParser } from '@/utils/parsing/pdfParser.js';

describe('PdfParser branch boundaries', () => {
  const context = requestContextService.createRequestContext({ operation: 'pdf-branches' });
  let parser: PdfParser;

  beforeEach(() => {
    parser = new PdfParser();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads a real ArrayBuffer and reports its byteLength', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    const bytes = await source.save();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const debug = vi.spyOn(logger, 'debug');

    const loaded = await parser.loadDocument(buffer, context);

    expect(loaded.getPageCount()).toBe(1);
    expect(debug).toHaveBeenCalledWith(
      'Loading PDF document from bytes.',
      expect.objectContaining({
        extra: expect.objectContaining({ byteLength: buffer.byteLength }),
      }),
    );
  });

  it('routes jpg inputs to embedJpg', async () => {
    const embedded = { width: 1, height: 1 } as PDFImage;
    const embedPng = vi.fn();
    const embedJpg = vi.fn().mockResolvedValue(embedded);
    const doc = { embedPng, embedJpg } as unknown as PDFDocument;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    await expect(
      parser.embedImage(doc, { imageBytes: bytes, format: 'jpg' }, context),
    ).resolves.toBe(embedded);
    expect(embedJpg).toHaveBeenCalledWith(bytes);
    expect(embedPng).not.toHaveBeenCalled();
  });

  it('wraps an oversized first word with the page default font', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const drawText = vi.spyOn(page, 'drawText');

    await parser.drawText(page, {
      text: 'supercalifragilisticexpialidocious',
      x: 10,
      y: 180,
      maxWidth: 1,
    });

    expect(drawText).toHaveBeenCalledOnce();
    expect(drawText).toHaveBeenCalledWith(
      'supercalifragilisticexpialidocious',
      expect.objectContaining({ x: 10, y: 180 }),
    );
  });

  it('draws no wrapped line for empty text', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const drawText = vi.spyOn(page, 'drawText');

    await parser.drawText(page, { text: '', x: 10, y: 180, maxWidth: 100 });

    expect(drawText).not.toHaveBeenCalled();
  });

  it('skips falsy merge entries while preserving valid documents', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    const bytes = await source.save();

    const merged = await parser.mergePdfs(
      [undefined, bytes] as unknown as Array<Uint8Array | ArrayBuffer>,
      context,
    );

    expect(merged.getPageCount()).toBe(1);
  });

  it('ignores form fields that do not implement the operation for their value type', () => {
    const checkOnly = { check: vi.fn() };
    const uncheckOnly = { uncheck: vi.fn() };
    const fields = new Map<string, object>([
      ['text', {}],
      ['trueWithoutCheckbox', {}],
      ['number', {}],
      ['falseCheckOnly', checkOnly],
      ['trueUncheckOnly', uncheckOnly],
    ]);
    const form = {
      flatten: vi.fn(),
      getField: vi.fn((name: string) => fields.get(name) ?? {}),
    };
    const doc = { getForm: () => form } as unknown as PDFDocument;

    expect(() =>
      parser.fillForm(
        doc,
        {
          fields: {
            text: 'value',
            trueWithoutCheckbox: true,
            number: 42,
            falseCheckOnly: false,
            trueUncheckOnly: true,
          },
        },
        context,
      ),
    ).not.toThrow();

    expect(checkOnly.check).not.toHaveBeenCalled();
    expect(uncheckOnly.uncheck).not.toHaveBeenCalled();
    expect(form.flatten).not.toHaveBeenCalled();
  });

  it('logs non-Error field failures and continues filling', () => {
    const warning = vi.spyOn(logger, 'warning');
    const form = {
      flatten: vi.fn(),
      getField: () => {
        throw 'field lookup failed';
      },
    };
    const doc = { getForm: () => form } as unknown as PDFDocument;

    expect(() => parser.fillForm(doc, { fields: { missing: 'value' } }, context)).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      'Failed to fill form field.',
      expect.objectContaining({
        extra: expect.objectContaining({ fieldName: 'missing', fieldError: 'field lookup failed' }),
      }),
    );
  });

  it('wraps a non-Error form access failure', () => {
    const doc = {
      getForm: () => {
        throw 'form access failed';
      },
    } as unknown as PDFDocument;

    expect(() => parser.fillForm(doc, { fields: {} }, context)).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.InternalError,
        message: 'Failed to fill PDF form: form access failed',
        data: { reason: 'pdf_form_fill_failed' },
      }),
    );
  });

  it('omits every optional metadata field when the document has none', () => {
    const doc = {
      getAuthor: () => undefined,
      getCreationDate: () => undefined,
      getCreator: () => undefined,
      getKeywords: () => undefined,
      getModificationDate: () => undefined,
      getPageCount: () => 2,
      getProducer: () => undefined,
      getSubject: () => undefined,
      getTitle: () => undefined,
    } as unknown as PDFDocument;

    expect(parser.extractMetadata(doc)).toEqual({ pageCount: 2 });
  });

  it('normalizes non-Error create failures into McpError', async () => {
    vi.spyOn(PDFDocument, 'create').mockRejectedValueOnce('creation rejected');

    await expect(parser.createDocument(context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to create PDF document: creation rejected',
      data: { reason: 'pdf_create_failed' },
    });
  });

  it('normalizes non-Error load failures into validation errors', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce('load rejected');

    await expect(parser.loadDocument(new Uint8Array(), context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to load PDF document: load rejected',
      data: { reason: 'pdf_load_failed' },
    });
  });

  it('normalizes non-Error font and image failures', async () => {
    const doc = {
      embedFont: vi.fn().mockRejectedValue('font rejected'),
      embedJpg: vi.fn().mockRejectedValue('image rejected'),
    } as unknown as PDFDocument;

    await expect(parser.embedFont(doc, 'Helvetica', context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to embed PDF font: font rejected',
      data: { reason: 'pdf_font_embed_failed' },
    });
    await expect(
      parser.embedImage(doc, { format: 'jpg', imageBytes: new Uint8Array([0xff, 0xd8]) }, context),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to embed PDF image: image rejected',
      data: { reason: 'pdf_image_embed_failed' },
    });
  });

  it('normalizes non-Error merge and split failures', async () => {
    vi.spyOn(PDFDocument, 'create').mockRejectedValueOnce('merge rejected');
    await expect(parser.mergePdfs([], context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to merge PDF documents: merge rejected',
      data: { reason: 'pdf_merge_failed' },
    });

    // A source that fails to load is the caller's input, as it is for loadDocument.
    vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce('split rejected');
    await expect(parser.splitPdf(new Uint8Array(), [], context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to split PDF document: split rejected',
      data: { reason: 'pdf_split_failed' },
    });
  });

  it('normalizes non-Error extract and save failures', async () => {
    const doc = {
      save: vi.fn().mockRejectedValue('save rejected'),
    } as unknown as PDFDocument;

    await expect(parser.extractText(doc, undefined, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to extract text from PDF: save rejected',
      data: { reason: 'pdf_text_extract_failed' },
    });
    await expect(parser.saveDocument(doc, context)).rejects.toBeInstanceOf(McpError);
    await expect(parser.saveDocument(doc, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to save PDF document: save rejected',
      data: { reason: 'pdf_save_failed' },
    });
  });

  it('classifies bytes pdf.js cannot read as a text-extraction failure', async () => {
    const failure = (await parser
      .extractText(new Uint8Array([1, 2, 3, 4]), undefined, context)
      .catch((error: unknown) => error)) as McpError;

    expect(failure).toBeInstanceOf(McpError);
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to extract text from PDF: Invalid PDF structure.',
      data: { reason: 'pdf_text_extract_failed' },
    });
  });

  describe('unreadable input PDFs', () => {
    const encode = (text: string) => new TextEncoder().encode(text);

    /** Serializes numbered objects plus a classic xref table and trailer. */
    const buildPdf = (objects: string[], trailerExtra = ''): Uint8Array => {
      let body = '%PDF-1.4\n';
      const offsets = objects.map((object, index) => {
        const offset = body.length;
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
        return offset;
      });
      const xrefOffset = body.length;
      body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
      body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\n`;
      body += `startxref\n${xrefOffset}\n%%EOF\n`;
      return encode(body);
    };

    const notADocument = () => encode('%PDF-1.4\nnot a document\n%%EOF\n');
    const headerOnly = () => encode('%PDF-1.7\n');
    const html = () => encode('<!doctype html><p>404</p>');
    const rootNotCatalog = () => buildPdf(['<< /Type /Pages /Kids [] /Count 0 >>']);
    const encrypted = () =>
      buildPdf(
        [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [] /Count 0 >>',
          `<< /Filter /Standard /V 1 /R 2 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> /P -4 >>`,
        ],
        `/Encrypt 3 0 R /ID [<${'33'.repeat(16)}> <${'33'.repeat(16)}>]`,
      );

    it.each([
      ['a header with no document', notADocument, 'Invalid PDF structure.'],
      [
        'an empty body',
        () => new Uint8Array(0),
        'The PDF file is empty, i.e. its size is zero bytes.',
      ],
      ['an HTML page', html, 'Invalid PDF structure.'],
      ['a bare header', headerOnly, 'Invalid PDF structure.'],
      ['a trailer /Root that is not a catalog', rootNotCatalog, 'Invalid Root reference.'],
      ['an encrypted document with no password', encrypted, 'No password given'],
    ])('extractText fails %s as ValidationError', async (_label, bytes, diagnostic) => {
      await expect(parser.extractText(bytes(), undefined, context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: `Failed to extract text from PDF: ${diagnostic}`,
        data: { reason: 'pdf_text_extract_failed' },
      });
    });

    const loaders = [
      ['loadDocument', 'Failed to load PDF document', 'pdf_load_failed'],
      ['mergePdfs', 'Failed to merge PDF documents', 'pdf_merge_failed'],
      ['splitPdf', 'Failed to split PDF document', 'pdf_split_failed'],
    ] as const;
    const load = (method: (typeof loaders)[number][0], bytes: Uint8Array) => {
      if (method === 'loadDocument') return parser.loadDocument(bytes, context);
      if (method === 'mergePdfs') return parser.mergePdfs([bytes], context);
      return parser.splitPdf(bytes, [{ start: 0, end: 0 }], context);
    };

    describe.each(loaders)('%s', (method, summary, reason) => {
      it.each([
        ['a header with no document', notADocument],
        ['a bare header', headerOnly],
        ['a trailer /Root that is not a catalog', rootNotCatalog],
      ])('rejects %s as ValidationError instead of loading it', async (_label, bytes) => {
        await expect(load(method, bytes())).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: `${summary}: No document catalog found; the trailer /Root is missing or is not a /Type /Catalog dictionary.`,
          data: { reason },
        });
      });

      it('fails bytes with no PDF header as ValidationError', async () => {
        await expect(load(method, html())).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: `${summary}: Failed to parse PDF document (line:0 col:50 offset=25): No PDF header found`,
          data: { reason },
        });
      });

      it('fails an encrypted document as ValidationError', async () => {
        await expect(load(method, encrypted())).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining(
            `${summary}: Input document to \`PDFDocument.load\` is encrypted.`,
          ),
          data: { reason },
        });
      });
    });
  });

  describe('splitPdf page ranges', () => {
    const pagesOf = async (count: number) => {
      const source = await PDFDocument.create();
      for (let i = 0; i < count; i++) source.addPage();
      // pdf-lib's save() otherwise gives an empty document one blank page.
      return source.save({ addDefaultPage: false });
    };
    const invalid = (range: string, pageCount: number) =>
      `Failed to split PDF document: ${range} is not a valid page range for a ${pageCount}-page document; start and end must be integers with 0 <= start <= end <= ${pageCount - 1}.`;

    it.each([
      ['an end past the last page', { start: 0, end: 3 }, '{ start: 0, end: 3 }'],
      ['a start past the last page', { start: 3, end: 3 }, '{ start: 3, end: 3 }'],
      ['a negative start', { start: -1, end: 1 }, '{ start: -1, end: 1 }'],
      ['a start after its end', { start: 2, end: 1 }, '{ start: 2, end: 1 }'],
      ['a fractional index', { start: 0.5, end: 1 }, '{ start: 0.5, end: 1 }'],
    ])('rejects %s as ValidationError naming the range', async (_label, range, rendered) => {
      const bytes = await pagesOf(3);

      await expect(parser.splitPdf(bytes, [range], context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: invalid(`ranges[0] ${rendered}`, 3),
        data: { reason: 'pdf_split_failed' },
      });
    });

    it('rejects a huge end before creating or copying any page', async () => {
      const bytes = await pagesOf(3);
      const create = vi.spyOn(PDFDocument, 'create');
      const copyPages = vi.spyOn(PDFDocument.prototype, 'copyPages');

      await expect(
        parser.splitPdf(bytes, [{ start: 0, end: 3_000_000 }], context),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: invalid('ranges[0] { start: 0, end: 3000000 }', 3),
        data: { reason: 'pdf_split_failed' },
      });
      expect(create).not.toHaveBeenCalled();
      expect(copyPages).not.toHaveBeenCalled();
    });

    it('checks every range before splitting any, naming the first invalid one', async () => {
      const bytes = await pagesOf(3);
      const create = vi.spyOn(PDFDocument, 'create');

      await expect(
        parser.splitPdf(
          bytes,
          [
            { start: 0, end: 1 },
            { start: 1, end: 5 },
          ],
          context,
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: invalid('ranges[1] { start: 1, end: 5 }', 3),
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('rejects any range on a document with no pages', async () => {
      const bytes = await pagesOf(0);

      await expect(parser.splitPdf(bytes, [{ start: 0, end: 0 }], context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message:
          'Failed to split PDF document: ranges[0] { start: 0, end: 0 } is not a valid page range for a 0-page document; the document has no pages.',
        data: { reason: 'pdf_split_failed' },
      });
    });

    it('accepts ranges that touch the first and last page', async () => {
      const bytes = await pagesOf(3);

      const parts = await parser.splitPdf(
        bytes,
        [
          { start: 0, end: 0 },
          { start: 2, end: 2 },
          { start: 0, end: 2 },
        ],
        context,
      );

      expect(parts.map((part) => part.getPageCount())).toEqual([1, 1, 3]);
    });
  });

  it('carries the library diagnostic in the message and keeps the stack out of data', async () => {
    const libraryFailure = new Error('Cannot serialize an encrypted document');
    Object.defineProperty(libraryFailure, 'stack', {
      value:
        'Error: Cannot serialize an encrypted document\n    at save (/Users/example/pdf.ts:1:1)',
    });
    const doc = {
      save: vi.fn().mockRejectedValue(libraryFailure),
    } as unknown as PDFDocument;

    const failure = (await parser
      .saveDocument(doc, context)
      .catch((error: unknown) => error)) as McpError;
    const publicError = JSON.stringify({ message: failure.message, data: failure.data });

    expect(failure.message).toBe(
      'Failed to save PDF document: Cannot serialize an encrypted document',
    );
    expect(publicError).not.toContain('/Users/example/pdf.ts');
    expect(publicError).not.toContain('    at save');
    expect(failure.data).toEqual({ reason: 'pdf_save_failed' });
    expect(failure.cause).toBe(libraryFailure);
  });

  it('surfaces an already-classified failure instead of relabelling it (#306)', async () => {
    // The lazy imports raise ConfigurationError with the install command for a
    // missing peer dependency. Rewrapping it as a PDF failure would strip both
    // the code a caller branches on and the remediation it carries.
    const missingPeer = new McpError(
      JsonRpcErrorCode.ConfigurationError,
      'Install "pdf-lib" to use PDF generation: bun add pdf-lib',
    );
    const doc = {
      save: vi.fn().mockRejectedValue(missingPeer),
    } as unknown as PDFDocument;

    await expect(parser.saveDocument(doc, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: 'Install "pdf-lib" to use PDF generation: bun add pdf-lib',
    });
  });
});
