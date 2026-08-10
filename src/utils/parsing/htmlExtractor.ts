/**
 * @fileoverview Provides a utility class for extracting main article content
 * from raw HTML into clean Markdown or HTML, plus best-effort metadata
 * (title, author, description, Open Graph fields, schema.org data).
 *
 * Wraps the `defuddle/node` entry (modern Readability successor, powers
 * Obsidian Web Clipper) together with a DOM implementation. Both are
 * peer dependencies loaded lazily on first use, so there is zero cost if
 * HTML extraction is never used.
 *
 * Primary use case: MCP servers that wrap scholarly or article APIs and
 * need to hand raw page content to an LLM without hand-rolling content
 * extraction. The result is intentionally best-effort — callers should
 * treat it as LLM-ready text, not as a typed document model.
 *
 * Peer dependencies:
 * - `defuddle` — article extraction engine
 * - `linkedom` — lightweight DOM implementation, Workers-compatible (JSDOM
 *   is also supported but heavier).
 *
 * Install with: `bun add defuddle linkedom`
 *
 * Cloudflare Workers note: `linkedom` works in Workers but adds a measurable
 * amount to the final bundle (~150KB minified, plus entity tables). Factor
 * this into your Worker size budget before adopting.
 *
 * @module src/utils/parsing/htmlExtractor
 */
import type { DefuddleOptions } from 'defuddle/node';
import { McpError, validationError } from '@/types-global/errors.js';
import { lazyImport } from '@/utils/internal/lazyImport.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from '@/utils/internal/requestContext.js';
import { assertTextInputBudget } from './inputBudget.js';

const getDefuddle = lazyImport<typeof import('defuddle/node')>(
  () => import('defuddle/node'),
  'Install "defuddle" to use HTML article extraction: bun add defuddle linkedom',
);

const getLinkedom = lazyImport<typeof import('linkedom')>(
  () => import('linkedom'),
  'Install "linkedom" to use HTML article extraction: bun add defuddle linkedom',
);

/** Shape of items in defuddle's `metaTags` array. Inlined rather than imported
 *  because defuddle does not re-export `MetaTagItem` from its `node` entry. */
interface DefuddleMetaTagItem {
  content: string | null;
  name?: string | null;
  property?: string | null;
}

/** Flattens defuddle's `MetaTagItem[]` into a `Record<string, string>` keyed
 *  by `name ?? property`. Items without a usable key or content are skipped;
 *  returns `undefined` if nothing usable is left so callers can omit the
 *  field from the result entirely. */
