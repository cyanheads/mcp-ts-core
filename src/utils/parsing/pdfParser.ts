/**
 * @fileoverview Provides a utility class for creating, modifying, and parsing PDF documents.
 * Wraps the 'pdf-lib' npm library with structured error handling and logging.
 * Uses 'unpdf' for robust text extraction compatible with Cloudflare Workers.
 * @module src/utils/parsing/pdfParser
 */
import type { PDFDocument, PDFFont, PDFImage, PDFPage, RGB } from 'pdf-lib';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from '@/utils/internal/requestContext.js';
import {
  assertBinaryInputBudget,
  assertBinaryInputsBudget,
  type ParserInputBudgetOptions,
} from './inputBudget.js';

const getPdfLib = lazyImport(
  () => import('pdf-lib'),
  'Install "pdf-lib" to use PDF operations: bun add pdf-lib',
);

const getUnpdf = lazyImport(
  () => import('unpdf'),
  'Install "unpdf" to use PDF text extraction: bun add unpdf',
);

/**
 * Build the client-facing PDF failure envelope: a fixed summary plus the
 * library's own diagnostic, which is what tells a caller how to repair the
 * input. `data` carries only the stable `reason` discriminator — never a
 * content sample or a stack, both of which stay on `cause` for the internal
 * error pipeline.
 *
 * An `McpError` thrown from inside the operation is already classified and
 * client-safe — most often the `ConfigurationError` a lazy import raises for a
 * missing peer dependency — so it passes through with its code and remediation
 * intact rather than being relabelled as a PDF failure.
 */
function pdfFailure(
  code: JsonRpcErrorCode.InternalError | JsonRpcErrorCode.ValidationError,
  summary: string,
  reason: string,
  cause: Error,
): McpError {
  if (cause instanceof McpError) return cause;
  return new McpError(code, `${summary}: ${cause.message}`, { reason }, { cause });
}

/**
 * Options for adding a new page to a PDF document.
 */
export interface AddPageOptions {
  /**
   * Height of the page in points (1/72 inch). Defaults to US Letter height (792 points).
   */
  height?: number;
  /**
   * Width of the page in points (1/72 inch). Defaults to US Letter width (612 points).
   */
  width?: number;
}

/**
 * Options for drawing text on a PDF page.
 */
export interface DrawTextOptions {
  /**
   * Text color as an RGB object. Defaults to black.
   */
  color?: RGB;

  /**
   * Font to use. Must be embedded first via embedFont().
   * Defaults to Helvetica.
   */
  font?: PDFFont;

  /**
   * Line height multiplier for wrapped text. Defaults to 1.2.
   */
  lineHeight?: number;

  /**
   * Maximum width for text wrapping (in points). If specified, text will wrap.
   */
  maxWidth?: number;

  /**
   * Rotation angle in degrees. Defaults to 0.
   */
  rotate?: number;

  /**
   * Font size in points. Defaults to 12.
   */
  size?: number;
  /**
   * The text string to draw.
   */
  text: string;

  /**
   * X-coordinate (in points) of the text baseline start.
   */
  x: number;

  /**
   * Y-coordinate (in points) of the text baseline.
   */
  y: number;
}

/**
 * Options for embedding an image into a PDF document.
 */
export interface EmbedImageOptions {
  /**
   * Image format: 'png' or 'jpg'.
   */
  format: 'png' | 'jpg';
  /**
   * Image data as Uint8Array or ArrayBuffer.
   */
  imageBytes: Uint8Array | ArrayBuffer;
  /** Input budget in bytes. Unbounded when omitted. */
  maxBytes?: number;
}

/**
 * Options for drawing an embedded image on a page.
 */
export interface DrawImageOptions {
  /**
   * Height of the image in points. Defaults to original height.
   */
  height?: number;
  /**
   * The embedded PDF image.
   */
  image: PDFImage;

  /**
   * Opacity (0-1). Defaults to 1 (fully opaque).
   */
  opacity?: number;

  /**
   * Rotation angle in degrees. Defaults to 0.
   */
  rotate?: number;

