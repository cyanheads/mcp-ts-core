/**
 * @fileoverview Tests for DiffFormatter utility
 * @module tests/utils/formatting/diffFormatter.test
 */
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { diffFormatter } from '@/utils/formatting/diffFormatter.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

describe('DiffFormatter', () => {
  const oldText = `function hello() {
  console.log('Hi');
}`;

  const newText = `function hello(name: string) {
  console.log(\`Hello, \${name}!\`);
}`;

  describe('diff() method', () => {
    it('should generate a unified diff for changed text', async () => {
      const result = await diffFormatter.diff(oldText, newText);

      expect(result).toBeTruthy();
      expect(result).toContain('@@'); // Unified diff header
      expect(result).toContain('-'); // Deletions
      expect(result).toContain('+'); // Additions
    });

    it.each([
      ['identical text', 'same text'],
      ['empty strings', ''],
    ])(
      'returns the raw header-only patch for %s (stripHeaders finds no @@)',
      async (_label, text) => {
        await expect(diffFormatter.diff(text, text, { format: 'unified' })).resolves.toBe(
          'Index: a/file\n===================================================================\n--- a/file\told\n+++ a/file\tnew\n',
        );
      },
    );

    it('should show additions when adding to empty text', async () => {
      const result = await diffFormatter.diff('', 'new content');

      expect(result).toContain('+'); // Addition marker
      expect(result).toContain('new content');
    });

    it('should show deletions when removing all text', async () => {
      const result = await diffFormatter.diff('old content', '');

      expect(result).toContain('-'); // Deletion marker
      expect(result).toContain('old content');
    });

    it('should respect context option', async () => {
      const largeOld = Array(20)
        .fill('line')
        .map((l, i) => `${l} ${i}`)
        .join('\n');
      const largeNew = largeOld.replace('line 10', 'modified 10');

      const diff3 = await diffFormatter.diff(largeOld, largeNew, { context: 3 });
      const diff1 = await diffFormatter.diff(largeOld, largeNew, { context: 1 });

      expect(diff3.length).toBeGreaterThan(diff1.length); // More context = more output
    });

    it('should support patch format with headers', async () => {
      const result = await diffFormatter.diff(oldText, newText, {
        format: 'patch',
        includeHeaders: true,
        oldPath: 'a/file.ts',
        newPath: 'b/file.ts',
      });

      expect(result).toContain('---'); // Old file header
      expect(result).toContain('+++'); // New file header
    });

    it('should support unified format without file headers', async () => {
      const result = await diffFormatter.diff(oldText, newText, {
        format: 'unified',
      });

      expect(result).toContain('@@'); // Hunk header
      expect(result).not.toContain('---'); // No file headers
      expect(result).not.toContain('+++'); // No file headers
    });

    it('should support patch format with includeHeaders: false', async () => {
      const result = await diffFormatter.diff(oldText, newText, {
        format: 'patch',
        includeHeaders: false,
      });

      // Should strip file headers but keep hunk markers
      expect(result).toContain('@@');
      expect(result).not.toContain('---');
      expect(result).not.toContain('+++');
    });

    it('should use visual markers and no raw diff headers in inline format', async () => {
      const inline = await diffFormatter.diff(oldText, newText, { format: 'inline' });

      expect(inline).not.toContain('@@');
      expect(inline).not.toContain('---');
      expect(inline).toContain('[-');
      expect(inline).toContain('[+');
    });
  });

  describe('diffLines() method', () => {
    it('should generate diff from line arrays', async () => {
      const oldLines = ['line 1', 'line 2', 'line 3'];
      const newLines = ['line 1', 'modified line 2', 'line 3', 'line 4'];

      const result = await diffFormatter.diffLines(oldLines, newLines);

      expect(result).toBeTruthy();
      expect(result).toContain('@@');
      expect(result).toContain('-line 2');
      expect(result).toContain('+modified line 2');
      expect(result).toContain('+line 4');
    });

    it('should handle empty line arrays', async () => {
      const result = await diffFormatter.diffLines([], []);

      // Library returns headers even for empty arrays
      expect(result).toBeTruthy();
      expect(result).not.toContain('@@'); // No hunks for identical empty arrays
    });

    it('should handle single-line arrays', async () => {
      const result = await diffFormatter.diffLines(['old'], ['new']);

      expect(result).toContain('-old');
      expect(result).toContain('+new');
    });
  });

  describe('diffWords() method', () => {
    it('should generate word-level diff', async () => {
      const old = 'The quick brown fox';
      const new_ = 'The fast brown dog';

      const result = await diffFormatter.diffWords(old, new_);

      expect(result).toContain('[-quick-]'); // Removed word
      expect(result).toContain('[+fast+]'); // Added word
      expect(result).toContain('[-fox-]');
      expect(result).toContain('[+dog+]');
      expect(result).toContain('brown'); // Unchanged word
    });

    it('should handle identical text in word diff', async () => {
      const result = await diffFormatter.diffWords('same text', 'same text');

      expect(result).toBe('same text');
      expect(result).not.toContain('[-');
      expect(result).not.toContain('[+');
    });

    it('should handle empty strings in word diff', async () => {
      const result = await diffFormatter.diffWords('', '');
      expect(result).toBe('');
    });

    it('should show all additions for empty old text', async () => {
      const result = await diffFormatter.diffWords('', 'new words here');

      expect(result).toContain('[+new words here+]');
    });

    it('should show all deletions for empty new text', async () => {
      const result = await diffFormatter.diffWords('old words here', '');

      expect(result).toContain('[-old words here-]');
    });
  });

  describe('getStats() method', () => {
    it('should return statistics for diff', async () => {
      const old = 'line 1\nline 2\nline 3';
      const new_ = 'line 1\nmodified 2\nline 3\nline 4';

      const stats = await diffFormatter.getStats(old, new_);

      expect(stats.additions).toBeGreaterThan(0);
      expect(stats.deletions).toBeGreaterThan(0);
      expect(stats.changes).toBe(stats.additions + stats.deletions);
    });

    it('should return zero stats for identical text', async () => {
      const stats = await diffFormatter.getStats('same', 'same');

      expect(stats.additions).toBe(0);
      expect(stats.deletions).toBe(0);
      expect(stats.changes).toBe(0);
    });

    it('should count only additions when adding to empty', async () => {
      const stats = await diffFormatter.getStats('', 'line 1\nline 2');

      expect(stats.additions).toBe(2);
      expect(stats.deletions).toBe(0);
      expect(stats.changes).toBe(2);
    });

    it('should count only deletions when removing all', async () => {
      const stats = await diffFormatter.getStats('line 1\nline 2', '');

      expect(stats.additions).toBe(0);
      expect(stats.deletions).toBe(2);
      expect(stats.changes).toBe(2);
    });
  });

  describe('Error handling', () => {
    it('should throw McpError for non-string oldText in diff()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diff(123, 'text')).rejects.toThrow(McpError);

      try {
        // @ts-expect-error Testing invalid input
        await diffFormatter.diff(123, 'text');
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('string');
      }
    });

    it('should throw McpError for non-string newText in diff()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diff('text', null)).rejects.toThrow(McpError);
    });

    it('should throw McpError for non-array inputs in diffLines()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diffLines('not array', ['valid'])).rejects.toThrow(McpError);

      try {
        // @ts-expect-error Testing invalid input
        await diffFormatter.diffLines('not array', ['valid']);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('array');
      }
    });

    it('should throw McpError for non-array second argument in diffLines()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diffLines(['valid'], 'not array')).rejects.toThrow(McpError);
    });

    it('should throw McpError for non-string inputs in diffWords()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diffWords(undefined, 'text')).rejects.toThrow(McpError);
    });

    it('should throw McpError for non-string second argument in diffWords()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diffWords('valid', 42)).rejects.toThrow(McpError);
    });

    it('should throw McpError for non-string second argument in diff()', async () => {
      // @ts-expect-error Testing invalid input
      await expect(diffFormatter.diff('valid', 123)).rejects.toThrow(McpError);
    });
  });

  describe('Context logging', () => {
    it('should log successful diff generation with context', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const context = requestContextService.createRequestContext({
        operation: 'test-diff',
      });

      await diffFormatter.diff('old', 'new', {}, context);

      expect(debugSpy).toHaveBeenCalledWith(
        'Diff generated successfully',
        expect.objectContaining({
          operation: 'test-diff',
        }),
      );

      debugSpy.mockRestore();
    });

    it('should create auto-generated context when none provided', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');

      await diffFormatter.diff('old', 'new');

      expect(debugSpy).toHaveBeenCalledWith(
        'Diff generated successfully',
        expect.objectContaining({
          operation: 'DiffFormatter.diff',
        }),
      );

      debugSpy.mockRestore();
    });

    it('should log word diff generation', async () => {
      const debugSpy = vi.spyOn(logger, 'debug');

      await diffFormatter.diffWords('old words', 'new words');

      expect(debugSpy).toHaveBeenCalledWith('Word diff generated successfully', expect.any(Object));

      debugSpy.mockRestore();
    });
  });

  describe('Format options', () => {
    it('should allow custom file paths in headers', async () => {
      const result = await diffFormatter.diff(oldText, newText, {
        format: 'patch',
        oldPath: 'src/old/file.ts',
        newPath: 'src/new/file.ts',
      });

      expect(result).toContain('src/old/file.ts');
      expect(result).toContain('src/new/file.ts');
    });
  });
});
