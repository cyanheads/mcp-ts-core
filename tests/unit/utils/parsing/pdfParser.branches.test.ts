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
      expect.objectContaining({ byteLength: buffer.byteLength }),
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
      expect.objectContaining({ fieldName: 'missing', fieldError: 'field lookup failed' }),
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
    });
  });

  it('normalizes non-Error load failures into validation errors', async () => {
    vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce('load rejected');

    await expect(parser.loadDocument(new Uint8Array(), context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to load PDF document: load rejected',
    });
  });

  it('normalizes non-Error font and image failures', async () => {
    const doc = {
      embedFont: vi.fn().mockRejectedValue('font rejected'),
      embedJpg: vi.fn().mockRejectedValue('image rejected'),
    } as unknown as PDFDocument;

    await expect(parser.embedFont(doc, 'Helvetica', context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: "Failed to embed font 'Helvetica': font rejected",
    });
    await expect(
      parser.embedImage(doc, { format: 'jpg', imageBytes: new Uint8Array([0xff, 0xd8]) }, context),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to embed jpg image: image rejected',
    });
  });

  it('normalizes non-Error merge and split failures', async () => {
    vi.spyOn(PDFDocument, 'create').mockRejectedValueOnce('merge rejected');
    await expect(parser.mergePdfs([], context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to merge PDFs: merge rejected',
    });

    vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce('split rejected');
    await expect(parser.splitPdf(new Uint8Array(), [], context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to split PDF: split rejected',
    });
  });

  it('normalizes non-Error extract and save failures', async () => {
    const doc = {
      save: vi.fn().mockRejectedValue('save rejected'),
    } as unknown as PDFDocument;

    await expect(parser.extractText(doc, undefined, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to extract text: save rejected',
    });
    await expect(parser.saveDocument(doc, context)).rejects.toBeInstanceOf(McpError);
    await expect(parser.saveDocument(doc, context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to save PDF document: save rejected',
    });
  });
});