  /**
   * Width of the image in points. Defaults to original width.
   */
  width?: number;

  /**
   * X-coordinate (in points) of the image's top-left corner.
   */
  x: number;

  /**
   * Y-coordinate (in points) of the image's top-left corner.
   */
  y: number;
}

/**
 * Page range specification for splitting PDFs.
 */
export interface PageRange {
  /**
   * Ending page index (0-based, inclusive).
   */
  end: number;
  /**
   * Starting page index (0-based).
   */
  start: number;
}

/**
 * Metadata extracted from a PDF document.
 */
export interface PdfMetadata {
  /**
   * Document author.
   */
  author?: string;

  /**
   * Creation date (ISO 8601 string).
   */
  creationDate?: string;

  /**
   * Application that created the document.
   */
  creator?: string;

  /**
   * Keywords associated with the document.
   */
  keywords?: string;

  /**
   * Modification date (ISO 8601 string).
   */
  modificationDate?: string;

  /**
   * Total number of pages.
   */
  pageCount: number;

  /**
   * Application that produced the PDF.
   */
  producer?: string;

  /**
   * Document subject.
   */
  subject?: string;
  /**
   * Document title.
   */
  title?: string;
}

/**
 * Options for setting PDF metadata.
 */
export interface SetMetadataOptions {
  /**
   * Document author.
   */
  author?: string;

  /**
   * Application that created the document.
   */
  creator?: string;

  /**
   * Keywords associated with the document.
   */
  keywords?: string;

  /**
   * Application that produced the PDF.
   */
  producer?: string;

  /**
   * Document subject.
   */
  subject?: string;
  /**
   * Document title.
   */
  title?: string;
}

/**
 * Options for filling PDF form fields.
 */
export interface FillFormOptions {
  /**
   * Map of field names to their values.
   */
  fields: Record<string, string | boolean | number>;

  /**
   * Whether to flatten the form after filling (make it non-editable).
   * Defaults to false.
   */
  flatten?: boolean;
}

/**
 * Options for extracting text from a PDF document.
 */
export interface ExtractTextOptions {
  /** Input budget in bytes. Unbounded when omitted. */
  maxBytes?: number;
  /**
   * Ceiling in pixels on a single decoded image, forwarded to pdf.js as
   * `maxImageSize`. Unbounded when omitted, matching pdf.js's own default.
   */
  maxImageSize?: number;
  /**
   * Whether to merge all pages into a single string.
   * If true, returns text as a single string.
   * If false, returns text as an array with one string per page.
   * Defaults to false.
   */
  mergePages?: boolean;
}

/**
 * Result from extracting text from a PDF document.
 */
export interface ExtractTextResult {
  /**
   * Extracted text content.
   * String array if mergePages is false (one entry per page).
   * Single string if mergePages is true (all pages concatenated).
   */
  text: string | string[];
  /**
   * Total number of pages in the PDF.
   */
  totalPages: number;
}

/**
 * Utility class for creating, modifying, and parsing PDF documents.
 *
 * Wraps the `pdf-lib` library for document creation/editing and `unpdf` for text
 * extraction (Cloudflare Workers compatible). Most methods are async due to lazy
 * loading of these peer dependencies. Install both with:
 * `bun add pdf-lib unpdf`
 */
