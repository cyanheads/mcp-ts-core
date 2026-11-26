/**
 * @fileoverview Tests for the inline Markdown encoders: every encoded value is
 * read back through a real CommonMark parser and must equal the input, with no
 * live node.
 * @module tests/utils/formatting/markdownInline.test
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  escapeMarkdownInline,
  escapeMarkdownInlineWithLiterals,
  markdownImage,
  markdownLink,
} from '@/utils/formatting/markdownInline.js';
import {
  type CommonMarkPreset,
  readCommonMark,
  readCommonMarkInlines,
  readCommonMarkTarget,
} from '../../../helpers/commonmark.js';
import { expectLinearCost } from '../../../helpers/cpu-time.js';

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

/**
 * {@link markdownishText} with the runs an ATX heading or a table cell reads
 * as syntax spliced in: a `#` run after a space or tab or too long to open a
 * heading, and Unicode whitespace that markdown-it's cell `trim()` strips.
 */
const slotText = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: markdownishText },
      {
        weight: 1,
        arbitrary: fc.constantFrom(' #', ' ##', '\t#', '#', '# ', '#######', '﻿', ' ', ' '),
      },
    ),
    { maxLength: 4 },
  )
  .map((parts) => parts.join(''));

/** {@link slotText} with its line breaks removed: a value a heading or table cell can hold. */
const slotLine = slotText.map((text) => text.replace(/[\r\n]/g, ''));

/**
 * Markdown slots a `format()` interpolates an encoded value into, each with the
 * container its parse must open and the inline runs it must hold for `value`:
 * the slot's own authored text around the value, and for a table the header
 * cell before it. Any other run — a value split across two blocks — fails.
 */
const SLOTS = {
  paragraph: { wrap: (e: string) => e, block: 'paragraph_open', runs: (v: string) => [v] },
  heading: { wrap: (e: string) => `## ${e}`, block: 'heading_open', runs: (v: string) => [v] },
  'heading after a label': {
    wrap: (e: string) => `## Label ${e}`,
    block: 'heading_open',
    runs: (v: string) => [`Label ${v}`],
  },
  'list item': {
    wrap: (e: string) => `- ${e}`,
    block: 'bullet_list_open',
    runs: (v: string) => [v],
  },
  'ordered item': {
    wrap: (e: string) => `1. ${e}`,
    block: 'ordered_list_open',
    runs: (v: string) => [v],
  },
  'block quote': {
    wrap: (e: string) => `> ${e}`,
    block: 'blockquote_open',
    runs: (v: string) => [v],
  },
  'after a label': {
    wrap: (e: string) => `**Label:** ${e}`,
    block: 'paragraph_open',
    runs: (v: string) => [`⟨strong⟩Label:⟨/strong⟩ ${v}`],
  },
  'table cell': {
    wrap: (e: string) => `| h |\n| - |\n| ${e} |`,
    block: 'td_open',
    runs: (v: string) => ['h', v],
  },
} as const;

type Slot = keyof typeof SLOTS;

/** Asserts `text`, encoded into `slot`, reads back as exactly `text` under `preset`. */
function expectSlotReadBack(slot: Slot, text: string, preset: CommonMarkPreset): void {
  const { wrap, block, runs } = SLOTS[slot];
  const { blocks, inlines } = readCommonMarkInlines(wrap(escapeMarkdownInline(text)), preset);
  expect(blocks, JSON.stringify(text)).toContain(block);
  expect(inlines, JSON.stringify(text)).toEqual(runs(asParsed(text)));
}

/** Slots holding a value of one line, and the presets each is read under; a table is GFM only. */
const SINGLE_LINE_SLOTS: ReadonlyArray<readonly [Slot, CommonMarkPreset]> = [
  ...(
    [
      'paragraph',
      'heading',
      'heading after a label',
      'list item',
      'ordered item',
      'block quote',
      'after a label',
    ] as const
  ).flatMap((slot) => PRESETS.map((preset) => [slot, preset] as const)),
  ['table cell', 'gfm'],
];

