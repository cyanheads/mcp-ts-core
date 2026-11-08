/**
 * @fileoverview PDF text extraction against a stubbed `unpdf`: how the
 * decoded-image ceiling reaches pdf.js (absent unless the caller asks for one),
 * that the document opened for extraction is destroyed whether extraction
 * resolves or rejects, and how failures that are not unreadable input stay
 * `InternalError` while a missing `unpdf` peer keeps its `ConfigurationError`.
 * @module tests/utils/parsing/pdfParser.imageCap.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { destroyMock, extractTextMock, getDocumentProxyMock } = vi.hoisted(() => ({
  destroyMock: vi.fn(),
  extractTextMock: vi.fn(),
  getDocumentProxyMock: vi.fn(),
}));

vi.mock('unpdf', () => ({
  extractText: extractTextMock,
  getDocumentProxy: getDocumentProxyMock,
}));

import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { PdfParser } from '@/utils/parsing/pdfParser.js';

const parser = new PdfParser();
const bytes = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.clearAllMocks();
  destroyMock.mockResolvedValue(undefined);
  // pdf.js 6's shape: `destroy()` lives on the loading task, and the proxy has none of its own.
  getDocumentProxyMock.mockResolvedValue({ loadingTask: { destroy: destroyMock } });
  extractTextMock.mockResolvedValue({ totalPages: 1, text: ['page'] });
});

describe('PdfParser.extractText document lifecycle', () => {
  it('destroys the document once after a successful extraction, after the text pass', async () => {
    await expect(parser.extractText(bytes, { mergePages: true })).resolves.toEqual({
      totalPages: 1,
      text: ['page'],
    });
    expect(destroyMock).toHaveBeenCalledOnce();
    expect(destroyMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      extractTextMock.mock.invocationCallOrder[0] as number,
    );
  });

  it.each([
    [
      'an unreadable-input name',
      Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }),
      JsonRpcErrorCode.ValidationError,
    ],
    [
      'any other failure',
      new TypeError('pdf.getPage is not a function'),
      JsonRpcErrorCode.InternalError,
    ],
  ])(
    'destroys the document once when the text pass rejects with %s, keeping its classification',
    async (_label, failure, code) => {
      extractTextMock.mockRejectedValueOnce(failure);

      await expect(parser.extractText(bytes)).rejects.toMatchObject({
        code,
        message: `Failed to extract text from PDF: ${failure.message}`,
        data: { reason: 'pdf_text_extract_failed' },
      });
      expect(destroyMock).toHaveBeenCalledOnce();
    },
  );

  it('fails as InternalError when destroying the document rejects after the text pass', async () => {
    destroyMock.mockRejectedValueOnce(new Error('worker already terminated'));

    await expect(parser.extractText(bytes)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to extract text from PDF: worker already terminated',
      data: { reason: 'pdf_text_extract_failed' },
    });
  });

  it("keeps the text pass's failure and classification when destroying the document also rejects", async () => {
    extractTextMock.mockRejectedValueOnce(
      Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }),
    );
    destroyMock.mockRejectedValueOnce(new Error('worker already terminated'));

    await expect(parser.extractText(bytes)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to extract text from PDF: Invalid PDF structure.',
      data: { reason: 'pdf_text_extract_failed' },
    });
    expect(destroyMock).toHaveBeenCalledOnce();
  });
});

describe('PdfParser.extractText decoded-image ceiling', () => {
  it('forwards no ceiling when the caller does not ask for one', async () => {
    await expect(parser.extractText(bytes)).resolves.toEqual({ totalPages: 1, text: ['page'] });
    expect(getDocumentProxyMock).toHaveBeenCalledWith(bytes);
  });

  it('forwards an opt-in ceiling to pdf.js', async () => {
    await expect(parser.extractText(bytes, { maxImageSize: 1024 })).resolves.toEqual({
      totalPages: 1,
      text: ['page'],
    });
    expect(getDocumentProxyMock).toHaveBeenCalledWith(bytes, { maxImageSize: 1024 });
  });
});

describe('PdfParser.extractText failures that are not the input', () => {
  /** An error shaped like pdf.js's `BaseException`: the class name rides `error.name`. */
  const pdfjsError = (name: string, message: string): Error => {
    const error = new Error(message);
    error.name = name;
    return error;
  };

  it('keeps an UnknownErrorException from the pdf.js worker as InternalError', async () => {
    getDocumentProxyMock.mockRejectedValueOnce(
      pdfjsError('UnknownErrorException', 'Cannot read properties of undefined'),
    );

    await expect(parser.extractText(bytes)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to extract text from PDF: Cannot read properties of undefined',
      data: { reason: 'pdf_text_extract_failed' },
    });
  });

  it('keeps a TypeError from the extraction call as InternalError', async () => {
    extractTextMock.mockRejectedValueOnce(new TypeError('pdf.getPage is not a function'));

    await expect(parser.extractText(bytes)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to extract text from PDF: pdf.getPage is not a function',
      data: { reason: 'pdf_text_extract_failed' },
    });
  });

  it('keeps a non-Error rejection as InternalError', async () => {
    getDocumentProxyMock.mockRejectedValueOnce('worker terminated');

    await expect(parser.extractText(bytes)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Failed to extract text from PDF: worker terminated',
      data: { reason: 'pdf_text_extract_failed' },
    });
  });

  it('classifies an unreadable-input name raised by the text pass, not only the load', async () => {
    extractTextMock.mockRejectedValueOnce(
      pdfjsError('InvalidPDFException', 'Invalid PDF structure.'),
    );

    await expect(parser.extractText(bytes)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to extract text from PDF: Invalid PDF structure.',
      data: { reason: 'pdf_text_extract_failed' },
    });
  });

  it('passes a missing unpdf peer through as ConfigurationError', async () => {
    vi.resetModules();
    vi.doMock('unpdf', () => {
      throw new Error('Cannot find package "unpdf"');
    });
    try {
      const fresh = await import('@/utils/parsing/pdfParser.js');

      await expect(new fresh.PdfParser().extractText(bytes)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message:
          'PDF text extraction needs the optional peer dependency "unpdf", which is not installed. Add it to the server\'s dependencies.',
      });
    } finally {
      vi.doUnmock('unpdf');
    }
  });
});