export class PdfParser {
  /**
   * Creates a new blank PDF document.
   *
   * Async due to lazy loading of the `pdf-lib` peer dependency (`bun add pdf-lib`).
   *
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @returns A new empty `PDFDocument` instance.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @throws {McpError} With `InternalError` if document creation fails.
   * @example
   * ```typescript
   * const doc = await pdfParser.createDocument();
   * const page = pdfParser.addPage(doc);
   * ```
   */
  async createDocument(context?: RequestContextLike | RequestContext): Promise<PDFDocument> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.createDocument',
      });

    try {
      const pdfLib = await getPdfLib();
      logger.debug('Creating new PDF document.', logContext);
      const doc = await pdfLib.PDFDocument.create();
      return doc;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to create PDF document.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to create PDF document',
        'pdf_create_failed',
        error,
      );
    }
  }

  /**
   * Loads an existing PDF document from raw bytes.
   *
   * Async due to lazy loading of the `pdf-lib` peer dependency (`bun add pdf-lib`).
   *
   * @param pdfBytes - The PDF file contents as `Uint8Array` or `ArrayBuffer`.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @param budget - Optional byte budget for the input. Unbounded when omitted.
   * @returns The loaded `PDFDocument` instance.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @throws {McpError} With `ValidationError` if the bytes are not a valid PDF.
   * @example
   * ```typescript
   * import { readFile } from 'node:fs/promises';
   * const pdfBytes = await readFile('input.pdf');
   * const doc = await pdfParser.loadDocument(pdfBytes);
   * ```
   */
  async loadDocument(
    pdfBytes: Uint8Array | ArrayBuffer,
    context?: RequestContextLike | RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<PDFDocument> {
    const byteLength = assertBinaryInputBudget(pdfBytes, budget);
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.loadDocument',
      });

    try {
      const pdfLib = await getPdfLib();
      logger.debug('Loading PDF document from bytes.', {
        ...logContext,
        byteLength,
      });

      const doc = await pdfLib.PDFDocument.load(pdfBytes);
      return doc;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to load PDF document.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.ValidationError,
        'Failed to load PDF document',
        'pdf_load_failed',
        error,
      );
    }
  }

  /**
   * Adds a new blank page to a PDF document.
   *
   * Synchronous — does not load any peer dependencies.
   *
   * @param doc - The `PDFDocument` to add the page to.
   * @param options - Optional page dimensions. Defaults to US Letter (612 × 792 points).
   * @returns The newly added `PDFPage`.
   * @example
   * ```typescript
   * const page = pdfParser.addPage(doc, { width: 600, height: 400 });
   * ```
   */
  addPage(doc: PDFDocument, options?: AddPageOptions): PDFPage {
    const width = options?.width ?? 612; // US Letter width
    const height = options?.height ?? 792; // US Letter height
    return doc.addPage([width, height]);
  }

  /**
   * Embeds a standard PDF font into a document.
   *
   * `fontName` must be a key of `pdf-lib`'s `StandardFonts` enum (e.g. `'Helvetica'`,
   * `'TimesRoman'`, `'Courier'`). Async due to lazy loading of `pdf-lib`
   * (`bun add pdf-lib`).
   *
   * @param doc - The `PDFDocument` to embed the font into.
   * @param fontName - A `StandardFonts` key. Defaults to `'Helvetica'`.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @returns The embedded `PDFFont` ready to pass to `drawText`.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @throws {McpError} With `InternalError` if the font name is invalid or embedding fails.
   * @example
   * ```typescript
   * const font = await pdfParser.embedFont(doc, 'TimesRoman');
   * ```
   */
  async embedFont(
    doc: PDFDocument,
    fontName: string = 'Helvetica',
    context?: RequestContextLike | RequestContext,
  ): Promise<PDFFont> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.embedFont',
      });

    try {
      const { StandardFonts } = await getPdfLib();
      logger.debug('Embedding standard font.', {
        ...logContext,
        fontName,
      });

      const font = await doc.embedFont(StandardFonts[fontName as keyof typeof StandardFonts]);
      return font;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to embed font.', {
        ...logContext,
        fontName,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to embed PDF font',
        'pdf_font_embed_failed',
        error,
      );
    }
  }

  /**
   * Embeds a PNG or JPEG image into a PDF document for later rendering.
   *
   * Does not draw the image — call `drawImage` after embedding. Async due to lazy
   * loading of `pdf-lib` (`bun add pdf-lib`).
   *
   * @param doc - The `PDFDocument` to embed the image into.
   * @param options - Image bytes and format (`'png'` or `'jpg'`).
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @returns The embedded `PDFImage`, usable as the `image` option in `drawImage`.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @throws {McpError} With `InternalError` if the image data is invalid or embedding fails.
   * @example
   * ```typescript
   * import { readFile } from 'node:fs/promises';
   * const imageBytes = await readFile('logo.png');
   * const image = await pdfParser.embedImage(doc, { imageBytes, format: 'png' });
   * pdfParser.drawImage(page, { image, x: 50, y: 700, width: 100, height: 50 });
   * ```
   */
  async embedImage(
    doc: PDFDocument,
    options: EmbedImageOptions,
    context?: RequestContextLike | RequestContext,
  ): Promise<PDFImage> {
    assertBinaryInputBudget(options.imageBytes, options);
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.embedImage',
      });

    try {
      logger.debug('Embedding image into PDF.', {
        ...logContext,
        format: options.format,
      });

      const image =
        options.format === 'png'
          ? await doc.embedPng(options.imageBytes)
          : await doc.embedJpg(options.imageBytes);

      return image;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to embed image.', {
        ...logContext,
        format: options.format,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to embed PDF image',
        'pdf_image_embed_failed',
        error,
      );
    }
  }

  /**
   * Draws text on a PDF page with optional font, size, color, rotation, and word-wrap.
   *
   * When `maxWidth` is set, the text is split into words and wrapped across multiple
   * lines; each line is rendered at decreasing Y positions by `size * lineHeight`.
   * Async due to lazy loading of `pdf-lib` (`bun add pdf-lib`).
   *
   * @param page - The `PDFPage` to draw text on.
   * @param options - Text content, baseline position (`x`, `y`), and styling.
   * @returns A promise that resolves when drawing is complete.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @example
   * ```typescript
   * const font = await pdfParser.embedFont(doc, 'Helvetica');
   * await pdfParser.drawText(page, {
   *   text: 'Hello, World!',
   *   x: 50,
   *   y: 700,
   *   size: 30,
   *   font,
   *   color: rgb(0, 0.53, 0.71),
   * });
   * ```
   */
  async drawText(page: PDFPage, options: DrawTextOptions): Promise<void> {
    const pdfLib = await getPdfLib();
    const { text, x, y, size = 12, font, rotate = 0, maxWidth, lineHeight = 1.2 } = options;
    const color = options.color ?? pdfLib.rgb(0, 0, 0);

    if (!maxWidth) {
      // Simple single-line text
      page.drawText(text, {
        x,
        y,
        size,
        color,
        ...(font && { font }),
        ...(rotate && { rotate: pdfLib.degrees(rotate) }),
      });
    } else {
      // Text wrapping
      const words = text.split(' ');
      const lines: string[] = [];
      let currentLine = '';

      const effectiveFont = font || page.doc.getForm().getDefaultFont();

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = effectiveFont.widthOfTextAtSize(testLine, size);

        if (testWidth <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) {
            lines.push(currentLine);
          }
          currentLine = word;
        }
      }

      if (currentLine) {
        lines.push(currentLine);
      }

      // Draw each line
      let currentY = y;
      for (const line of lines) {
        page.drawText(line, {
          x,
          y: currentY,
          size,
          color,
          ...(font && { font }),
          ...(rotate && { rotate: pdfLib.degrees(rotate) }),
        });
        currentY -= size * lineHeight;
      }
    }
  }

  /**
   * Draws a previously embedded image onto a PDF page.
   *
   * The image must first be embedded via `embedImage`. Width and height default to the
   * image's intrinsic dimensions. Async due to lazy loading of `pdf-lib`
   * (`bun add pdf-lib`).
   *
   * @param page - The `PDFPage` to draw the image on.
   * @param options - The embedded image, position (`x`, `y`), dimensions, opacity, and rotation.
   * @returns A promise that resolves when drawing is complete.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @example
   * ```typescript
   * const image = await pdfParser.embedImage(doc, { imageBytes, format: 'png' });
   * await pdfParser.drawImage(page, {
   *   image,
   *   x: 100,
   *   y: 500,
   *   width: 200,
   *   height: 150,
   * });
   * ```
   */
  async drawImage(page: PDFPage, options: DrawImageOptions): Promise<void> {
    const pdfLib = await getPdfLib();
    const {
      image,
      x,
      y,
      width = image.width,
      height = image.height,
      rotate = 0,
      opacity = 1,
    } = options;

    page.drawImage(image, {
      x,
      y,
      width,
      height,
      opacity,
      ...(rotate && { rotate: pdfLib.degrees(rotate) }),
    });
  }

  /**
   * Merges multiple PDF documents into a single new document.
   *
   * Pages are appended in the order the source buffers appear in the array. Undefined
   * or falsy entries in the array are silently skipped. Async due to lazy loading of
   * `pdf-lib` (`bun add pdf-lib`).
   *
   * @param pdfBytesArray - Source PDF files as `Uint8Array` or `ArrayBuffer` elements.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @param budget - Optional aggregate byte budget across all inputs. Unbounded when omitted.
   * @returns A new `PDFDocument` containing all pages from the input documents.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @throws {McpError} With `InternalError` if any source PDF is invalid or merging fails.
   * @example
   * ```typescript
   * import { readFile } from 'node:fs/promises';
   * const pdf1 = await readFile('doc1.pdf');
   * const pdf2 = await readFile('doc2.pdf');
   * const merged = await pdfParser.mergePdfs([pdf1, pdf2]);
   * const bytes = await pdfParser.saveDocument(merged);
   * ```
   */
  async mergePdfs(
    pdfBytesArray: (Uint8Array | ArrayBuffer)[],
    context?: RequestContextLike | RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<PDFDocument> {
    const presentInputs = pdfBytesArray.filter(Boolean);
    assertBinaryInputsBudget(presentInputs, budget);

    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.mergePdfs',
      });

    try {
      const pdfLib = await getPdfLib();
      logger.debug('Merging PDF documents.', {
        ...logContext,
        documentCount: pdfBytesArray.length,
      });

      const mergedPdf = await pdfLib.PDFDocument.create();

      for (const pdfBytes of presentInputs) {
        const pdfDoc = await pdfLib.PDFDocument.load(pdfBytes);
        const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
        for (const page of copiedPages) mergedPdf.addPage(page);
      }

      logger.debug('Successfully merged PDF documents.', {
        ...logContext,
        mergedPageCount: mergedPdf.getPageCount(),
      });

      return mergedPdf;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to merge PDF documents.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to merge PDF documents',
        'pdf_merge_failed',
        error,
      );
    }
  }

  /**
   * Splits a PDF document into multiple new documents based on page ranges.
   *
   * Each `PageRange` produces one output `PDFDocument` containing the pages from
   * `start` to `end` (both 0-based, inclusive). Ranges may overlap. Async due to
   * lazy loading of `pdf-lib` (`bun add pdf-lib`).
   *
   * @param pdfBytes - The source PDF as `Uint8Array` or `ArrayBuffer`.
   * @param ranges - Page ranges to extract; each produces one output document.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @param budget - Optional byte budget for the input. Unbounded when omitted.
   * @returns An array of new `PDFDocument` instances, one per range, in order.
   * @throws {McpError} With `ConfigurationError` if `pdf-lib` is not installed.
   * @throws {McpError} With `InternalError` if the source PDF is invalid or a page index is out of bounds.
   * @example
   * ```typescript
   * import { readFile } from 'node:fs/promises';
   * const pdfBytes = await readFile('document.pdf');
   * const [part1, part2] = await pdfParser.splitPdf(pdfBytes, [
   *   { start: 0, end: 4 },
   *   { start: 5, end: 9 },
   * ]);
   * ```
   */
  async splitPdf(
    pdfBytes: Uint8Array | ArrayBuffer,
    ranges: PageRange[],
    context?: RequestContextLike | RequestContext,
    budget?: ParserInputBudgetOptions,
  ): Promise<PDFDocument[]> {
    assertBinaryInputBudget(pdfBytes, budget);
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.splitPdf',
      });

    try {
      const pdfLib = await getPdfLib();
      logger.debug('Splitting PDF document.', {
        ...logContext,
        rangeCount: ranges.length,
      });

      const sourcePdf = await pdfLib.PDFDocument.load(pdfBytes);
      const results: PDFDocument[] = [];

      for (const range of ranges) {
        const newPdf = await pdfLib.PDFDocument.create();
        const pageIndices: number[] = [];

        for (let i = range.start; i <= range.end; i++) {
          pageIndices.push(i);
        }

        const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);
        for (const page of copiedPages) newPdf.addPage(page);

        results.push(newPdf);
      }

      logger.debug('Successfully split PDF document.', {
        ...logContext,
        resultCount: results.length,
      });

      return results;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to split PDF document.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to split PDF document',
        'pdf_split_failed',
        error,
      );
    }
  }

  /**
   * Fills form fields in a PDF document.
   *
   * String and number values are set via `setText`; boolean values check/uncheck
   * checkbox fields. Individual field errors are logged as warnings and skipped
   * rather than aborting the whole operation. If `flatten` is true, the form is
   * flattened after filling, making it non-editable. Synchronous.
   *
   * @param doc - The `PDFDocument` containing the AcroForm.
   * @param options - Map of field names to values, plus optional `flatten` flag.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @throws {McpError} With `InternalError` if the overall form operation fails.
   * @example
   * ```typescript
   * pdfParser.fillForm(doc, {
   *   fields: {
   *     Name: 'John Doe',
   *     Age: 30,
   *     Subscribe: true,
   *   },
   *   flatten: true,
   * });
   * ```
   */
  fillForm(
    doc: PDFDocument,
    options: FillFormOptions,
    context?: RequestContextLike | RequestContext,
  ): void {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.fillForm',
      });

    try {
      logger.debug('Filling PDF form fields.', {
        ...logContext,
        fieldCount: Object.keys(options.fields).length,
        flatten: options.flatten ?? false,
      });

      const form = doc.getForm();

      for (const [fieldName, value] of Object.entries(options.fields)) {
        try {
          const field = form.getField(fieldName);

          if (typeof value === 'string') {
            if ('setText' in field) {
              (field as { setText: (text: string) => void }).setText(value);
            }
          } else if (typeof value === 'boolean') {
            if ('check' in field || 'uncheck' in field) {
              const checkboxField = field as {
                check?: () => void;
                uncheck?: () => void;
              };
              if (value) {
                checkboxField.check?.();
              } else {
                checkboxField.uncheck?.();
              }
            }
          } else if (typeof value === 'number') {
            if ('setText' in field) {
              (field as { setText: (text: string) => void }).setText(String(value));
            }
          }
        } catch (fieldError: unknown) {
          logger.warning('Failed to fill form field.', {
            ...logContext,
            fieldName,
            fieldError: fieldError instanceof Error ? fieldError.message : String(fieldError),
          });
        }
      }

      if (options.flatten) {
        form.flatten();
      }

      logger.debug('Successfully filled PDF form.', logContext);
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to fill PDF form.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to fill PDF form',
        'pdf_form_fill_failed',
        error,
      );
    }
  }

  /**
   * Extracts metadata from a PDF document.
   *
   * Reads title, author, subject, keywords, creator, producer, creation date, and
   * modification date from the document's info dictionary. Optional fields are
   * omitted from the result if not set. Synchronous — no peer dependency loading.
   *
   * @param doc - The `PDFDocument` to extract metadata from.
   * @returns A `PdfMetadata` object; optional fields are absent if not set in the document.
   * @example
   * ```typescript
   * const metadata = pdfParser.extractMetadata(doc);
   * console.log(`${metadata.title} by ${metadata.author} (${metadata.pageCount} pages)`);
   * ```
   */
  extractMetadata(doc: PDFDocument): PdfMetadata {
    const title = doc.getTitle();
    const author = doc.getAuthor();
    const subject = doc.getSubject();
    const keywords = doc.getKeywords();
    const creator = doc.getCreator();
    const producer = doc.getProducer();
    const creationDate = doc.getCreationDate();
    const modificationDate = doc.getModificationDate();

    const metadata: PdfMetadata = {
      pageCount: doc.getPageCount(),
    };

    if (title !== undefined) metadata.title = title;
    if (author !== undefined) metadata.author = author;
    if (subject !== undefined) metadata.subject = subject;
    if (keywords !== undefined) metadata.keywords = keywords;
    if (creator !== undefined) metadata.creator = creator;
    if (producer !== undefined) metadata.producer = producer;
    if (creationDate !== undefined) metadata.creationDate = creationDate.toISOString();
    if (modificationDate !== undefined) metadata.modificationDate = modificationDate.toISOString();

    return metadata;
  }

  /**
   * Sets metadata fields on a PDF document.
   *
   * Only fields present in `metadata` are written; omitted fields are left unchanged.
   * Note: `keywords` is passed as a single-element array to `pdf-lib`'s `setKeywords`.
   * Synchronous — no peer dependency loading.
   *
   * @param doc - The `PDFDocument` to update.
   * @param metadata - Metadata values to set. Omitted fields are left unchanged.
   * @example
   * ```typescript
   * pdfParser.setMetadata(doc, {
   *   title: 'My Document',
   *   author: 'John Doe',
   *   subject: 'Important Document',
   * });
   * ```
   */
  setMetadata(doc: PDFDocument, metadata: SetMetadataOptions): void {
    if (metadata.title) doc.setTitle(metadata.title);
    if (metadata.author) doc.setAuthor(metadata.author);
    if (metadata.subject) doc.setSubject(metadata.subject);
    if (metadata.keywords) doc.setKeywords([metadata.keywords]);
    if (metadata.creator) doc.setCreator(metadata.creator);
    if (metadata.producer) doc.setProducer(metadata.producer);
  }

  /**
   * Extracts text content from all pages of a PDF using `unpdf`.
   *
   * Accepts either raw PDF bytes (`Uint8Array` | `ArrayBuffer`) or a loaded
   * `PDFDocument`. When bytes are passed, `pdf-lib` is not required — `unpdf` is
   * the only peer dep that loads, making this the preferred path for scholarly
   * / API pipelines that just need text for an LLM. When a `PDFDocument` is
   * passed, the doc is serialized via `pdf-lib`'s `save()` before extraction.
   * Compatible with Cloudflare Workers and other serverless environments.
   *
   * @param input - Raw PDF bytes (`Uint8Array` | `ArrayBuffer`) or a loaded `PDFDocument`.
   * @param options - Optional extraction options. Set `mergePages: true` to get a
   *   single concatenated string instead of one string per page.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @returns An `ExtractTextResult` with `totalPages` and `text` — a `string[]` (one
   *   per page) by default, or a single `string` when `mergePages` is `true`.
   * @throws {McpError} With `ConfigurationError` if `unpdf` is not installed (or
   *   `pdf-lib` is missing when a `PDFDocument` is passed).
   * @throws {McpError} With `InternalError` if text extraction fails.
   * @example
   * ```typescript
   * // Direct from bytes — skips the pdf-lib round-trip (unpdf-only path)
   * const bytes = await readFile('paper.pdf');
   * const result = await pdfParser.extractText(bytes, { mergePages: true });
   *
   * // From a loaded document (when you're also editing / inspecting)
   * const doc = await pdfParser.loadDocument(bytes);
   * const perPage = await pdfParser.extractText(doc);
   * ```
   */
  async extractText(
    input: PDFDocument | Uint8Array | ArrayBuffer,
    options?: ExtractTextOptions,
    context?: RequestContextLike | RequestContext,
  ): Promise<ExtractTextResult> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.extractText',
      });

    const mergePages = options?.mergePages ?? false;
    const isBytes = input instanceof Uint8Array || input instanceof ArrayBuffer;
    let pdfBytes: Uint8Array;

    if (isBytes) {
      assertBinaryInputBudget(input, options);
      pdfBytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    } else {
      let rawBytes: Uint8Array;
      try {
        rawBytes = await input.save();
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.error('Failed to extract text from PDF.', {
          ...logContext,
          errorDetails: error.message,
        });
        throw pdfFailure(
          JsonRpcErrorCode.InternalError,
          'Failed to extract text from PDF',
          'pdf_text_extract_failed',
          error,
        );
      }
      assertBinaryInputBudget(rawBytes, options);
      pdfBytes = rawBytes;
    }

    try {
      logger.debug('Extracting text from PDF using unpdf.', {
        ...logContext,
        mergePages,
        inputKind: isBytes ? 'bytes' : 'document',
      });

      const { getDocumentProxy, extractText: unpdfExtractText } = await getUnpdf();
      const pdfProxy =
        options?.maxImageSize === undefined
          ? await getDocumentProxy(pdfBytes)
          : await getDocumentProxy(pdfBytes, { maxImageSize: options.maxImageSize });

      const result: { totalPages: number; text: string | string[] } = mergePages
        ? await unpdfExtractText(pdfProxy, { mergePages: true })
        : await unpdfExtractText(pdfProxy, { mergePages: false });

      logger.debug('Successfully extracted text from PDF.', {
        ...logContext,
        totalPages: result.totalPages,
        textLength: Array.isArray(result.text)
          ? result.text.reduce((sum, t) => sum + t.length, 0)
          : result.text.length,
      });

      return {
        totalPages: result.totalPages,
        text: result.text,
      };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to extract text from PDF.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to extract text from PDF',
        'pdf_text_extract_failed',
        error,
      );
    }
  }

  /**
   * Serializes a PDF document to a `Uint8Array` for writing to disk or transmission.
   *
   * Async due to `pdf-lib`'s async `save()` implementation (cross-origin / Worker
   * compatible). Does not reload peer dependencies if already cached.
   *
   * @param doc - The `PDFDocument` to serialize.
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @returns The complete PDF file as a `Uint8Array`.
   * @throws {McpError} With `InternalError` if serialization fails.
   * @example
   * ```typescript
   * import { writeFile } from 'node:fs/promises';
   * const pdfBytes = await pdfParser.saveDocument(doc);
   * await writeFile('output.pdf', pdfBytes);
   * ```
   */
  async saveDocument(
    doc: PDFDocument,
    context?: RequestContextLike | RequestContext,
  ): Promise<Uint8Array> {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'PdfParser.saveDocument',
      });

    try {
      logger.debug('Serializing PDF document to bytes.', logContext);
      const bytes = await doc.save();
      logger.debug('Successfully serialized PDF document.', {
        ...logContext,
        byteLength: bytes.length,
      });
      return bytes;
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to serialize PDF document.', {
        ...logContext,
        errorDetails: error.message,
      });

      throw pdfFailure(
        JsonRpcErrorCode.InternalError,
        'Failed to save PDF document',
        'pdf_save_failed',
        error,
      );
    }
  }
}

/**
 * Singleton instance of `PdfParser`.
 *
 * Provides PDF creation, editing, merging, splitting, form filling, metadata
 * extraction, and text extraction. Requires `pdf-lib` for document operations
 * and `unpdf` for text extraction — install both with: `bun add pdf-lib unpdf`
 *
 * @example
 * ```typescript
 * import { pdfParser } from '@/utils/parsing/pdfParser.js';
 * import { writeFile } from 'node:fs/promises';
 *
 * const doc = await pdfParser.createDocument();
 * const page = pdfParser.addPage(doc);
 * const font = await pdfParser.embedFont(doc, 'Helvetica');
 *
 * await pdfParser.drawText(page, {
 *   text: 'Hello, World!',
 *   x: 50,
 *   y: 750,
 *   size: 30,
 *   font,
 * });
 *
 * const pdfBytes = await pdfParser.saveDocument(doc);
 * await writeFile('output.pdf', pdfBytes);
 * ```
 */
export const pdfParser = new PdfParser();

export type { PDFDocument, PDFFont, PDFImage, PDFPage, RGB } from 'pdf-lib';
