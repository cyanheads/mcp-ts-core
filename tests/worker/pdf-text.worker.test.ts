/**
 * @fileoverview Worker-runtime tests for `pdfParser.extractText`.
 * Runs under `tests/config/vitest.worker.ts` (Cloudflare workerd pool). The
 * method's contract says it runs on Workers through `unpdf`'s serverless
 * pdf.js build; this suite extracts per-page text from PDF bytes under real
 * workerd, checks the caller's bytes are unchanged afterwards, and pins that
 * bytes which are not a PDF fail as `ValidationError`.
 * @module tests/worker/pdf-text.worker.test
 */

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { pdfParser } from '@/utils/parsing/pdfParser.js';

/** A two-page PDF with one line of text on each page. */
async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([600, 400]).drawText('alpha beta', { x: 50, y: 350, size: 12, font });
  doc.addPage([600, 400]).drawText('gamma delta', { x: 50, y: 350, size: 12, font });
  return await doc.save();
}

describe('pdfParser.extractText on workerd', () => {
  it('extracts the text of each page from PDF bytes and leaves the bytes unchanged', async () => {
    const bytes = await twoPagePdf();
    const before = bytes.slice();

    await expect(pdfParser.extractText(bytes)).resolves.toEqual({
      totalPages: 2,
      text: ['alpha beta', 'gamma delta'],
    });
    expect(bytes).toEqual(before);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    await expect(pdfParser.extractText(buffer, { mergePages: true })).resolves.toEqual({
      totalPages: 2,
      text: 'alpha beta\ngamma delta',
    });
  });

  it('fails bytes that are not a PDF as ValidationError', async () => {
    await expect(
      pdfParser.extractText(new TextEncoder().encode('this is not a pdf at all')),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'pdf_text_extract_failed' },
    });
  });
});
