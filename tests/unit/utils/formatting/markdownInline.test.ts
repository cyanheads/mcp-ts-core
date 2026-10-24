/**
 * @fileoverview Tests for the inline Markdown encoders: every encoded value is
 * read back through a real CommonMark parser and must equal the input, with no
 * live node.
 * @module tests/utils/formatting/markdownInline.test
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  escapeMarkdownInline,
  markdownImage,
  markdownLink,
} from '@/utils/formatting/markdownInline.js';
import {
  type CommonMarkPreset,
  readCommonMark,
  readCommonMarkTarget,
} from '../../../helpers/commonmark.js';

const PRESETS: CommonMarkPreset[] = ['commonmark', 'gfm'];

/** What a parse must yield: the input with CR and CRLF read as LF. */
const asParsed = (text: string) => text.replace(/\r\n?/g, '\n');

/**
 * Text drawn from printable ASCII, whitespace of every kind, non-BMP and
 * combining characters, and whole Markdown constructs — the runs that
 * `fc.string()` alone almost never assembles (`<a>`, `1. `, `:-`, `&copy;`).
 */
const markdownishText = fc
  .array(
    fc.oneof(
      {
        weight: 6,
        arbitrary: fc.constantFrom(
          ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
        ),
      },
      {
        weight: 2,
        arbitrary: fc.constantFrom(
          '\t',
          '\n',
          '\r',
          '\r\n',
          '\u00a0',
          '\u3000',
          'é',
          '😀',
          '\u0301',
        ),
      },
      {
        weight: 1,
        arbitrary: fc.constantFrom(
          '&amp;',
          '&#32;',
          '&#x41;',
          '&copy;',
          '<a>',
          '</a>',
          '<!--',
          '<?',
          '<1@a.io>',
          '<http://a.b>',
          '```',
          '~~~',
          '1. ',
          '- ',
          '# ',
          '> ',
          '***',
          '___',
          '---',
          '===',
          '[a]: b',
          '|-|',
          ':-',
          '\\\n',
          '  \n',
          '![a](b)',
          '[a](b)',
        ),
      },
    ),
    { maxLength: 40 },
  )
  .map((parts) => parts.join(''));

