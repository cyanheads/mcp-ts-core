/**
 * @fileoverview Tests for devdocs.ts pattern matching functionality
 * @module tests/scripts/devdocs
 * @description
 *   Validates the security-hardened glob pattern matching with proper regex escaping.
 *   Ensures protection against regex injection and ReDoS attacks.
 */

import { describe, expect, it } from 'vitest';

import { matchesPattern } from '../../../scripts/devdocs.js';

describe('devdocs.ts - matchesPattern', () => {
  describe('Basic glob pattern matching', () => {
    it('should match single asterisk wildcard', () => {
      expect(matchesPattern('test.ts', ['*.ts'])).toBe(true);
      expect(matchesPattern('file.test.ts', ['*.test.ts'])).toBe(true);
      expect(matchesPattern('src/test.ts', ['*.ts'])).toBe(false); // * doesn't match /
    });

    it('should match double asterisk wildcard', () => {
      expect(matchesPattern('src/utils/test.ts', ['**/*.ts'])).toBe(true);
      expect(matchesPattern('test.ts', ['**/*.ts'])).toBe(true);
      expect(matchesPattern('a/b/c/test.ts', ['**/*.ts'])).toBe(true);
    });

    it('should match exact file names', () => {
      expect(matchesPattern('test.ts', ['test.ts'])).toBe(true);
      expect(matchesPattern('test.js', ['test.ts'])).toBe(false);
    });

    it('should handle directory patterns', () => {
      expect(matchesPattern('__tests__/unit/test.ts', ['__tests__/**'])).toBe(true);
      expect(matchesPattern('src/__tests__/test.ts', ['**/__tests__/**'])).toBe(true);
    });

    it('should return false for empty patterns array', () => {
      expect(matchesPattern('any/file.ts', [])).toBe(false);
    });

    it('should match ? as exactly one non-slash character', () => {
      expect(matchesPattern('test1.ts', ['test?.ts'])).toBe(true);
      expect(matchesPattern('test.ts', ['test?.ts'])).toBe(false);
      expect(matchesPattern('test12.ts', ['test?.ts'])).toBe(false);
      expect(matchesPattern('a/b.ts', ['a?b.ts'])).toBe(false);
    });

    it('should strip leading ./ from both path and pattern', () => {
      expect(matchesPattern('./src/index.ts', ['src/*.ts'])).toBe(true);
      expect(matchesPattern('src/index.ts', ['./src/*.ts'])).toBe(true);
      expect(matchesPattern('././src/index.ts', ['./././src/**'])).toBe(true);
    });

    it('should match if ANY pattern matches (OR logic)', () => {
      const patterns = ['*.test.ts', '*.spec.ts', '__tests__/**'];
      expect(matchesPattern('file.test.ts', patterns)).toBe(true);
      expect(matchesPattern('file.spec.ts', patterns)).toBe(true);
      expect(matchesPattern('__tests__/unit.ts', patterns)).toBe(true);
      expect(matchesPattern('regular.ts', patterns)).toBe(false);
    });
  });

  describe('Security: Regex special character escaping', () => {
    it('should escape dots correctly (prevent matching any character)', () => {
      // Without escaping, '.' would match any character
      expect(matchesPattern('testXts', ['test.ts'])).toBe(false);
      expect(matchesPattern('test.ts', ['test.ts'])).toBe(true);
    });

    it('should escape backslashes correctly', () => {
      // Backslash should be treated literally, not as escape character
      expect(matchesPattern('test\\file.ts', ['test\\file.ts'])).toBe(true);
      expect(matchesPattern('testfile.ts', ['test\\file.ts'])).toBe(false);
    });

    it('should escape square brackets correctly', () => {
      // Square brackets should be treated literally, not as character class
      expect(matchesPattern('test[0].ts', ['test[0].ts'])).toBe(true);
      expect(matchesPattern('test0.ts', ['test[0].ts'])).toBe(false);
      expect(matchesPattern('test[0-9].ts', ['test[0-9].ts'])).toBe(true);
      expect(matchesPattern('test5.ts', ['test[0-9].ts'])).toBe(false);
    });

    it('should escape parentheses correctly', () => {
      expect(matchesPattern('test(1).ts', ['test(1).ts'])).toBe(true);
      expect(matchesPattern('test1.ts', ['test(1).ts'])).toBe(false);
    });

    it('should escape plus signs correctly', () => {
      expect(matchesPattern('test+file.ts', ['test+file.ts'])).toBe(true);
      expect(matchesPattern('testfile.ts', ['test+file.ts'])).toBe(false);
    });

    it('should escape caret correctly', () => {
      expect(matchesPattern('test^file.ts', ['test^file.ts'])).toBe(true);
      expect(matchesPattern('testfile.ts', ['test^file.ts'])).toBe(false);
    });

    it('should escape dollar sign correctly', () => {
      expect(matchesPattern('test$file.ts', ['test$file.ts'])).toBe(true);
      expect(matchesPattern('testfile.ts', ['test$file.ts'])).toBe(false);
    });

    it('should escape curly braces correctly', () => {
      expect(matchesPattern('test{1,2}.ts', ['test{1,2}.ts'])).toBe(true);
      expect(matchesPattern('test1.ts', ['test{1,2}.ts'])).toBe(false);
    });

    it('should escape pipe character correctly', () => {
      expect(matchesPattern('test|file.ts', ['test|file.ts'])).toBe(true);
      expect(matchesPattern('testfile.ts', ['test|file.ts'])).toBe(false);
    });
  });

  describe('Security: ReDoS prevention', () => {
    it('should handle patterns with multiple asterisks safely', () => {
      // These patterns should not cause catastrophic backtracking
      const patterns = ['**/**/**/*.ts', '*****.ts', 'a*b*c*d*e*f*.ts'];

      // Should complete quickly without hanging
      const start = Date.now();
      const result = matchesPattern('a/b/c/d/e/f/test.ts', patterns);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100); // Should be nearly instantaneous
      expect(result).toBe(true);
    });

    it('should handle deeply nested patterns efficiently', () => {
      const deepPattern = 'a/**/b/**/c/**/d/**/e/**/test.ts';
      const deepPath = 'a/1/b/2/c/3/d/4/e/5/test.ts';

      const start = Date.now();
      const result = matchesPattern(deepPath, [deepPattern]);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
      expect(result).toBe(true);
    });

    it('should handle very long file paths efficiently', () => {
      const longPath = `${'a/'.repeat(100)}test.ts`;
      const pattern = '**/*.ts';

      const start = Date.now();
      const result = matchesPattern(longPath, [pattern]);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
      expect(result).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      expect(matchesPattern('', ['*.ts'])).toBe(false);
      expect(matchesPattern('test.ts', [''])).toBe(false);
      expect(matchesPattern('', [''])).toBe(true);
    });

    it('should handle patterns with no wildcards', () => {
      expect(matchesPattern('exact-match.ts', ['exact-match.ts'])).toBe(true);
      expect(matchesPattern('different.ts', ['exact-match.ts'])).toBe(false);
    });

    it('should handle patterns with leading/trailing slashes', () => {
      expect(matchesPattern('/src/test.ts', ['/**/test.ts'])).toBe(true);
      expect(matchesPattern('src/test.ts/', ['**/test.ts/'])).toBe(true);
    });

    it('should handle Unicode characters', () => {
      expect(matchesPattern('test-文件.ts', ['test-文件.ts'])).toBe(true);
      expect(matchesPattern('test-файл.ts', ['test-*.ts'])).toBe(true);
      expect(matchesPattern('test-🚀.ts', ['test-*.ts'])).toBe(true);
    });

    it('should handle multiple consecutive wildcards', () => {
      expect(matchesPattern('a/b/c/test.ts', ['a/**/b/**/test.ts'])).toBe(true);
      expect(matchesPattern('test.ts', ['**/**/*.ts'])).toBe(true);
    });

    it('should require a full-path match (no substring matching)', () => {
      expect(matchesPattern('path/to/some/file.ts', ['some'])).toBe(false);
      expect(matchesPattern('path/to/some/file.ts', ['**/some/**'])).toBe(true);
    });
  });

  describe('Real-world patterns from devdocs usage', () => {
    it('should match typical test exclusion patterns', () => {
      const testExclusions = ['*.test.ts', '*.spec.ts', '**/__tests__/**'];

      // Note: *.test.ts only matches files at root (no / allowed in *)
      expect(matchesPattern('utils.test.ts', testExclusions)).toBe(true);
      expect(matchesPattern('helper.spec.ts', testExclusions)).toBe(true);
      expect(matchesPattern('src/__tests__/unit/test.ts', testExclusions)).toBe(true);
      expect(matchesPattern('src/utils.ts', testExclusions)).toBe(false);
      // For nested files, we'd use **/*.test.ts pattern
      expect(matchesPattern('src/utils.test.ts', ['**/*.test.ts'])).toBe(true);
    });

    it('should match build output patterns', () => {
      const buildPatterns = ['dist/**', 'build/**', '*.map'];

      expect(matchesPattern('dist/index.js', buildPatterns)).toBe(true);
      expect(matchesPattern('build/bundle.js', buildPatterns)).toBe(true);
      // *.map only matches files at root
      expect(matchesPattern('index.js.map', buildPatterns)).toBe(true);
      expect(matchesPattern('src/index.ts', buildPatterns)).toBe(false);
      // For nested .map files, use **/*.map
      expect(matchesPattern('src/index.js.map', ['**/*.map'])).toBe(true);
    });

    it('should match dependency patterns', () => {
      const depPatterns = ['node_modules/**', '.git/**', '.vscode/**'];

      expect(matchesPattern('node_modules/pkg/index.js', depPatterns)).toBe(true);
      expect(matchesPattern('.git/config', depPatterns)).toBe(true);
      expect(matchesPattern('.vscode/settings.json', depPatterns)).toBe(true);
      expect(matchesPattern('src/index.ts', depPatterns)).toBe(false);
    });
  });

  describe('Security regression tests', () => {
    it('should not allow regex injection via backslash escapes', () => {
      // Attempt to inject regex patterns - should match literally, not as regex
      // '.' is literal; '*' stays a glob wildcard
      expect(matchesPattern('anything.ts', ['.*'])).toBe(false);
      expect(matchesPattern('.env', ['.*'])).toBe(true);
      expect(matchesPattern('test123.ts', ['\\d+'])).toBe(false);
    });

    it('should not allow alternation injection via pipe character', () => {
      // Pipe should be treated literally, not as alternation
      expect(matchesPattern('test.ts', ['test|other'])).toBe(false);
      expect(matchesPattern('test|other', ['test|other'])).toBe(true);
    });

    it('should not allow character class injection', () => {
      // Character classes should be treated literally
      expect(matchesPattern('a', ['[abc]'])).toBe(false);
      expect(matchesPattern('[abc]', ['[abc]'])).toBe(true);
    });
  });
});
