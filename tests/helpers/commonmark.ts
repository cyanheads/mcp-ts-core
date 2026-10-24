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
 * live syntax.
 */
export function readCommonMark(markdown: string, preset: CommonMarkPreset = 'gfm'): string {
  const parts: string[] = [];
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
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