function flattenMetaTags(
  tags: DefuddleMetaTagItem[] | undefined,
): Record<string, string> | undefined {
  if (!tags || tags.length === 0) return;
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const key = tag.name ?? tag.property;
    if (!key || tag.content == null) continue;
    out[key] = tag.content;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Options for HTML article extraction.
 */
export interface ExtractArticleOptions {
  /**
   * CSS selector to use as the main content element, bypassing auto-detection.
   * If the selector does not match any element, Defuddle falls back to
   * auto-detection.
   */
  contentSelector?: string;
  /**
   * Enable Defuddle's debug logging and bypass div flattening. Useful when
   * diagnosing why a specific page extracts poorly. Defaults to `false`.
   */
  debug?: boolean;
  /**
   * Output format for `content`. `'markdown'` converts to Markdown (the common
   * case for LLM-bound text), `'html'` returns cleaned HTML. Defaults to
   * `'markdown'`.
   */
  format?: 'html' | 'markdown';
  /**
   * Preferred language for extraction and transcript selection (BCP 47, e.g.
   * `'en'`, `'fr'`, `'ja'`).
   */
  language?: string;
  /**
   * UTF-8 input budget in bytes. Unbounded when omitted.
   */
  maxBytes?: number;
  /**
   * Strip all images from the extracted content. Defaults to `false`.
   */
  removeImages?: boolean;
  /**
   * URL of the page being parsed. Passed to Defuddle for site-specific
   * extractors and resolved link rewriting.
   */
  url?: string;
  /**
   * Allow Defuddle's async extractors to fetch from third-party APIs
   * (e.g. FxTwitter) when no local content is available in the HTML.
   * Defaults to `false` to keep extraction fully local and deterministic.
   */
  useAsync?: boolean;
}

/**
 * Result of HTML article extraction.
 *
 * All fields except `content` are best-effort — they may be undefined if the
 * source page does not provide the corresponding metadata.
 */
export interface ExtractArticleResult {
  /** Article author, if detected. */
  author?: string;
  /** Cleaned main content, either as Markdown or HTML depending on `format`. */
  content: string;
  /** Description or summary of the article, if present in page metadata. */
  description?: string;
  /** Domain of the source page (e.g. `'example.com'`), if derivable. */
  domain?: string;
  /** URL of the source site's favicon, if detected. */
  favicon?: string;
  /** URL of the article's primary image, if detected. */
  image?: string;
  /** Page language in BCP 47 format (e.g. `'en'`, `'en-US'`), if detected. */
  language?: string;
  /** Meta tags extracted from the page head, keyed by name. */
  metaTags?: Record<string, string>;
  /** Time `defuddle` spent parsing, in milliseconds. */
  parseTime?: number;
  /** Publication date string, if detected. Format is source-dependent. */
  published?: string;
  /** Raw schema.org data extracted from the page, if present. */
  schemaOrgData?: unknown;
  /** Site name, if detected (e.g. from Open Graph `og:site_name`). */
  site?: string;
  /** Article title, if detected. */
  title?: string;
  /** Word count of the extracted content, as reported by `defuddle`. */
  wordCount?: number;
}

/**
 * Utility class for extracting main article content from raw HTML.
 *
 * Lazily loads `defuddle` and `linkedom` on first use — both are optional peer
 * dependencies (`bun add defuddle linkedom`). Returns cleaned main content
 * plus best-effort metadata: title, author, description, Open Graph fields,
 * schema.org data, word count.
 *
 * Does not guarantee structure beyond "main content of the page." For quirky
 * pages, malformed HTML, or SPA shells with minimal server-rendered content,
 * the result may be sparse — callers should degrade gracefully.
 */
export class HtmlExtractor {
  /**
   * Extracts the main article content from an HTML string.
   *
   * Async due to lazy loading of `defuddle` and `linkedom`, and because
   * Defuddle's node entry is itself async (supports async fallback extractors
   * gated by `useAsync`).
   *
   * @param html - Raw HTML string to extract from.
   * @param options - Optional extraction options (format, URL, content selector, etc.).
   * @param context - Optional context for correlated logging and error metadata. The
   *   handler `Context` is accepted directly.
   * @returns Extracted content and metadata. Only `content` is guaranteed to
   *   be present; all other fields are best-effort.
   * @throws {McpError} With `ConfigurationError` if `defuddle` or `linkedom` is not installed.
   * @throws {McpError} With `ValidationError` if the HTML string is empty after trimming,
   *   or if `defuddle` fails to parse the page.
   *
   * @example
   * ```typescript
   * import { htmlExtractor } from '@/utils/parsing/htmlExtractor.js';
   *
   * const html = await fetch('https://example.com/article').then((r) => r.text());
   * const result = await htmlExtractor.extract(html, {
   *   url: 'https://example.com/article',
   *   format: 'markdown',
   * });
   *
   * console.log(result.title);
   * console.log(result.content);
   * ```
   */
  async extract(
    html: string,
    options?: ExtractArticleOptions,
    context?: RequestContextLike | RequestContext,
  ): Promise<ExtractArticleResult> {
    const byteLength = assertTextInputBudget(html, options);
    const logContext =
      context ??
      requestContextService.createRequestContext({
        operation: 'HtmlExtractor.extract',
      });

    const trimmed = html.trim();
    if (!trimmed) {
      throw validationError('HTML string is empty.', context);
    }

    const [{ Defuddle }, { parseHTML }] = await Promise.all([getDefuddle(), getLinkedom()]);

    const format = options?.format ?? 'markdown';
    const defuddleOptions: DefuddleOptions = {
      markdown: format === 'markdown',
      useAsync: options?.useAsync ?? false,
      ...(options?.contentSelector !== undefined && {
        contentSelector: options.contentSelector,
      }),
      ...(options?.removeImages !== undefined && {
        removeImages: options.removeImages,
      }),
      ...(options?.debug !== undefined && { debug: options.debug }),
      ...(options?.language !== undefined && { language: options.language }),
    };

    logger.debug('Extracting article content from HTML.', {
      ...logContext,
      byteLength,
      format,
      hasUrl: Boolean(options?.url),
      hasContentSelector: Boolean(options?.contentSelector),
    });

    try {
      const { document } = parseHTML(trimmed);
      const result = await Defuddle(document, options?.url, defuddleOptions);

      logger.debug('Successfully extracted article.', {
        ...logContext,
        wordCount: result.wordCount,
        titlePresent: Boolean(result.title),
        parseTimeMs: result.parseTime,
      });

      const out: ExtractArticleResult = { content: result.content ?? '' };
      if (result.title) out.title = result.title;
      if (result.author) out.author = result.author;
      if (result.description) out.description = result.description;
      if (result.domain) out.domain = result.domain;
      if (result.favicon) out.favicon = result.favicon;
      if (result.image) out.image = result.image;
      if (result.language) out.language = result.language;
      if (result.published) out.published = result.published;
      if (result.site) out.site = result.site;
      if (typeof result.parseTime === 'number') out.parseTime = result.parseTime;
      if (typeof result.wordCount === 'number') out.wordCount = result.wordCount;
      if (result.schemaOrgData) out.schemaOrgData = result.schemaOrgData;
      const metaTags = flattenMetaTags(result.metaTags);
      if (metaTags) out.metaTags = metaTags;
      return out;
    } catch (e: unknown) {
      if (e instanceof McpError) throw e;
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error('Failed to extract article from HTML.', {
        ...logContext,
        errorDetails: error.message,
      });
      throw validationError(
        `Failed to extract article from HTML: ${error.message}`,
        { reason: 'html_extract_failed' },
        { cause: error },
      );
    }
  }
}

/**
 * Singleton instance of {@link HtmlExtractor}.
 *
 * Prefer this over constructing a new `HtmlExtractor` directly. Lazily loads
 * `defuddle` and `linkedom` on first call, so there is no startup cost if
 * HTML extraction is never used.
 *
 * @example
 * ```typescript
 * import { htmlExtractor } from '@/utils/parsing/htmlExtractor.js';
 *
 * const article = await htmlExtractor.extract(rawHtml, {
 *   url: 'https://example.com/post',
 *   format: 'markdown',
 * });
 *
 * // Hand the content + metadata to the LLM
 * llm.prompt({ title: article.title, body: article.content });
 * ```
 */
export const htmlExtractor = new HtmlExtractor();
