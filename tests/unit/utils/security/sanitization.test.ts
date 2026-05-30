import { describe, expect, it } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { sanitization } from '../../../../src/utils/security/sanitization.js';

describe('Sanitization Utility', () => {
  describe('sanitizeHtml', () => {
    it('should remove <script> tags and other malicious HTML', async () => {
      const maliciousInput =
        '<script>alert("xss")</script><p>Hello</p><iframe src="http://example.com"></iframe>';
      const expectedOutput = '<p>Hello</p>';
      expect(await sanitization.sanitizeHtml(maliciousInput)).toBe(expectedOutput);
    });

    it('should allow safe HTML tags like <p> and <b>', async () => {
      const safeInput = '<p>This is a <b>bold</b> statement.</p>';
      expect(await sanitization.sanitizeHtml(safeInput)).toBe(safeInput);
    });

    it('should return an empty string for null or undefined input', async () => {
      expect(await sanitization.sanitizeHtml(null as unknown as string)).toBe('');
      expect(await sanitization.sanitizeHtml(undefined as unknown as string)).toBe('');
    });
  });

  describe('sanitizeString', () => {
    it('should handle "text" context by stripping all HTML', async () => {
      const input = '<p>Hello World</p>';
      const expected = 'Hello World';
      expect(await sanitization.sanitizeString(input, { context: 'text' })).toBe(expected);
    });

    it('should handle "html" context correctly', async () => {
      const maliciousInput = '<script>alert("xss")</script><p>Hello</p>';
      const expected = '<p>Hello</p>';
      expect(await sanitization.sanitizeString(maliciousInput, { context: 'html' })).toBe(expected);
    });

    it('supports explicit tag and attribute whitelists for HTML sanitization', async () => {
      const input = '<a href="https://example.com" onclick="alert(1)">Read more</a>';
      const sanitized = await sanitization.sanitizeString(input, {
        context: 'html',
        allowedTags: ['a'],
        allowedAttributes: {
          a: ['href'],
        },
      });

      expect(sanitized).toBe('<a href="https://example.com">Read more</a>');
    });

    it('should handle "url" context and return empty for invalid URLs', async () => {
      const validInput = 'https://example.com/path';
      const invalidUrl = 'javascript:alert("xss")';
      expect(await sanitization.sanitizeString(validInput, { context: 'url' })).toBe(validInput);
      expect(await sanitization.sanitizeString(invalidUrl, { context: 'url' })).toBe('');
    });

    it('should throw an McpError when context is "javascript"', async () => {
      const jsInput = 'alert("hello")';
      await expect(sanitization.sanitizeString(jsInput, { context: 'javascript' })).rejects.toThrow(
        McpError,
      );
      await expect(sanitization.sanitizeString(jsInput, { context: 'javascript' })).rejects.toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
      );
    });
  });

  describe('sanitizePath', () => {
    it('should prevent path traversal with ../ by normalizing', () => {
      const traversalPath = 'a/b/../c';
      const result = sanitization.sanitizePath(traversalPath);
      expect(result.sanitizedPath).toBe('a/c');
    });

    it('should throw an error for paths containing null bytes (\\0)', () => {
      const nullBytePath = '/path/to/file\0.txt';
      expect(() => sanitization.sanitizePath(nullBytePath)).toThrow(McpError);
      expect(() => sanitization.sanitizePath(nullBytePath)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.ValidationError,
          message: 'Path contains null byte, which is disallowed.',
        }),
      );
    });

    it('should respect the rootDir option and throw if path escapes it', () => {
      const rootDir = '/app/safe-zone';
      const validPath = 'data/file.txt';
      // This path attempts to go up one level from the root.
      const invalidPath = '../outside.txt';

      // The sanitized path should be relative to the rootDir.
      expect(sanitization.sanitizePath(validPath, { rootDir }).sanitizedPath).toBe('data/file.txt');

      // This should throw because it tries to leave the root directory.
      expect(() => sanitization.sanitizePath(invalidPath, { rootDir })).toThrow(McpError);
    });

    it('should handle absolute paths correctly based on the allowAbsolute option', () => {
      const absolutePath = '/etc/passwd';
      // By default, absolute paths are not allowed and should throw.
      expect(() => sanitization.sanitizePath(absolutePath, { allowAbsolute: false })).toThrow(
        McpError,
      );
      // When allowed, the path should be returned as is.
      expect(sanitization.sanitizePath(absolutePath, { allowAbsolute: true }).sanitizedPath).toBe(
        absolutePath,
      );
    });
  });

  describe('sanitizeForLogging', () => {
    it('should redact sensitive keys like "password", "token", and "apiKey" in a flat object', () => {
      const sensitiveObject = {
        username: 'test',
        password: 'my-secret-password',
        session_token: 'abc-123',
        secretKey: 'xyz-789',
      };
      const sanitized = sanitization.sanitizeForLogging(sensitiveObject) as Record<string, unknown>;
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.session_token).toBe('[REDACTED]');
      expect(sanitized.secretKey).toBe('[REDACTED]');
      expect(sanitized.username).toBe('test');
    });

    it('should redact sensitive keys in a deeply nested object', () => {
      const sensitiveObject = {
        user: 'casey',
        credentials: {
          password: 'my-secret-password',
          session_token: 'abc-123-def-456',
        },
        nonSensitive: 'data',
      };
      const sanitized = sanitization.sanitizeForLogging(sensitiveObject) as Record<string, unknown>;
      expect(sanitized).toBeDefined();
      if (sanitized && typeof sanitized === 'object' && 'credentials' in sanitized) {
        const creds = sanitized.credentials as Record<string, unknown>;
        expect(creds.password).toBe('[REDACTED]');
        expect(creds.session_token).toBe('[REDACTED]');
      }
      expect((sanitized as Record<string, unknown>).nonSensitive).toBe('data');
    });

    it('should not modify non-sensitive keys', () => {
      const nonSensitive = { user: 'casey', id: 123 };
      const sanitized = sanitization.sanitizeForLogging(nonSensitive);
      expect(sanitized).toEqual(nonSensitive);
    });

    it('should handle arrays of objects correctly', () => {
      const sensitiveArray = [
        { user: 'a', password: '123' },
        { user: 'b', apiKey: '456' },
      ];
      const sanitized = sanitization.sanitizeForLogging(sensitiveArray) as Record<
        string,
        unknown
      >[];

      expect(sanitized).toBeDefined();
      expect(Array.isArray(sanitized)).toBe(true);

      if (Array.isArray(sanitized)) {
        expect(sanitized[0]).toBeDefined();
        expect(sanitized[1]).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(sanitized[0]?.password).toBe('[REDACTED]');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(sanitized[1]?.apiKey).toBe('[REDACTED]');
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(sanitized[0]?.user).toBe('a');
      }
    });

    it('should handle edge case where nested property is undefined', () => {
      const sensitiveObject = {
        user: 'casey',
        nonSensitive: 'data',
      };
      const sanitized = sanitization.sanitizeForLogging(sensitiveObject) as Record<string, unknown>;
      expect(sanitized).toBeDefined();
      expect((sanitized as Record<string, unknown>).nonSensitive).toBe('data');
    });
  });

  // Adding tests for other public methods to ensure full coverage
  describe('sanitizeUrl', () => {
    it('should return a valid URL', async () => {
      const url = 'https://example.com';
      expect(await sanitization.sanitizeUrl(url)).toBe(url);
    });

    it('should throw for invalid URL', async () => {
      const url = 'not-a-url';
      await expect(sanitization.sanitizeUrl(url)).rejects.toThrow(McpError);
    });

    it('should throw for disallowed protocols', async () => {
      const url = 'ftp://example.com';
      await expect(sanitization.sanitizeUrl(url)).rejects.toThrow(McpError);
    });
  });

  describe('sanitizeJson', () => {
    it('should parse a valid JSON string', () => {
      const json = '{"key": "value"}';
      expect(sanitization.sanitizeJson(json)).toEqual({ key: 'value' });
    });

    it('should throw for an invalid JSON string', () => {
      const json = '{"key": "value"';
      expect(() => sanitization.sanitizeJson(json)).toThrow(McpError);
    });

    it('should throw if JSON size exceeds maxSize', () => {
      const json = '{"key": "value"}';
      expect(() => sanitization.sanitizeJson(json, 5)).toThrow(McpError);
    });
  });

  describe('sanitizeNumber', () => {
    it('should return a valid number', async () => {
      expect(await sanitization.sanitizeNumber(123)).toBe(123);
      expect(await sanitization.sanitizeNumber('123.45')).toBe(123.45);
    });

    it('should throw for an invalid number string', async () => {
      await expect(sanitization.sanitizeNumber('abc')).rejects.toThrow(McpError);
    });

    it('should clamp number to min/max range', async () => {
      expect(await sanitization.sanitizeNumber(5, 10, 20)).toBe(10);
      expect(await sanitization.sanitizeNumber(25, 10, 20)).toBe(20);
    });
  });

  describe('setSensitiveFields and getSensitiveFields', () => {
    it('should allow adding and retrieving sensitive fields', () => {
      const initialFields = sanitization.getSensitiveFields();
      sanitization.setSensitiveFields(['customSecret', 'customToken']);
      const updatedFields = sanitization.getSensitiveFields();
      expect(updatedFields).toContain('customsecret');
      expect(updatedFields).toContain('customtoken');
      expect(updatedFields.length).toBeGreaterThan(initialFields.length);
    });

    it('should return pino-compliant wildcard redact paths', () => {
      const pinoFields = sanitization.getSensitivePinoFields();
      expect(Array.isArray(pinoFields)).toBe(true);
      // Each sensitive field should generate three paths for nested matching
      const baseFields = sanitization.getSensitiveFields();
      for (const field of baseFields) {
        expect(pinoFields).toContain(field); // top-level
        expect(pinoFields).toContain(`*.${field}`); // one level deep
        expect(pinoFields).toContain(`*.*.${field}`); // two levels deep
      }
      expect(pinoFields.length).toBe(baseFields.length * 3);
    });
  });

  describe('security edge cases', () => {
    it('strips all tags in the "attribute" context', async () => {
      const sanitized = await sanitization.sanitizeString('<b>danger</b>"onload="x', {
        context: 'attribute',
      });
      expect(sanitized).not.toContain('<b>');
      expect(sanitized).toContain('danger');
    });

    it('rejects a pseudo-protocol URL even when its scheme is explicitly allow-listed', async () => {
      // isURL accepts the scheme, but the explicit pseudo-protocol guard still rejects it.
      await expect(sanitization.sanitizeUrl('data://example.com', ['data'])).rejects.toThrow(
        McpError,
      );
    });

    it('converts backslashes to forward slashes with toPosix', () => {
      const result = sanitization.sanitizePath('sub\\dir\\file.txt', { toPosix: true });
      expect(result.sanitizedPath).not.toContain('\\');
    });

    it('returns "." when a path resolves to exactly the root directory', () => {
      const result = sanitization.sanitizePath('.', { rootDir: '/app/data' });
      expect(result.sanitizedPath).toBe('.');
    });

    it('rejects relative traversal that escapes the working directory (no rootDir)', () => {
      expect(() => sanitization.sanitizePath('../../../../etc/passwd')).toThrow(
        expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
      );
    });

    it('rejects non-string input to sanitizeJson', () => {
      expect(() => sanitization.sanitizeJson(123 as unknown as string)).toThrow(
        expect.objectContaining({ message: 'Invalid input: expected a JSON string.' }),
      );
    });

    it('truncates the input preview for long invalid JSON', () => {
      const longInvalid = `{${'"a":1,'.repeat(40)}`; // > 100 chars, missing closing brace
      try {
        sanitization.sanitizeJson(longInvalid);
        throw new Error('expected throw');
      } catch (error) {
        const preview = (error as McpError).data?.inputPreview as string;
        expect(preview.endsWith('...')).toBe(true);
      }
    });

    it('rejects a non-number, non-string input type to sanitizeNumber', async () => {
      await expect(sanitization.sanitizeNumber(null as unknown as number)).rejects.toThrow(
        expect.objectContaining({ message: 'Invalid input type: expected number or string.' }),
      );
    });

    it('rejects Infinity in sanitizeNumber', async () => {
      await expect(sanitization.sanitizeNumber(Number.POSITIVE_INFINITY)).rejects.toThrow(
        expect.objectContaining({ message: 'Invalid number value (NaN or Infinity).' }),
      );
    });

    it('degrades to a placeholder when the log input cannot be structured-cloned', () => {
      // A function value makes structuredClone throw — the method must not propagate.
      const result = sanitization.sanitizeForLogging({ work: () => 'noop' });
      expect(result).toBe('[Log Sanitization Failed]');
    });
  });
});
