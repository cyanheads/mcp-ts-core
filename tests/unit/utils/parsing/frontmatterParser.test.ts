/**
 * @fileoverview Unit tests for the frontmatter parser utility.
 * @module tests/utils/parsing/frontmatterParser.test
 */
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { frontmatterParser } from '@/utils/parsing/frontmatterParser.js';
import { yamlParser } from '@/utils/parsing/yamlParser.js';

describe('frontmatterParser.parse', () => {
  const createContext = () =>
    requestContextService.createRequestContext({
      operation: 'frontmatter-parser-test',
    });

  describe('valid frontmatter extraction', () => {
    it('parses markdown with valid frontmatter successfully', async () => {
      const markdown = `---
title: My Note
tags: [productivity, notes]
published: true
---

# Note Content
This is the actual note.`;

      const result = await frontmatterParser.parse<{
        title: string;
        tags: string[];
        published: boolean;
      }>(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({
        title: 'My Note',
        tags: ['productivity', 'notes'],
        published: true,
      });
      expect(result.content).toBe('# Note Content\nThis is the actual note.');
    });

    it('parses frontmatter with nested objects', async () => {
      const markdown = `---
metadata:
  author: John Doe
  version: 1.0
settings:
  enabled: true
  count: 42
---

Content here.`;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({
        metadata: {
          author: 'John Doe',
          version: 1.0,
        },
        settings: {
          enabled: true,
          count: 42,
        },
      });
      expect(result.content).toBe('Content here.');
    });

    it('handles frontmatter with context for logging', async () => {
      const context = createContext();
      const debugSpy = vi.spyOn(logger, 'debug');

      const markdown = `---
simple: value
---

Content`;

      const result = await frontmatterParser.parse(markdown, context);

      expect(result.hasFrontmatter).toBe(true);
      expect(debugSpy).toHaveBeenCalledWith(
        'Frontmatter detected, extracting and parsing.',
        expect.objectContaining({
          operation: 'frontmatter-parser-test',
        }),
      );

      debugSpy.mockRestore();
    });

    it('handles YAML with LLM think blocks via yamlParser', async () => {
      const markdown = `---
<think>processing metadata</think>
title: Test
---

Content`;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({ title: 'Test' });
      expect(result.content).toBe('Content');
    });
  });

  describe('documents without frontmatter', () => {
    it('returns original content when no frontmatter exists', async () => {
      const markdown = '# Just a heading\n\nSome content.';
      const debugSpy = vi.spyOn(logger, 'debug');

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(false);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe(markdown);
      expect(debugSpy).toHaveBeenCalledWith(
        'No frontmatter detected in markdown.',
        expect.any(Object),
      );

      debugSpy.mockRestore();
    });

    it('handles markdown with --- in the middle of content', async () => {
      const markdown = `# Title

Some content here.

---

More content after the separator.`;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(false);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe(markdown);
    });

    it('creates auto-generated context when none is provided', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const markdown = 'No frontmatter here';

      await frontmatterParser.parse(markdown);

      expect(debugSpy).toHaveBeenCalledWith(
        'No frontmatter detected in markdown.',
        expect.objectContaining({
          operation: 'FrontmatterParser.noFrontmatter',
        }),
      );

      debugSpy.mockRestore();
    });
  });

  describe('empty frontmatter', () => {
    it('handles empty frontmatter block', async () => {
      const markdown = `---
---

Content here.`;

      const debugSpy = vi.spyOn(logger, 'debug');
      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe('Content here.');
      expect(debugSpy).toHaveBeenCalledWith(
        'Empty frontmatter block detected.',
        expect.any(Object),
      );

      debugSpy.mockRestore();
    });

    it('handles frontmatter with only whitespace', async () => {
      const markdown = `---


---

Content here.`;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe('Content here.');
    });
  });

  describe('error handling', () => {
    it('throws McpError for invalid YAML in frontmatter', async () => {
      const context = createContext();
      const markdown = `---
invalid: [unterminated array
---

Content`;

      await expect(frontmatterParser.parse(markdown, context)).rejects.toThrow(McpError);

      try {
        await frontmatterParser.parse(markdown, context);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('Failed to parse YAML');
      }
    });

    it('logs parsing errors with context', async () => {
      const context = createContext();
      const errorSpy = vi.spyOn(logger, 'error');
      const markdown = `---
bad: yaml: content
---

Content`;

      await expect(frontmatterParser.parse(markdown, context)).rejects.toThrow(McpError);

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to parse YAML content.',
        expect.objectContaining({
          operation: 'frontmatter-parser-test',
        }),
      );

      errorSpy.mockRestore();
    });

    it('creates auto-generated context for errors when none provided', async () => {
      const errorSpy = vi.spyOn(logger, 'error');
      const markdown = `---
invalid yaml content here: {{{{
---

Content`;

      await expect(frontmatterParser.parse(markdown)).rejects.toThrow(McpError);

      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('normalizes a non-Error YAML parser failure', async () => {
      vi.spyOn(yamlParser, 'parse').mockRejectedValueOnce('mapping values are not allowed here');
      const markdown = '---\ntitle: Test\n---\nContent';

      await expect(frontmatterParser.parse(markdown)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'Failed to parse frontmatter content: mapping values are not allowed here',
        data: { reason: 'frontmatter_parse_failed' },
      });
    });

    it('carries the parser diagnostic in the message and keeps the sample and stack out of data', async () => {
      const marker = 'TAIL_MARKER_NOT_IN_DIAGNOSTIC';
      vi.spyOn(yamlParser, 'parse').mockRejectedValueOnce(new Error('bad indentation'));

      const failure = (await frontmatterParser
        .parse(`---\ntitle: ${marker}\n---\nContent`)
        .catch((error: unknown) => error)) as McpError;
      const cause = failure.cause as Error;

      expect(cause).toBeInstanceOf(Error);
      expect(failure.message).toBe(`Failed to parse frontmatter content: ${cause.message}`);
      expect(failure.data).toEqual({ reason: 'frontmatter_parse_failed' });
      expect(JSON.stringify({ message: failure.message, data: failure.data })).not.toContain(
        marker,
      );
    });
  });

  describe('edge cases', () => {
    it('handles frontmatter with no content after', async () => {
      const markdown = `---
title: Test
---
`;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({ title: 'Test' });
      expect(result.content).toBe('');
    });

    it('preserves formatting in markdown content', async () => {
      const markdown = `---
title: Test
---

# Heading

- List item 1
- List item 2

\`\`\`typescript
const code = true;
\`\`\``;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.content).toContain('# Heading');
      expect(result.content).toContain('```typescript');
      expect(result.content).toContain('const code = true;');
    });

    it('handles frontmatter with special YAML features (anchors, references)', async () => {
      const markdown = `---
defaults: &defaults
  timeout: 30
  retry: 3

production:
  <<: *defaults
  env: prod
---

Content`;

      const result = await frontmatterParser.parse(markdown);

      expect(result.hasFrontmatter).toBe(true);
      expect(result.frontmatter).toEqual({
        defaults: { timeout: 30, retry: 3 },
        production: { timeout: 30, retry: 3, env: 'prod' },
      });
    });

    it.each([
      ['scalar', 'plain value', 'plain value'],
      ['array', '- first\n- second', ['first', 'second']],
    ])('accepts %s YAML frontmatter without object keys', async (_kind, yaml, expected) => {
      const result = await frontmatterParser.parse(`---\n${yaml}\n---\nContent`);

      expect(result.frontmatter).toEqual(expected);
      expect(result.hasFrontmatter).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Delimiter scanning — linear-time split (#431)
// ---------------------------------------------------------------------------

/**
 * Pins every shape where the block split could diverge from the lazy,
 * line-anchored regex it replaces. Expected values are the regex's own output
 * on the same inputs.
 */
describe('frontmatterParser · delimiter scanning (#431)', () => {
  it('drops the whitespace that follows a closing delimiter', async () => {
    const result = await frontmatterParser.parse<{ title: string }>(
      '---\ntitle: a\n---   \n\n# Body',
    );
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter.title).toBe('a');
    expect(result.content).toBe('# Body');
  });

  it('handles CRLF line endings', async () => {
    const result = await frontmatterParser.parse<{ title: string }>(
      '---\r\ntitle: a\r\n---\r\n\r\n# Body',
    );
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter.title).toBe('a');
    expect(result.content).toBe('# Body');
  });

  it('closes on a `----` line and leaves the extra dash on the content', async () => {
    const result = await frontmatterParser.parse<{ title: string }>('---\ntitle: a\n----\nbody');
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter.title).toBe('a');
    expect(result.content).toBe('-\nbody');
  });

  it('ignores a `---` inside the YAML that does not start its line', async () => {
    const result = await frontmatterParser.parse<{ title: string; x: number }>(
      '---\ntitle: a --- b\nx: 1\n---\nbody',
    );
    expect(result.frontmatter).toEqual({ title: 'a --- b', x: 1 });
    expect(result.content).toBe('body');
  });

  it('returns the document unchanged when there is no closing delimiter', async () => {
    const markdown = '---\ntitle: a\nbody';
    const result = await frontmatterParser.parse(markdown);
    expect(result.hasFrontmatter).toBe(false);
    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe(markdown);
  });

  it('opens on the first line-initial `---`, not only on the first line', async () => {
    const result = await frontmatterParser.parse<{ a: number }>('# Heading\n---\na: 1\n---\nbody');
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter).toEqual({ a: 1 });
    expect(result.content).toBe('body');
  });

  it('consumes the whole whitespace run after the opening delimiter', async () => {
    const result = await frontmatterParser.parse<{ a: number }>('---   \n\n  a: 1\n---\nbody');
    expect(result.frontmatter).toEqual({ a: 1 });
    expect(result.content).toBe('body');
  });

  it('treats an empty document as having no frontmatter', async () => {
    const result = await frontmatterParser.parse('');
    expect(result.hasFrontmatter).toBe(false);
    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe('');
  });

  it('splits a 1 MiB unterminated-block payload in bounded time', async () => {
    // The issue's reproduction at the default MCP_HTTP_MAX_BODY_BYTES cap.
    const markdown = `---\n${'\n '.repeat(Math.floor((1024 * 1024 - 4) / 2))}`;
    expect(markdown.length).toBeGreaterThan(1_000_000);

    const started = performance.now();
    const result = await frontmatterParser.parse(markdown);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.hasFrontmatter).toBe(false);
  });
});
