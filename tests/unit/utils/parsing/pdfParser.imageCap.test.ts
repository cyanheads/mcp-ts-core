/**
 * @fileoverview Verifies how PDF text extraction forwards the decoded-image
 * ceiling to pdf.js: absent unless the caller asks for one.
 * @module tests/utils/parsing/pdfParser.imageCap.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { extractTextMock, getDocumentProxyMock } = vi.hoisted(() => ({
  extractTextMock: vi.fn(),
  getDocumentProxyMock: vi.fn(),
}));

vi.mock('unpdf', () => ({
  extractText: extractTextMock,
  getDocumentProxy: getDocumentProxyMock,
}));

import { PdfParser } from '@/utils/parsing/pdfParser.js';

describe('PdfParser.extractText decoded-image ceiling', () => {
  const parser = new PdfParser();
  const bytes = new Uint8Array([1, 2, 3]);

  beforeEach(() => {
    vi.clearAllMocks();
    getDocumentProxyMock.mockResolvedValue({ proxy: true });
    extractTextMock.mockResolvedValue({ totalPages: 1, text: ['page'] });
  });

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
