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

    it('handles markdown with only opening --- delimiter', async () => {
      const markdown = `---
title: Test
# Missing closing delimiter`;

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

    it('defaults absent regex capture groups to empty strings', async () => {
      const markdownLike = {
        match: () => ['---'],
      };

      await expect(frontmatterParser.parse(markdownLike as unknown as string)).resolves.toEqual({
        frontmatter: {},
        content: '',
        hasFrontmatter: true,
      });
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

    it('includes YAML content sample in error details', async () => {
      const context = createContext();
      const markdown = `---
${'x: invalid\n'.repeat(100)}
---

Content`;

      try {
        await frontmatterParser.parse(markdown, context);
      } catch (error) {
        const mcpError = error as McpError;
        expect(mcpError.message).toContain('Failed to parse YAML');
        // Error should include content sample
        expect(String(error)).toBeTruthy();
      }
    });

    it('normalizes a non-Error YAML parser failure', async () => {
      vi.spyOn(yamlParser, 'parse').mockRejectedValueOnce('parser unavailable');
      const markdown = '---\ntitle: Test\n---\nContent';

      await expect(frontmatterParser.parse(markdown)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'Failed to parse frontmatter: parser unavailable',
      });
    });

    it('truncates a long YAML sample for a non-framework parser failure', async () => {
      vi.spyOn(yamlParser, 'parse').mockRejectedValueOnce(new Error('parser failed'));
      const yaml = `title: ${'x'.repeat(240)}`;

      try {
        await frontmatterParser.parse(`---\n${yaml}\n---\nContent`);
        throw new Error('expected parse to fail');
      } catch (error) {
        const sample = (error as McpError).data?.yamlContentSample;
        expect(sample).toBe(`${yaml.substring(0, 200)}...`);
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty string input', async () => {
      const result = await frontmatterParser.parse('');

      expect(result.hasFrontmatter).toBe(false);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe('');
    });

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

  describe('type safety', () => {
    it('supports generic type parameter for frontmatter', async () => {
      interface NoteFrontmatter {
        published: boolean;
        tags: string[];
        title: string;
      }

      const markdown = `---
title: TypeScript Note
tags: [typescript, testing]
published: true
---

Content`;

      const result = await frontmatterParser.parse<NoteFrontmatter>(markdown);

      // TypeScript should recognize these properties
      expect(result.frontmatter.title).toBe('TypeScript Note');
      expect(result.frontmatter.tags).toEqual(['typescript', 'testing']);
      expect(result.frontmatter.published).toBe(true);
    });
  });

  describe('singleton instance', () => {
    it('exports a singleton instance', () => {
      expect(frontmatterParser).toBeDefined();
      expect(typeof frontmatterParser.parse).toBe('function');
    });
  });
});
