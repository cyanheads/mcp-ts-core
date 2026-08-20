/**
 * @fileoverview Tests for the HtmlExtractor utility (defuddle + linkedom).
 * @module tests/utils/parsing/htmlExtractor.test
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/internal/logger.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { HtmlExtractor, htmlExtractor } from '../../../../src/utils/parsing/htmlExtractor.js';

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>The Art of Testing</title>
    <meta name="author" content="Ada Lovelace" />
    <meta name="description" content="A short essay about testing software." />
    <meta property="og:site_name" content="Test Gazette" />
    <meta property="article:published_time" content="2026-01-15T12:00:00Z" />
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Article","headline":"The Art of Testing","author":{"@type":"Person","name":"Ada Lovelace"}}
    </script>
  </head>
  <body>
    <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <article>
      <h1>The Art of Testing</h1>
      <p class="byline">By Ada Lovelace — January 15, 2026</p>
      <p>Testing is the discipline of asking a program whether it really does what you believe.</p>
      <p>Good tests are short, specific, and cheap to run. They fail loudly when the world changes.</p>
      <h2>Why it matters</h2>
      <p>Without tests, every change is a coin flip. With them, change becomes cumulative learning.</p>
    </article>
    <aside class="sidebar"><h3>Related</h3><ul><li>Debugging</li><li>Refactoring</li></ul></aside>
    <footer>&copy; 2026 Test Gazette</footer>
  </body>
</html>`;

const SPA_SHELL_HTML = `<!doctype html>
<html><head><title>App</title></head><body><div id="root"></div></body></html>`;

const MALFORMED_HTML = `<html><body><article><h1>Unclosed<p>Paragraph one<p>Paragraph two<div><span>stray</div></span></article>`;

describe('HtmlExtractor', () => {
  const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('basic extraction', () => {
    it('extracts title, author, and main content from a clean article', async () => {
      const extractor = new HtmlExtractor();
      const result = await extractor.extract(ARTICLE_HTML);

      expect(result.title).toBe('The Art of Testing');
      expect(result.author).toBe('Ada Lovelace');
      expect(result.content).toContain('Testing is the discipline');
      expect(result.content).toContain('Why it matters');
      expect(result.wordCount).toBeGreaterThan(0);
    });

    it('excludes boilerplate (nav, sidebar, footer) from content', async () => {
      const result = await htmlExtractor.extract(ARTICLE_HTML);

      expect(result.content).not.toContain('Home');
      expect(result.content).not.toContain('About');
      expect(result.content).not.toContain('Test Gazette');
      expect(result.content).not.toMatch(/Related[\s\S]*Debugging/);
    });

    it('returns description from meta tags', async () => {
      const result = await htmlExtractor.extract(ARTICLE_HTML);
      expect(result.description).toBe('A short essay about testing software.');
    });

    it('returns schema.org data when present', async () => {
      const result = await htmlExtractor.extract(ARTICLE_HTML);
      expect(result.schemaOrgData).toBeDefined();
    });

    it('logs debug messages around extraction', async () => {
      await htmlExtractor.extract(ARTICLE_HTML);

      expect(debugSpy).toHaveBeenCalledWith(
        'Extracting article content from HTML.',
        expect.objectContaining({
          extra: expect.objectContaining({
            byteLength: new TextEncoder().encode(ARTICLE_HTML).byteLength,
            format: 'markdown',
          }),
        }),
      );
      expect(debugSpy).toHaveBeenCalledWith(
        'Successfully extracted article.',
        expect.objectContaining({
          extra: expect.objectContaining({ titlePresent: true }),
        }),
      );
    });
  });

  describe('format option', () => {
    it('defaults to markdown output', async () => {
      const result = await htmlExtractor.extract(ARTICLE_HTML);
      // Markdown output should not carry HTML tags for paragraphs
      expect(result.content).not.toMatch(/<p[>\s]/);
    });

    it('returns HTML content when format is "html"', async () => {
      const result = await htmlExtractor.extract(ARTICLE_HTML, { format: 'html' });
      expect(result.content).toMatch(/<[a-z][^>]*>/i);
    });
  });

  describe('contentSelector option', () => {
    it('forwards contentSelector to defuddle', async () => {
      const result = await htmlExtractor.extract(ARTICLE_HTML, {
        contentSelector: 'article',
      });
      expect(result.content).toContain('Testing is the discipline');
    });
  });

  describe('removeImages option', () => {
    it('strips images when removeImages is true', async () => {
      const htmlWithImage = ARTICLE_HTML.replace(
        '<article>',
        '<article><img src="cover.png" alt="cover" />',
      );
      const result = await htmlExtractor.extract(htmlWithImage, {
        removeImages: true,
        format: 'html',
      });
      expect(result.content).not.toMatch(/<img\b/i);
    });
  });

  describe('edge cases', () => {
    it('throws ValidationError on empty input', async () => {
      await expect(htmlExtractor.extract('')).rejects.toThrow(McpError);
      try {
        await htmlExtractor.extract('   \n  ');
      } catch (e) {
        const err = e as McpError;
        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.message).toContain('empty');
      }
    });

    it('handles SPA shells with minimal content without crashing', async () => {
      const result = await htmlExtractor.extract(SPA_SHELL_HTML);
      // Content may be empty or nearly so — just ensure we didn't throw.
      expect(typeof result.content).toBe('string');
    });

    it('handles malformed HTML without crashing', async () => {
      // Defuddle may return empty content when scoring can't find a coherent
      // main block. The invariant is that extraction degrades gracefully —
      // no crash, `content` is always a string.
      const result = await htmlExtractor.extract(MALFORMED_HTML);
      expect(typeof result.content).toBe('string');
    });

    it('accepts an explicit request context', async () => {
      const { requestContextService } = await import('@/utils/internal/requestContext.js');
      const ctx = requestContextService.createRequestContext({
        operation: 'test-html-extractor',
      });
      const result = await htmlExtractor.extract(ARTICLE_HTML, undefined, ctx);
      expect(result.title).toBe('The Art of Testing');
      expect(debugSpy).toHaveBeenCalledWith(
        'Extracting article content from HTML.',
        expect.objectContaining({ operation: 'test-html-extractor' }),
      );
    });
  });

  describe('singleton export', () => {
    it('exports an htmlExtractor singleton', () => {
      expect(htmlExtractor).toBeInstanceOf(HtmlExtractor);
    });
  });
});