describe('escapeMarkdownInline', () => {
  it('matches the documented example', () => {
    expect(escapeMarkdownInline('A*p* <b>x</b>\n- y')).toBe('A\\*p\\* \\<b>x\\</b>\\\n\\- y');
  });

  const corpus = [
    'a\n- b',
    'a\n===',
    'a\n1. b',
    '  padded  ',
    'a\n',
    'x._y_.z',
    '<!-- c -->',
    '&copy;',
    '&#123; &#x1F;',
    'a\n\nb',
    '\n',
    '\na',
    'a\\',
    'a\\\nb',
    'x\\ ',
    '<1@a.io>',
    '<http://a.b>',
    '\t\tindented',
    '    code?',
    'a  \nb',
    '# heading',
    '>=1',
    '---',
    '-- -',
    '+',
    '1)',
    'b|\n:-',
    '| a |\n| - |',
    '~~gone~~',
    '`code`',
    '[x](https://evil.example)',
    '![x](y)',
    '😀_😀',
    'A*p*',
    'My "App" \\ 2',
  ];

  it.each(PRESETS)('reads back every corpus entry exactly under %s', (preset) => {
    for (const text of corpus) {
      expect(readCommonMark(escapeMarkdownInline(text), preset), JSON.stringify(text)).toBe(text);
    }
  });

  it('reads CR and CRLF line breaks back as LF', () => {
    expect(readCommonMark(escapeMarkdownInline('a\r\nb\rc'))).toBe('a\nb\nc');
  });

  it('leaves text with no syntax-forming run unchanged', () => {
    for (const text of [
      '<=50',
      'x >=1',
      'AT&T',
      'C# 12',
      '3.14',
      '-5',
      'snake_case',
      'C:\\Users\\x',
      'No running app matches "Safari".',
      'limit: Too big: expected number to be <=50',
    ]) {
      expect(escapeMarkdownInline(text)).toBe(text);
    }
  });

  it('escapes a line-leading quote marker, since a standalone parse reads one', () => {
    expect(escapeMarkdownInline('>=1')).toBe('\\>=1');
  });

  it('encodes edge whitespace and line breaks as references and hard breaks', () => {
    expect(escapeMarkdownInline('  padded\t')).toBe('&#32;&#32;padded&#9;');
    expect(escapeMarkdownInline('a\nb')).toBe('a\\\nb');
    expect(escapeMarkdownInline('a\n')).toBe('a&#10;');
  });

  it('is the identity on the empty string', () => {
    expect(escapeMarkdownInline('')).toBe('');
  });

  it.each(PRESETS)('reads back arbitrary text exactly under %s', (preset) => {
    fc.assert(
      fc.property(markdownishText, (text) => {
        expect(readCommonMark(escapeMarkdownInline(text), preset)).toBe(asParsed(text));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('markdownLink / markdownImage', () => {
  it('match the documented examples', () => {
    expect(markdownImage('Team logo', 'https://cdn.example/a b.png')).toBe(
      '![Team logo](<https://cdn.example/a b.png>)',
    );
    expect(markdownLink('[docs]', 'https://example.com/q?x=<1>')).toBe(
      '[\\[docs\\]](<https://example.com/q?x=\\<1\\>>)',
    );
  });

  it.each(PRESETS)(
    'read back destinations with a space, parens, angle brackets, a backslash, or an entity under %s',
    (preset) => {
      for (const url of [
        'https://cdn.example/a b.png',
        'https://en.wikipedia.org/wiki/Foo_(bar)',
        'https://example.com/q?x=<1>',
        'https://example.com/a\\b',
        'https://example.com/?q=&amp;&copy;',
        'http://example.com/)(',
      ]) {
        expect(readCommonMarkTarget(markdownLink('a [label]', url), preset)).toEqual({
          kind: 'link',
          text: 'a [label]',
          title: null,
          url,
        });
        expect(
          readCommonMarkTarget(markdownImage('*alt*', url, 'say "hi" \\ &copy;'), preset),
        ).toEqual({ kind: 'image', text: '*alt*', title: 'say "hi" \\ &copy;', url });
      }
    },
  );

  it('renders a non-http(s) or unparseable URL as literal text, keeping the label', () => {
    for (const [url, expected] of [
      ['javascript:alert(1)', 'run (javascript:alert(1))'],
      ['data:text/html,<b>x</b>', 'run (data:text/html,<b>x</b>)'],
      ['/assets/diagram.png', 'run (/assets/diagram.png)'],
      ['not a url', 'run (not a url)'],
      ['https://example.com/\nnext', 'run (https://example.com/\nnext)'],
    ] as const) {
      const link = markdownLink('run', url);
      expect(readCommonMarkTarget(link)).toBeUndefined();
      expect(readCommonMark(link)).toBe(expected);
      expect(readCommonMark(markdownImage('run', url))).toBe(expected);
    }
    expect(readCommonMark(markdownImage('logo', '/a.png', 'Logo'))).toBe('logo (/a.png "Logo")');
    expect(readCommonMark(markdownLink('', 'javascript:void(0)'))).toBe('javascript:void(0)');
  });

  it('reads back arbitrary labels, titles, and http(s) URLs exactly', () => {
    const url = fc
      .tuple(fc.constantFrom('http://', 'https://', 'HTTPS://'), markdownishText)
      .map(([scheme, rest]) => `${scheme}x.io/${rest.replace(/[\r\n]/g, '')}`);
    fc.assert(
      fc.property(
        markdownishText,
        url,
        fc.option(markdownishText, { nil: undefined }),
        (label, href, title) => {
          for (const preset of PRESETS) {
            expect(readCommonMarkTarget(markdownLink(label, href), preset)).toEqual({
              kind: 'link',
              text: asParsed(label),
              title: null,
              url: href,
            });
            expect(readCommonMarkTarget(markdownImage(label, href, title), preset)).toEqual({
              kind: 'image',
              text: asParsed(label),
              title: title ? asParsed(title) : null,
              url: href,
            });
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
