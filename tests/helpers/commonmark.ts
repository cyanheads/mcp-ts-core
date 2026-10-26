/**
 * @fileoverview Reads Markdown back through a real CommonMark parser
 * (`markdown-it`), so a test can assert what a `content[]` client renders
 * rather than which bytes were written.
 * @module tests/helpers/commonmark
 */
import MarkdownIt, { type MarkdownIt as Parser, type Token } from 'markdown-it';

/** Parser presets the round-trip assertions run under. */
export type CommonMarkPreset = 'commonmark' | 'gfm';

function createParser(preset: CommonMarkPreset): Parser {
  // `default` adds the GFM table and strikethrough rules to CommonMark; raw HTML is on in both.
  const parser =
    preset === 'commonmark'
      ? new MarkdownIt('commonmark')
      : new MarkdownIt('default', { html: true });
  // Read destinations as written: percent-encoding and the scheme allowlist are rendering policy, not the parse.
  parser.normalizeLink = (url) => url;
  parser.validateLink = () => true;
  return parser;
}

const parsers: Record<CommonMarkPreset, Parser> = {
  commonmark: createParser('commonmark'),
  gfm: createParser('gfm'),
};

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The text a CommonMark parse of `markdown` reads as: each paragraph's text
 * (line breaks as `\n`), joined by a blank line, with every node that is not
 * plain text named in place — `⟨strong⟩…⟨/strong⟩`, `⟨code_inline:x⟩`,
 * `⟨bullet_list_open⟩` — so an expectation written as plain text fails on any
 * live syntax. A fenced or indented code block reads as `⟨fence:…⟩` or
 * `⟨code_block:…⟩` holding its content without the line break that ends its
 * last line, so `⟨fence:a\nb⟩` is a block whose lines are `a` and `b`.
 */
export function readCommonMark(markdown: string, preset: CommonMarkPreset = 'gfm'): string {
  const parts: string[] = [];
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type === 'fence' || token.type === 'code_block') {
      parts.push(`⟨${token.type}:${token.content.replace(/\n$/, '')}⟩`);
    } else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
}

/**
 * The block structure of `markdown` and the text of each inline run in it, in
 * document order — a heading's text, a list item's, each table cell's — read
 * as {@link readCommonMark} reads inline text. Asserts what one Markdown slot
 * holds: `## ${value}` must yield a `heading_open` and exactly one inline run
 * equal to the value.
 */
export function readCommonMarkInlines(
  markdown: string,
  preset: CommonMarkPreset = 'gfm',
): { blocks: string[]; inlines: string[] } {
  const blocks: string[] = [];
  const inlines: string[] = [];
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type === 'inline') inlines.push(readInline(token.children ?? []));
    else blocks.push(token.type);
  }
  return { blocks, inlines };
}

/**
 * The content of every code literal `markdown` parses to, in document order:
 * each inline code span, and each fenced or indented code block without the
 * line break that ends its last line.
 */
export function readCommonMarkCodeLiterals(
  markdown: string,
  preset: CommonMarkPreset = 'gfm',
): string[] {
  const literals: string[] = [];
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type === 'fence' || token.type === 'code_block') {
      literals.push(token.content.replace(/\n$/, ''));
    } else if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (child.type === 'code_inline') literals.push(child.content);
      }
    }
  }
  return literals;
}

/** A link or image `markdown` parses to when it is the whole paragraph, else `undefined`. */
export function readCommonMarkTarget(
  markdown: string,
  preset: CommonMarkPreset = 'gfm',
):
  | {
      kind: 'image' | 'link';
      text: string;
      title: ReturnType<Token['attrGet']>;
      url: ReturnType<Token['attrGet']>;
    }
  | undefined {
  const tokens = parsers[preset].parse(markdown, {});
  const children = tokens.length === 3 ? (tokens[1]?.children ?? []) : [];
  const [first] = children;
  if (first?.type === 'image' && children.length === 1) {
    return {
      kind: 'image',
      text: readInline(first.children ?? []),
      title: first.attrGet('title'),
      url: first.attrGet('src'),
    };
  }
  if (first?.type === 'link_open' && children.at(-1)?.type === 'link_close') {
    return {
      kind: 'link',
      text: readInline(children.slice(1, -1)),
      title: first.attrGet('title'),
      url: first.attrGet('href'),
    };
  }
  return;
}
