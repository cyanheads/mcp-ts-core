import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { tool } from '../../../../src/mcp-server/tools/utils/toolDefinition.js';
import { runToolContract } from '../../../../src/testing/index.js';
import { JsonRpcErrorCode, McpError } from '../../../../src/types-global/errors.js';
import { runtimeCaps } from '../../../../src/utils/internal/runtime.js';
import { Sanitization, sanitization } from '../../../../src/utils/security/sanitization.js';

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

    it('honors an explicit transform and disabled comment preservation', async () => {
      const sanitized = await sanitization.sanitizeHtml('<!-- secret --><a href="/x">x</a>', {
        preserveComments: false,
        transformTags: {},
      });

      expect(sanitized).toBe('<a href="/x">x</a>');
      expect(sanitized).not.toContain('noopener');
    });
  });

  describe('sanitizeString', () => {
    it('defaults to plain-text sanitization when options are omitted', async () => {
      expect(await sanitization.sanitizeString('<b>plain</b>')).toBe('plain');
    });

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
    it('rejects empty and wrong-type path inputs', () => {
      expect(() => sanitization.sanitizePath('')).toThrow(
        expect.objectContaining({ message: 'Invalid path input: must be a non-empty string.' }),
      );
      expect(() => sanitization.sanitizePath(42 as unknown as string)).toThrow(
        expect.objectContaining({ message: 'Invalid path input: must be a non-empty string.' }),
      );
    });

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

    it('converts an absolute path within rootDir to a relative path', () => {
      const result = sanitization.sanitizePath('/app/safe-zone/data/file.txt', {
        rootDir: '/app/safe-zone',
      });

      expect(result.sanitizedPath).toBe('data/file.txt');
      expect(result.wasAbsolute).toBe(true);
      expect(result.convertedToRelative).toBe(true);
    });

    it('rejects path sanitization when the runtime is not Node-compatible', () => {
      const original = runtimeCaps.isNode;
      runtimeCaps.isNode = false;
      try {
        expect(() => sanitization.sanitizePath('file.txt')).toThrow(
          expect.objectContaining({
            code: JsonRpcErrorCode.InternalError,
            message: 'File-based path sanitization is not supported in this environment.',
          }),
        );
      } finally {
        runtimeCaps.isNode = original;
      }
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
      const sanitized = sanitization.sanitizeForLogging(sensitiveObject);
      expect(sanitized).toEqual({
        user: 'casey',
        credentials: {
          password: '[REDACTED]',
          session_token: '[REDACTED]',
        },
        nonSensitive: 'data',
      });
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

    it('ignores primitive array members and non-record objects', () => {
      const date = new Date('2026-01-01T00:00:00.000Z');
      const sanitized = sanitization.sanitizeForLogging([null, 1, date]) as unknown[];

      expect(sanitized[0]).toBeNull();
      expect(sanitized[1]).toBe(1);
      expect(sanitized[2]).toEqual(date);
    });
  });

  describe('serializeForLogging', () => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;

    it('returns the redacted JSON whole when it fits the cap', () => {
      const value = { query: 'q', auth: { apiKey: 'sk-1' } };

      expect(sanitization.serializeForLogging(value, 1024)).toEqual({
        text: '{"query":"q","auth":{"apiKey":"[REDACTED]"}}',
        truncated: false,
      });
      expect(value.auth.apiKey).toBe('sk-1');
    });

    it('redacts sensitive keys nested past the first levels, inside arrays', () => {
      const value = {
        a: { b: { c: { d: [{ e: { token: 't-1', clientSecret: 'cs-1', kept: 'v' } }] } } },
      };

      const { text } = sanitization.serializeForLogging(value, 4096);

      expect(JSON.parse(text)).toEqual({
        a: {
          b: { c: { d: [{ e: { token: '[REDACTED]', clientSecret: '[REDACTED]', kept: 'v' } }] } },
        },
      });
    });

    it('redacts before truncating, so no prefix of a secret survives the cut', () => {
      // Unredacted, `password` would straddle the 40-byte cut: a truncate-first
      // implementation keeps `{"padding":"xxxxxxxx","password":"hunter`.
      const value = { padding: 'xxxxxxxx', password: 'hunter2-hunter2-hunter2' };

      const { text, truncated } = sanitization.serializeForLogging(value, 40);

      expect(truncated).toBe(true);
      expect(text).toBe('{"padding":"xxxxxxxx","password":"[REDAC');
      expect(text).not.toContain('hunt');
    });

    it('keeps a payload of exactly the cap and truncates one byte over', () => {
      const text = JSON.stringify({ v: 'abc' });

      expect(sanitization.serializeForLogging({ v: 'abc' }, bytes(text))).toEqual({
        text,
        truncated: false,
      });
      expect(sanitization.serializeForLogging({ v: 'abc' }, bytes(text) - 1)).toEqual({
        text: text.slice(0, -1),
        truncated: true,
      });
    });

    it.each([
      ['a 2-byte', 'é'],
      ['a 3-byte', '€'],
      ['a 4-byte (surrogate pair)', '😀'],
    ])('never cuts inside %s character', (_label, char) => {
      const full = JSON.stringify({ s: char.repeat(50) });
      const width = bytes(char);
      // Every cap from the start of one character to just before the next.
      for (let cap = 8; cap < 8 + 2 * width; cap++) {
        const { text, truncated } = sanitization.serializeForLogging({ s: char.repeat(50) }, cap);

        expect(truncated).toBe(true);
        expect(bytes(text)).toBeLessThanOrEqual(cap);
        expect(bytes(text)).toBeGreaterThan(cap - width);
        expect(text.isWellFormed()).toBe(true);
        expect(full.startsWith(text)).toBe(true);
      }
    });

    it('serializes an empty object and a primitive', () => {
      expect(sanitization.serializeForLogging({}, 16)).toEqual({ text: '{}', truncated: false });
      expect(sanitization.serializeForLogging('plain', 16)).toEqual({
        text: '"plain"',
        truncated: false,
      });
    });

    it('returns a placeholder rather than throwing for a value JSON cannot represent', () => {
      expect(sanitization.serializeForLogging({ n: 1n }, 1024)).toEqual({
        text: '[Log Serialization Failed]',
        truncated: false,
      });
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

    it.each([
      'http://localhost:3000/mcp',
      'http://intranet/path',
      'http://127.0.0.1:8080',
      'http://[::1]:3010/',
      'https://user:pass@example.com/a?b=c#d',
      'https://müller.de',
      'HTTPS://EXAMPLE.COM',
    ])('accepts %s', async (url) => {
      expect(await sanitization.sanitizeUrl(url)).toBe(url);
    });

    it.each([
      ['a quote in the host', 'http://ex"ample.com'],
      ['a backslash in the authority', 'http://evil.com\\@good.com'],
      ['a decimal-integer IPv4 host', 'http://2130706433'],
      ['a shorthand IPv4 host', 'http://127.1'],
      ['an angle bracket', 'https://example.com/<script>'],
      ['embedded whitespace', 'https://exa mple.com'],
      ['a host-less scheme', 'mailto:someone@example.com'],
      ['a missing host', 'http:///path'],
      ['a URL over 2084 characters', `https://example.com/${'a'.repeat(2100)}`],
    ])('rejects %s', async (_label, url) => {
      await expect(sanitization.sanitizeUrl(url, ['http', 'https', 'mailto'])).rejects.toThrow(
        McpError,
      );
    });

    it('matches allowed protocols case-insensitively', async () => {
      expect(await sanitization.sanitizeUrl('sftp://files.example.com', ['SFTP'])).toBe(
        'sftp://files.example.com',
      );
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

    it('uses TextEncoder and string-length byte fallbacks outside Buffer runtimes', () => {
      const originalBuffer = runtimeCaps.hasBuffer;
      const originalEncoder = runtimeCaps.hasTextEncoder;
      try {
        runtimeCaps.hasBuffer = false;
        runtimeCaps.hasTextEncoder = true;
        expect(sanitization.sanitizeJson('"\u00e9"', 4)).toBe('é');

        runtimeCaps.hasTextEncoder = false;
        expect(sanitization.sanitizeJson('"ok"', 4)).toBe('ok');
      } finally {
        runtimeCaps.hasBuffer = originalBuffer;
        runtimeCaps.hasTextEncoder = originalEncoder;
      }
    });

    it('normalizes a non-Error JSON parser failure', () => {
      const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
        throw 'parser unavailable';
      });
      try {
        expect(() => sanitization.sanitizeJson('{"ok":true}')).toThrow(
          expect.objectContaining({ message: 'Invalid JSON format.' }),
        );
      } finally {
        parseSpy.mockRestore();
      }
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

    it.each([
      ['+1.5', 1.5],
      ['-2', -2],
      ['.5', 0.5],
      ['  42  ', 42],
    ])('parses the plain decimal %j', async (input, expected) => {
      expect(await sanitization.sanitizeNumber(input)).toBe(expected);
    });

    it.each(['', '1e5', '1,000', '1.', '0x10', '1.2.3', '--1'])(
      'rejects the non-decimal string %j',
      async (input) => {
        await expect(sanitization.sanitizeNumber(input)).rejects.toThrow(McpError);
      },
    );

    it('should clamp number to min/max range', async () => {
      expect(await sanitization.sanitizeNumber(5, 10, 20)).toBe(10);
      expect(await sanitization.sanitizeNumber(25, 10, 20)).toBe(20);
    });
  });

  describe('setSensitiveFields and getSensitiveFields', () => {
    it('returns the same singleton on subsequent access', () => {
      expect(Sanitization.getInstance()).toBe(sanitization);
    });

    it('should allow adding and retrieving sensitive fields', () => {
      const initialFields = sanitization.getSensitiveFields();
      sanitization.setSensitiveFields(['customSecret', 'customToken']);
      const updatedFields = sanitization.getSensitiveFields();
      expect(updatedFields).toContain('customsecret');
      expect(updatedFields).toContain('customtoken');
      expect(updatedFields.length).toBeGreaterThan(initialFields.length);
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

    it('normalizes a non-Error structured-clone failure', () => {
      const cloneSpy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
        throw 'clone unavailable';
      });
      try {
        expect(sanitization.sanitizeForLogging({ safe: true })).toBe('[Log Sanitization Failed]');
      } finally {
        cloneSpy.mockRestore();
      }
    });

    it('strips the style attribute to prevent CSS injection', async () => {
      // style is deliberately excluded from the default allowlist: sanitize-html
      // does not sanitize CSS values, so allowing it enables data exfiltration
      // via background:url() and UI-redress via positioning.
      const sanitized = await sanitization.sanitizeHtml(
        '<p style="position:absolute;background:url(https://evil.example/x)" class="ok">hi</p>',
      );
      expect(sanitized).not.toContain('style');
      expect(sanitized).toContain('hi');
      expect(sanitized).toContain('class="ok"');
    });

    it('strips a javascript: href from an anchor (XSS)', async () => {
      const sanitized = await sanitization.sanitizeHtml('<a href="javascript:alert(1)">click</a>');
      expect(sanitized.toLowerCase()).not.toContain('javascript:');
      expect(sanitized).toContain('click');
    });

    it('adds rel="noopener noreferrer" to anchors (reverse-tabnabbing defense)', async () => {
      const sanitized = await sanitization.sanitizeHtml(
        '<a href="https://example.com" target="_blank">go</a>',
      );
      expect(sanitized).toContain('rel="noopener noreferrer"');
      expect(sanitized).toContain('href="https://example.com"');
    });

    it('redacts authorization and cookie fields when sanitizing for logging', () => {
      const redacted = sanitization.sanitizeForLogging({
        authorization: 'Bearer super-secret-token',
        cookie: 'session=abc123',
        headers: { Authorization: 'Bearer nested' },
        safe: 'visible',
      }) as Record<string, unknown>;

      expect(redacted.authorization).toBe('[REDACTED]');
      expect(redacted.cookie).toBe('[REDACTED]');
      expect((redacted.headers as Record<string, unknown>).Authorization).toBe('[REDACTED]');
      expect(redacted.safe).toBe('visible');
    });
  });

  /**
   * Every rejection carries a stable `data.reason` a caller can branch on, and —
   * where the caller can change the input — a `data.recovery.hint`.
   */
  describe('failure reasons', () => {
    /** The McpError a sync call or a rejected promise produced. */
    async function failureOf(run: () => unknown): Promise<McpError> {
      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(McpError);
      return caught as McpError;
    }

    it.each([
      ['a non-http scheme', 'ftp://files.example.com'],
      ['a host-less string', 'not a url'],
      ['javascript:', 'javascript:alert(1)'],
    ])('sanitizeUrl rejects %s as invalid_url with the allowed schemes', async (_label, url) => {
      const error = await failureOf(() => sanitization.sanitizeUrl(url));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        input: url,
        reason: 'invalid_url',
        recovery: { hint: expect.stringContaining('http, https') },
      });
    });

    it('sanitizeUrl names a custom allow-list in its hint', async () => {
      const error = await failureOf(() => sanitization.sanitizeUrl('https://x.example', ['ftp']));

      expect(error.data?.recovery).toEqual({ hint: expect.stringContaining('ftp') });
    });

    it('sanitizeUrl still rejects an allow-listed pseudo-protocol as invalid_url', async () => {
      const error = await failureOf(() => sanitization.sanitizeUrl('data://example.com', ['data']));

      expect(error.data).toMatchObject({ reason: 'invalid_url' });
    });

    it('sanitizeString rejects the javascript context as unsupported_sanitize_context', async () => {
      const error = await failureOf(() =>
        sanitization.sanitizeString('alert(1)', { context: 'javascript' }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toEqual({ reason: 'unsupported_sanitize_context' });
    });

    it.each([
      ['an empty path', ''],
      ['a null byte', 'a\0b'],
    ])('sanitizePath rejects %s as invalid_path', async (_label, input) => {
      const error = await failureOf(() => sanitization.sanitizePath(input));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        input,
        reason: 'invalid_path',
        recovery: { hint: expect.any(String) },
      });
    });

    it.each([
      ['escaping rootDir', '../../etc/passwd', { rootDir: '/app/data' }],
      ['escaping the working directory', '../../../../outside', {}],
    ])('sanitizePath rejects a path %s as path_traversal', async (_label, input, options) => {
      const error = await failureOf(() => sanitization.sanitizePath(input, options));

      expect(error.data).toMatchObject({
        input,
        reason: 'path_traversal',
        recovery: { hint: expect.stringContaining('relative path') },
      });
    });

    it('sanitizePath rejects an absolute path as absolute_path_disallowed', async () => {
      const error = await failureOf(() => sanitization.sanitizePath('/etc/passwd'));

      expect(error.data).toMatchObject({
        input: '/etc/passwd',
        reason: 'absolute_path_disallowed',
        recovery: { hint: expect.stringContaining('relative path') },
      });
    });

    it('sanitizeJson rejects an oversized payload as json_too_large, naming the cap', async () => {
      const error = await failureOf(() => sanitization.sanitizeJson('{"big":"value"}', 5));

      expect(error.data).toMatchObject({
        actualSize: 15,
        maxSize: 5,
        reason: 'json_too_large',
        recovery: { hint: expect.stringContaining('5 bytes') },
      });
    });

    it.each([
      ['malformed JSON', '{bad json}'],
      ['a non-string', 42 as unknown as string],
    ])('sanitizeJson rejects %s as invalid_json', async (_label, input) => {
      const error = await failureOf(() => sanitization.sanitizeJson(input));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'invalid_json',
        recovery: { hint: expect.any(String) },
      });
    });

    it.each([
      ['a non-numeric string', 'abc'],
      ['an exponent', '1e5'],
      ['a wrong type', { value: 1 } as unknown as string],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['NaN', Number.NaN],
    ])('sanitizeNumber rejects %s as invalid_number', async (_label, input) => {
      const error = await failureOf(() => sanitization.sanitizeNumber(input));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'invalid_number',
        recovery: { hint: expect.stringContaining('finite decimal number') },
      });
    });

    it('reaches both tool surfaces: structuredContent.error.data and the content[] trailer', async () => {
      const definition = tool('sanitize_url_probe', {
        description: 'Echoes a sanitized URL.',
        input: z.object({ url: z.string().describe('URL to sanitize') }),
        output: z.object({ url: z.string().describe('The sanitized URL') }),
        handler: async (input) => ({ url: await sanitization.sanitizeUrl(input.url) }),
      });

      const result = await runToolContract(definition, { url: 'ftp://files.example.com' });

      expect(result.isError).toBe(true);
      const envelope = (result.structuredContent as { error: { code: number; data: unknown } })
        .error;
      expect(envelope.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(envelope.data).toMatchObject({ reason: 'invalid_url' });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Recovery: Provide an absolute URL');
      expect(text).toContain('(reason invalid_url)');
    });
  });
});
