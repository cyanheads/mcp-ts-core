/**
 * @fileoverview Branch-focused tests for HTML extraction metadata and failures.
 * @module tests/utils/parsing/htmlExtractor.branches.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';

const { defuddleMock, parseHtmlMock } = vi.hoisted(() => ({
  defuddleMock: vi.fn(),
  parseHtmlMock: vi.fn(),
}));

vi.mock('defuddle/node', () => ({ Defuddle: defuddleMock }));
vi.mock('linkedom', () => ({ parseHTML: parseHtmlMock }));

import { HtmlExtractor } from '../../../../src/utils/parsing/htmlExtractor.js';

describe('HtmlExtractor branch behavior', () => {
  const extractor = new HtmlExtractor();
  const document = { nodeType: 9 };

  beforeEach(() => {
    vi.clearAllMocks();
    parseHtmlMock.mockReturnValue({ document });
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards explicit falsey options and preserves every supported metadata field', async () => {
    defuddleMock.mockResolvedValue({
      content: null,
      title: '',
      author: 'Ada',
      description: 'Description',
      domain: 'example.test',
      favicon: '/favicon.ico',
      image: '/cover.jpg',
      language: 'en',
      published: '2026-01-01',
      site: 'Example',
      parseTime: 0,
      wordCount: 0,
      schemaOrgData: { '@type': 'Article' },
      metaTags: [
        { property: 'og:type', content: 'article' },
        { name: 'empty-content', content: '' },
        { name: 'missing-content', content: null },
        { content: 'missing-key' },
      ],
    });

    const result = await extractor.extract(
      '<article>x</article>',
      {
        format: 'html',
        useAsync: false,
        contentSelector: '',
        removeImages: false,
        debug: false,
        language: '',
        url: '',
      },
      { operation: 'test', requestId: 'req-html-1', timestamp: new Date().toISOString() },
    );

    expect(defuddleMock).toHaveBeenCalledWith(document, '', {
      markdown: false,
      useAsync: false,
      contentSelector: '',
      removeImages: false,
      debug: false,
      language: '',
    });
    expect(result).toEqual({
      content: '',
      author: 'Ada',
      description: 'Description',
      domain: 'example.test',
      favicon: '/favicon.ico',
      image: '/cover.jpg',
      language: 'en',
      published: '2026-01-01',
      site: 'Example',
      parseTime: 0,
      wordCount: 0,
      schemaOrgData: { '@type': 'Article' },
      metaTags: { 'og:type': 'article', 'empty-content': '' },
    });
  });

  it('omits empty optional metadata and an unusable meta-tag collection', async () => {
    defuddleMock.mockResolvedValue({
      content: 'body',
      title: '',
      author: '',
      description: '',
      domain: '',
      favicon: '',
      image: '',
      language: '',
      published: '',
      site: '',
      parseTime: null,
      wordCount: null,
      schemaOrgData: null,
      metaTags: [{ name: null, property: null, content: 'orphan' }],
    });

    await expect(extractor.extract('<p>body</p>')).resolves.toEqual({ content: 'body' });
  });

  it('passes through framework errors unchanged', async () => {
    const failure = new McpError(JsonRpcErrorCode.ValidationError, 'already normalized');
    defuddleMock.mockRejectedValue(failure);

    await expect(extractor.extract('<p>body</p>')).rejects.toBe(failure);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('normalizes non-Error failures from the extractor', async () => {
    const marker = 'TAIL_MARKER_NOT_IN_DIAGNOSTIC';
    defuddleMock.mockRejectedValue('no readable content found');

    const failure = (await extractor
      .extract(`<p>${marker}</p>`)
      .catch((error: unknown) => error)) as McpError;

    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'Failed to extract article from HTML: no readable content found',
      data: { reason: 'html_extract_failed' },
    });
    expect(JSON.stringify({ message: failure.message, data: failure.data })).not.toContain(marker);
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it('falls back to the error string when a failure has no stack', async () => {
    const failure = new Error('stackless parser error');
    Object.defineProperty(failure, 'stack', { value: undefined });
    defuddleMock.mockRejectedValue(failure);

    const failureResult = (await extractor
      .extract('<p>body</p>')
      .catch((error: unknown) => error)) as McpError;
    expect(failureResult.message).toBe(
      'Failed to extract article from HTML: stackless parser error',
    );
    expect(failureResult.cause).toBe(failure);
  });
});
