/**
 * @fileoverview Tests for handler source text scrubbing helpers.
 * @module tests/unit/linter/source-text.test
 */

import { describe, expect, it } from 'vitest';

import { stripCommentsAndStrings } from '@/linter/rules/source-text.js';

describe('stripCommentsAndStrings', () => {
  it('replaces line comments while preserving the newline structure', () => {
    const source = ['const a = 1;', '// throw new Error("comment only")', 'const b = 2;'].join(
      '\n',
    );

    const stripped = stripCommentsAndStrings(source);

    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).toContain('//                                ');
    expect(stripped).not.toContain('throw new Error');
    expect(stripped).toContain('const b = 2;');
  });

  it('replaces block comments without shifting following code', () => {
    const source = 'const a = 1; /* throw new Error("x") */ const b = 2;';

    const stripped = stripCommentsAndStrings(source);

    expect(stripped).not.toContain('throw new Error');
    expect(stripped).toContain('const a = 1; /*                      */ const b = 2;');
  });

  it('replaces quoted strings and escaped characters with whitespace', () => {
    const source = String.raw`const msg = "do not match \"throw new Error\" here";`;

    const stripped = stripCommentsAndStrings(source);

    expect(stripped).not.toContain('throw new Error');
    expect(stripped).toMatch(/^const msg = "\s+";$/);
  });

  it('preserves template interpolation bodies so throw expressions remain visible', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this test targets template source text.
    const source = 'const msg = `safe ${throw new Error("visible")} tail`;';

    const stripped = stripCommentsAndStrings(source);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: expected literal source substring.
    expect(stripped).toContain('${throw new Error("visible")}');
    expect(stripped).not.toContain('tail');
  });

  it('handles unterminated block comments and strings without throwing', () => {
    expect(() => stripCommentsAndStrings('const a = 1; /* unterminated')).not.toThrow();
    expect(() => stripCommentsAndStrings('const a = "unterminated')).not.toThrow();

    expect(stripCommentsAndStrings('const a = 1; /* unterminated')).toBe(
      'const a = 1; /*             ',
    );
    expect(stripCommentsAndStrings('const a = "unterminated')).toBe('const a = "            ');
  });
});
