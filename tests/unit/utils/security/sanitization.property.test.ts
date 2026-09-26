/**
 * @fileoverview Property-based tests for the Sanitization module.
 * Uses fast-check to generate arbitrary inputs and verify invariants
 * that must hold for ALL inputs, catching edge cases hand-written tests miss.
 * @module tests/utils/security/sanitization.property
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { McpError } from '@/types-global/errors.js';
import { sanitization } from '@/utils/security/sanitization.js';

/**
 * Markup built from script-tag fragments, including split and nested forms
 * (`<scr<script>ipt>`) that only reassemble after a naive strip. `fc.string()`
 * alone never produces `<script`.
 */
const scriptMarkup = fc.oneof(
  fc.string(),
  fc
    .array(
      fc.oneof(
        fc.constantFrom(
          '<script>',
          '<SCRIPT src="x">',
          '</script>',
          '<scr',
          'ipt>',
          'alert(1)',
          '<p>',
          '</p>',
        ),
        fc.string({ maxLength: 4 }),
      ),
      { minLength: 1, maxLength: 12 },
    )
    .map((parts) => parts.join('')),
);

describe('Sanitization Property-Based Tests', () => {
  describe('sanitizeHtml', () => {
    it('output should never contain <script> tags', async () => {
      await fc.assert(
        fc.asyncProperty(scriptMarkup, async (input) => {
          const result = await sanitization.sanitizeHtml(input);
          expect(typeof result).toBe('string');
          expect(result.toLowerCase()).not.toContain('<script');
        }),
        {
          numRuns: 200,
          examples: [['<script>alert(1)</script>'], ['<scr<script>ipt>alert(1)</script>']],
        },
      );
    });

    it('should be idempotent — sanitizing twice gives same result', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (input) => {
          const once = await sanitization.sanitizeHtml(input);
          const twice = await sanitization.sanitizeHtml(once);
          expect(twice).toBe(once);
        }),
        { numRuns: 200 },
      );
    });

    it('output should never contain event handler attributes', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (input) => {
          const result = await sanitization.sanitizeHtml(input);
          /**
           * Inside a tag only — `on0=` as text content is inert, and a literal
           * `<` in text leaves the sanitizer as `&lt;`.
           */
          expect(result.toLowerCase()).not.toMatch(/<[^>]*\son\w+\s*=/);
        }),
        { numRuns: 200, examples: [['on0='], ['<p>onclick=1</p>']] },
      );
    });
  });

  describe('sanitizeString (text context)', () => {
    it('output should contain no HTML tags in text mode', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (input) => {
          const result = await sanitization.sanitizeString(input, {
            context: 'text',
          });
          expect(result).not.toMatch(/<[a-z][^>]*>/i);
        }),
        { numRuns: 200 },
      );
    });

    it('should be idempotent in text mode', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (input) => {
          const once = await sanitization.sanitizeString(input, { context: 'text' });
          const twice = await sanitization.sanitizeString(once, { context: 'text' });
          expect(twice).toBe(once);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('sanitizeUrl', () => {
    it('should throw McpError for javascript: URLs', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (suffix) => {
          const input = `javascript:${suffix}`;
          await expect(sanitization.sanitizeUrl(input)).rejects.toThrow(McpError);
        }),
        { numRuns: 100 },
      );
    });

    it('should throw McpError for invalid/empty URLs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string().filter((s) => {
            // Keep only strings that are clearly not valid http(s) URLs — `http:host`
            // without slashes is a valid special-scheme URL, so the scheme alone disqualifies
            const t = s.trim().toLowerCase();
            return !t.startsWith('http:') && !t.startsWith('https:');
          }),
          async (input) => {
            await expect(sanitization.sanitizeUrl(input)).rejects.toThrow(McpError);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should preserve valid https URLs', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.webUrl({ withFragments: true, withQueryParameters: true }),
          async (url) => {
            expect(await sanitization.sanitizeUrl(url)).toBe(url);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('sanitizeJson', () => {
    it('should round-trip valid JSON objects', () => {
      fc.assert(
        fc.property(
          fc.record({
            key: fc.string(),
            value: fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          }),
          (obj) => {
            const json = JSON.stringify(obj);
            const result = sanitization.sanitizeJson(json);
            expect(result).toEqual(obj);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('should throw on invalid JSON strings', () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => {
            try {
              JSON.parse(s);
              return false;
            } catch {
              return true;
            }
          }),
          (invalid) => {
            expect(() => sanitization.sanitizeJson(invalid)).toThrow();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('sanitizeNumber', () => {
    it('should clamp numbers to min/max range', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Use integer range to avoid subnormal float edge cases
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
          async (value, a, b) => {
            const min = Math.min(a, b);
            const max = Math.max(a, b);
            if (min === max) return;

            const result = await sanitization.sanitizeNumber(value, min, max);
            expect(result).toBeGreaterThanOrEqual(min);
            expect(result).toBeLessThanOrEqual(max);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('should throw for NaN and Infinity', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(NaN, Infinity, -Infinity), async (value) => {
          await expect(sanitization.sanitizeNumber(value)).rejects.toThrow(McpError);
        }),
        { numRuns: 10 },
      );
    });

    it('should accept any finite number without min/max', async () => {
      await fc.assert(
        fc.asyncProperty(fc.double({ noNaN: true, noDefaultInfinity: true }), async (value) => {
          const result = await sanitization.sanitizeNumber(value);
          expect(typeof result).toBe('number');
          expect(result).toBe(value);
        }),
        { numRuns: 200 },
      );
    });

    it('should parse valid numeric strings', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: -1_000_000, max: 1_000_000 }), async (value) => {
          const result = await sanitization.sanitizeNumber(String(value));
          expect(result).toBe(value);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('sanitizeForLogging', () => {
    it('should redact sensitive fields in objects', () => {
      const sensitiveKeys = ['password', 'token', 'secret', 'authorization'];

      fc.assert(
        fc.property(fc.constantFrom(...sensitiveKeys), fc.string(), (key, value) => {
          const obj = { [key]: value, safe: 'visible' };
          const result = sanitization.sanitizeForLogging(obj) as Record<string, unknown>;

          expect(result[key]).toBe('[REDACTED]');
          expect(result.safe).toBe('visible');
        }),
        { numRuns: 50 },
      );
    });

    it('should return primitive values unchanged', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            fc.constant(undefined),
          ),
          (value) => {
            expect(sanitization.sanitizeForLogging(value)).toBe(value);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('serializeForLogging', () => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;

    it('caps at the byte limit on a character boundary, as a prefix of the whole payload', () => {
      fc.assert(
        fc.property(
          // `binary` strings include lone surrogates and every plane.
          fc.jsonValue({ maxDepth: 4, stringUnit: 'binary' }),
          fc.integer({ min: 1, max: 256 }),
          (value, cap) => {
            const whole = sanitization.serializeForLogging(value, Number.MAX_SAFE_INTEGER).text;
            const { text, truncated } = sanitization.serializeForLogging(value, cap);

            expect(truncated).toBe(bytes(whole) > cap);
            expect(bytes(text)).toBeLessThanOrEqual(cap);
            expect(text.isWellFormed()).toBe(true);
            expect(whole.startsWith(text)).toBe(true);
            // Whole characters only: the next one would have crossed the cap.
            if (truncated) {
              const next = String.fromCodePoint(whole.codePointAt(text.length) ?? 0);
              expect(bytes(text) + bytes(next)).toBeGreaterThan(cap);
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