/** Slots holding a value with line breaks: a heading or table row ends at the break. */
const MULTI_LINE_SLOTS: ReadonlyArray<readonly [Slot, CommonMarkPreset]> = (
  ['paragraph', 'list item', 'ordered item', 'block quote'] as const
).flatMap((slot) => PRESETS.map((preset) => [slot, preset] as const));

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
      'C#',
      'C# 12',
      'a # b',
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

  it('escapes the last # of a run a space or tab precedes at the end of a line', () => {
    expect(escapeMarkdownInline('abc #')).toBe('abc \\#');
    expect(escapeMarkdownInline('abc ##')).toBe('abc #\\#');
    expect(escapeMarkdownInline('a\t#')).toBe('a\t\\#');
    expect(escapeMarkdownInline('# #')).toBe('\\# \\#');
    expect(escapeMarkdownInline('a #\nb #')).toBe('a \\#\\\nb \\#');
    // Trailing whitespace is a reference, which already ends the run.
    expect(escapeMarkdownInline('abc # ')).toBe('abc #&#32;');
  });

  it.each(PRESETS)(
    'reads a value ending in a space- or tab-preceded # run back in a heading under %s',
    (preset) => {
      for (const text of ['abc #', 'abc ##', 'a\t#', '# #', 'C#', 'C# 12', 'a # b', 'Issue #']) {
        expectSlotReadBack('heading', text, preset);
      }
    },
  );

  it('escapes the first # of a line made only of #, which a heading reads as its closing sequence', () => {
    expect(escapeMarkdownInline('######')).toBe('\\######');
    expect(escapeMarkdownInline('#######')).toBe('\\#######');
    expect(escapeMarkdownInline('#######\t')).toBe('\\#######&#9;');
    expect(escapeMarkdownInline('a\n########')).toBe('a\\\n\\########');
    // Text after the run, or edge whitespace before it, already keeps it out of a closing sequence.
    for (const [text, expected] of [
      ['####### foo', '####### foo'],
      ['####### #', '####### \\#'],
      [' #######', '&#32;#######'],
      ['a #######', 'a ######\\#'],
    ] as const) {
      expect(escapeMarkdownInline(text), JSON.stringify(text)).toBe(expected);
    }
  });

  it.each(PRESETS)(
    'reads a value made only of # back in a heading, bare and after a label, under %s',
    (preset) => {
      for (const length of [1, 6, 7, 8, 12, 40]) {
        expectSlotReadBack('heading', '#'.repeat(length), preset);
        expectSlotReadBack('heading after a label', '#'.repeat(length), preset);
      }
    },
  );

  it('encodes edge Unicode whitespace as numeric references', () => {
    expect(escapeMarkdownInline(' a　')).toBe('&#160;a&#12288;');
    expect(escapeMarkdownInline('　')).toBe('&#12288;');
  });

  it('leaves an edge vertical tab literal, which markdown-it reads back from &#11; as U+FFFD', () => {
    expect(escapeMarkdownInline('\va\v')).toBe('\va\v');
    for (const preset of PRESETS) {
      expectSlotReadBack('after a label', '\va', preset);
      expectSlotReadBack('paragraph', 'a\v\n\vb', preset);
    }
  });

  it('encodes whitespace only at the edges of each line, a vertical tab ending the edge', () => {
    for (const [text, expected] of [
      ['a \t b', 'a \t b'],
      [' a  b ', '&#32;a  b&#160;'],
      ['a  \v', 'a  \v'],
      ['a \v ', 'a \v&#32;'],
      ['　a\tb\t', '&#12288;a\tb&#9;'],
      ['a  b\n  c \t', 'a  b\\\n&#32;&#8195;c&#32;&#9;'],
      ['\v \va b\v \v', '\v \va b\v \v'],
      ['x  #', 'x  \\#'],
      ['x # \t', 'x #&#32;&#9;'],
    ] as const) {
      expect(escapeMarkdownInline(text), JSON.stringify(text)).toBe(expected);
    }
  });

  it('encodes every whitespace character but a line break and U+000B as a reference at either edge, and none mid-line', () => {
    const whitespace = Array.from({ length: 0x10000 }, (_, unit) =>
      String.fromCharCode(unit),
    ).filter((ch) => /\s/.test(ch) && !/[\n\r\v]/.test(ch));
    expect(whitespace).toHaveLength(22);
    for (const ch of whitespace) {
      const unit = ch.charCodeAt(0);
      const reference = `&#${unit};`;
      const label = `U+${unit.toString(16).padStart(4, '0')}`;
      expect(escapeMarkdownInline(`a${ch}`), label).toBe(`a${reference}`);
      expect(escapeMarkdownInline(`${ch}a`), label).toBe(`${reference}a`);
      expect(escapeMarkdownInline(`a${ch}${ch}*`), label).toBe(`a${ch}${ch}\\*`);
      expect(escapeMarkdownInline(`*${ch}${ch}`), label).toBe(`\\*${reference}${reference}`);
      expect(escapeMarkdownInline(`${ch}\v${ch}`), label).toBe(`${reference}\v${reference}`);
    }
  });

  /**
   * The timing tests run with no timeout: vitest compares a synchronous body's
   * wall time only after it returns, so a timeout would guard no hang and fail
   * linear work on a loaded machine. Each size's thread-CPU bound stops a cost
   * beyond linear.
   */
  it('encodes in time linear in the length of its input', () => {
    /**
     * One input of about `length` characters per shape the encoder treats
     * differently: a run of a single character between two letters, for every
     * character class it escapes, references, or passes through; a run of edge
     * whitespace after and before text; one long line ending in a break; breaks
     * throughout; and Markdown-active prose.
     */
    const EDGE = [' ', '\t', ' ', '　'];
    const inputs = (length: number): string[] => [
      ...['a', '1', '_', '*', '`', '\\', '<', '&', '#', '-', '[', ' ', '\t', ' ', '　', '\v'].map(
        (unit) => `x${unit.repeat(length)}y`,
      ),
      ...EDGE.flatMap((unit) => [`x${unit.repeat(length)}`, `${unit.repeat(length)}x`]),
      `x${'😀'.repeat(length / 2)}y`,
      `${'§1 x'.repeat(length / 4)}\ny`,
      '  \r\n'.repeat(length / 4),
      '<1@'.repeat(length / 3),
      '&#1'.repeat(length / 3),
      'A*p* <b>x</b> [a](b) &copy; _c_ # '.repeat(length / 34),
    ];
    expectLinearCost((length) => {
      // The edge-whitespace runs at this size, each a reference.
      for (const unit of EDGE) {
        const run = unit.repeat(length);
        const references = `&#${unit.codePointAt(0)};`.repeat(length);
        expect(escapeMarkdownInline(`x${run}`)).toBe(`x${references}`);
        expect(escapeMarkdownInline(`${run}x`)).toBe(`${references}x`);
      }
      const batch = inputs(length);
      return () => {
        for (const input of batch) escapeMarkdownInline(input);
      };
    });
  }, 0);

  it('encodes literals in time linear in the length of its input', () => {
    /**
     * Lines that spans split into many runs: the only unit to decide past
     * every span, a decided unit inside every span, and a `<` tested against
     * the spans rendered after it.
     */
    expectLinearCost((length) => {
      const farCandidate = `${'x '.repeat(length / 2)}*`;
      expect(escapeMarkdownInlineWithLiterals(farCandidate, ['x'])).toBe(
        `${'`x` '.repeat(length / 2)}\\*`,
      );
      const inputs: Array<[string, string[]]> = [
        [farCandidate, ['x']],
        ['* '.repeat(length / 2), ['*']],
        ['<x '.repeat(length / 3), ['x']],
      ];
      return () => {
        for (const [input, literals] of inputs) escapeMarkdownInlineWithLiterals(input, literals);
      };
    });
  }, 0);

  it('reads a table cell edged with a space and an ideographic space back under gfm', () => {
    expectSlotReadBack('table cell', ' a　', 'gfm');
  });

  it.each(SINGLE_LINE_SLOTS)(
    'reads arbitrary single-line text back exactly in a %s under %s',
    (slot, preset) => {
      fc.assert(
        fc.property(slotLine, (text) => {
          fc.pre(text !== '');
          expectSlotReadBack(slot, text, preset);
        }),
        { numRuns: 500 },
      );
    },
  );

  it.each(MULTI_LINE_SLOTS)(
    'reads arbitrary multi-line text back exactly in a %s under %s',
    (slot, preset) => {
      fc.assert(
        fc.property(slotText, (text) => {
          fc.pre(text !== '');
          expectSlotReadBack(slot, text, preset);
        }),
        { numRuns: 500 },
      );
    },
  );

  it.each(PRESETS)('reads back arbitrary text exactly under %s', (preset) => {
    fc.assert(
      fc.property(markdownishText, (text) => {
        expect(readCommonMark(escapeMarkdownInline(text), preset)).toBe(asParsed(text));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('encoder working memory', () => {
  const execFileAsync = promisify(execFile);
  const SRC = new URL('../../../../src/', import.meta.url).href;
  const LENGTH = 14_000_000;

  /**
   * The rise in a fresh process's peak resident set across one encoder call on
   * `unit` repeated to {@link LENGTH} characters, the output read through so a
   * rope is flattened, per input character; and the output's length. The
   * child runs on the runtime running the tests: Bun imports `src/` as it is,
   * and under Node a resolve hook maps `@/` onto `src/`, whose types Node
   * strips.
   */
  async function peakRisePerCharacter(
    encoder: 'escapeMarkdownInline' | 'escapeMarkdownInlineWithLiterals',
    unit: string,
  ): Promise<{ bytesPerCharacter: number; outputLength: number }> {
    const call =
      encoder === 'escapeMarkdownInline'
        ? 'encoders.escapeMarkdownInline(input)'
        : "encoders.escapeMarkdownInlineWithLiterals(input, ['zzz-no-match'])";
    const script = `
      const src = ${JSON.stringify(SRC)};
      if (!process.versions.bun) {
        const { registerHooks } = await import('node:module');
        registerHooks({
          resolve: (specifier, context, next) =>
            next(specifier.startsWith('@/') ? new URL(specifier.slice(2).replace(/\\.js$/, '.ts'), src).href : specifier, context),
        });
      }
      const encoders = await import(new URL('utils/formatting/markdownInline.ts', src).href);
      const unit = ${JSON.stringify(unit)};
      const input = unit.repeat(Math.ceil(${LENGTH} / unit.length)).slice(0, ${LENGTH});
      const before = process.resourceUsage().maxRSS;
      const output = ${call};
      for (let i = 0; i < output.length; i += 4096) output.charCodeAt(i);
      const after = process.resourceUsage().maxRSS;
      console.log(JSON.stringify({ bytesPerCharacter: ((after - before) * 1024) / ${LENGTH}, outputLength: output.length }));
    `;
    const args = process.versions.bun ? ['-e', script] : ['--input-type=module', '-e', script];
    const { stdout } = await execFileAsync(process.execPath, args, { timeout: 50_000 });
    return JSON.parse(stdout);
  }

  const JSON_UNIT = '{"lat":47.1234567,"lon":-122.1234567},';

  it.each([
    ['escapeMarkdownInline', 'one line, nothing escaped', JSON_UNIT, LENGTH],
    ['escapeMarkdownInline', 'one line, every character escaped', '*', 2 * LENGTH],
    // Each `*` line becomes `\*`, each break a hard break, and the final break `&#10;`.
    ['escapeMarkdownInline', 'one-character lines, each escaped', '*\n', 2 * LENGTH + 3],
    ['escapeMarkdownInline', 'one line of whitespace, each a reference', ' ', 5 * LENGTH],
    ['escapeMarkdownInlineWithLiterals', 'one line, nothing escaped', JSON_UNIT, LENGTH],
    ['escapeMarkdownInlineWithLiterals', 'one line, every character escaped', '*', 2 * LENGTH],
  ] as const)(
    '%s holds under 16 bytes per input character on 14M characters: %s',
    async (encoder, _shape, unit, expectedLength) => {
      const { bytesPerCharacter, outputLength } = await peakRisePerCharacter(encoder, unit);

      expect(outputLength).toBe(expectedLength);
      expect(bytesPerCharacter).toBeLessThan(16);
    },
    60_000,
  );
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
