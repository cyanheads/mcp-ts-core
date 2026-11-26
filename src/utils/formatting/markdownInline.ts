/**
 * @fileoverview Encoders that place text the caller did not author into
 * Markdown so a CommonMark parse reads it back unchanged:
 * {@link escapeMarkdownInline} for running text, {@link markdownLink} and
 * {@link markdownImage} for link and image syntax. `content[]` carries the same
 * data as `structuredContent`, so an upstream string must render as itself,
 * never as emphasis, a link, raw HTML, or a list it happens to resemble.
 * @module src/utils/formatting/markdownInline
 */

import { codeSpan } from '@/utils/formatting/codeSpan.js';

/** What follows the `&` of a reference CommonMark decodes: decimal, hexadecimal, or named. */
const REFERENCE_BODY = '#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|[A-Za-z][A-Za-z0-9]{1,31};';
/** An `&` that starts a run CommonMark decodes as an entity or numeric reference. */
const ENTITY_AMPERSAND = new RegExp(`&(?=${REFERENCE_BODY})`, 'g');
/** A whole entity or numeric reference at `lastIndex`, so where it ends can be checked. */
const REFERENCE_AT = new RegExp(`&(?:${REFERENCE_BODY})`, 'y');
/**
 * A code unit {@link escapeText} decides on: `` ` `` `*` `[` `]` `|` `~`,
 * always escaped, and `\` `_` `<` `&`, escaped by what surrounds them. Every
 * other code unit passes through as written.
 */
const DECIDED = /[`*[\]|~\\_<&]/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
/** Edge whitespace, which becomes a reference: every `\s` character but U+000B. */
const EDGE_SPACE = /^[^\S\v]$/u;
/**
 * A `<` that opens raw HTML or a URI autolink, or an email autolink, whose
 * local part may start with a digit or symbol (`<1@a.io>`). Sticky, matched at
 * the `<` in place.
 */
const MARKUP_OPENER = /<(?:[A-Za-z/!?]|[^\s<>@]*@[^\s<>]*>)/y;
/**
 * One code point that is a letter, digit, or `_`: what may not touch a
 * literal. Anchored at both ends: V8 misses a character outside the BMP that a
 * class matches just before a `$` with no `^` (`/[\p{L}]$/u` fails on `'𝐀'`).
 */
const TOUCHING = /^[\p{L}\p{N}_]$/u;

/** The code point starting at `index` of `text`, which is inside it, as a string; a lone surrogate is one. */
function pointAt(text: string, index: number): string {
  return String.fromCodePoint(text.codePointAt(index) as number);
}

/** The code point ending just before `index` of `text`, which is past its start, as a string; a lone surrogate is one. */
function pointBefore(text: string, index: number): string {
  const pair =
    index >= 2 &&
    (text.charCodeAt(index - 1) & 0xfc00) === 0xdc00 &&
    (text.charCodeAt(index - 2) & 0xfc00) === 0xd800;
  return text.slice(index - (pair ? 2 : 1), index);
}

/** Whether the code point starting at `index` of `text` is a letter, digit, or `_`. */
function touchesAt(text: string, index: number): boolean {
  return index < text.length && TOUCHING.test(pointAt(text, index));
}

/** Whether the code point ending just before `index` of `text` is a letter, digit, or `_`. */
function touchesBefore(text: string, index: number): boolean {
  return index > 0 && TOUCHING.test(pointBefore(text, index));
}

/** Pieces an {@link Output} holds before it joins them into one flat chunk. */
const CHUNK_PIECES = 4096;

/**
 * A string built from many short pieces in memory proportional to its length:
 * the pieces are joined into flat chunks as they arrive, so the result never
 * holds an array slot or a rope node per piece.
 */
class Output {
  readonly #chunks: string[] = [];
  readonly #pieces: string[] = [];

  add(piece: string): void {
    if (this.#pieces.push(piece) === CHUNK_PIECES) this.#flush();
  }

  /** Everything added, as one string. */
  join(): string {
    this.#flush();
    return this.#chunks.join('');
  }

  #flush(): void {
    this.#chunks.push(this.#pieces.join(''));
    this.#pieces.length = 0;
  }
}

/**
 * A node of the trie of reversed literals {@link literalSpans} matches with.
 * Read forward, its text is the last `depth` code units of `source`, so it
 * ends some literal.
 */
interface LiteralNode {
  readonly depth: number;
  /** Aho–Corasick failure link: the node for the longest proper prefix of this node's text. */
  fail: LiteralNode | undefined;
  /** Whether this node's text is a whole literal. */
  literal: boolean;
  /** Children past the first, by code unit; most nodes have one child or none. */
  more: Map<number, LiteralNode> | undefined;
  /** The first child, along code unit {@link LiteralNode.unit}. */
  next: LiteralNode | undefined;
  /** A literal this node's text ends. */
  readonly source: string;
  unit: number;
  /**
   * The longest literal that is a proper prefix of this node's text and that
   * the next code point of that text does not touch.
   */
  untouched: LiteralNode | undefined;
}

/** A literal's occurrence in a line: code-unit `[start, end)` offsets. */
type Span = readonly [start: number, end: number];

/** The child of `node` along code unit `unit`. */
function childOf(node: LiteralNode, unit: number): LiteralNode | undefined {
  return node.unit === unit ? node.next : node.more?.get(unit);
}

/**
 * The root of the trie of the usable `literals`, each inserted last character
 * first, with its failure links; `undefined` when none is usable. An empty
 * literal, one holding a line break, and one holding a lone surrogate never
 * match. Built in time linear in the literals' combined length.
 */
function literalTrie(literals: readonly string[]): LiteralNode | undefined {
  const node = (depth: number, source: string): LiteralNode => ({
    depth,
    fail: undefined,
    literal: false,
    more: undefined,
    next: undefined,
    source,
    unit: -1,
    untouched: undefined,
  });
  const root = node(0, '');
  for (const literal of literals) {
    if (literal === '' || /[\r\n]/.test(literal) || !literal.isWellFormed()) continue;
    let current = root;
    for (let i = literal.length - 1; i >= 0; i--) {
      const unit = literal.charCodeAt(i);
      let child = childOf(current, unit);
      if (child === undefined) {
        child = node(current.depth + 1, literal);
        if (current.next === undefined) {
          current.unit = unit;
          current.next = child;
        } else {
          current.more ??= new Map();
          current.more.set(unit, child);
        }
      }
      current = child;
    }
    current.literal = true;
  }
  if (root.next === undefined) return;
  // Breadth first: a failure link, and everything read through it, is
  // shallower than the node it belongs to, so it is finished first.
  const queue = [root];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as LiteralNode;
    const fail = current.fail;
    if (fail !== undefined) {
      // The literals that are proper prefixes of this node's text are the
      // failure link's and the link itself; the code point after one of the
      // link's own lies inside the link's text, so its answer carries over.
      const after = current.source.length - current.depth + fail.depth;
      current.untouched = fail.literal && !touchesAt(current.source, after) ? fail : fail.untouched;
    }
    const link = (child: LiteralNode, unit: number) => {
      let candidate = current.fail;
      while (candidate !== undefined && childOf(candidate, unit) === undefined) {
        candidate = candidate.fail;
      }
      child.fail = candidate === undefined ? root : childOf(candidate, unit);
      queue.push(child);
    };
    if (current.next !== undefined) link(current.next, current.unit);
    for (const [unit, child] of current.more ?? []) link(child, unit);
  }
  return root;
}

/**
 * The occurrences of `root`'s literals in `text` that render as code, in
 * order: the leftmost first, at a start the longest; none that a letter,
 * digit, or `_` touches on either side; and none starting where the previous
 * one ended, since two code spans edge to edge read as one.
 *
 * Linear in `text`: one pass from the end walks the trie, so each start sees
 * the longest literal it opens, and the node's `untouched` link is the longest
 * shorter one whose next code point lies inside that literal's text and does
 * not touch it.
 */
function literalSpans(text: string, root: LiteralNode): Span[] {
  const longest = new Int32Array(text.length);
  let current = root;
  for (let start = text.length - 1; start >= 0; start--) {
    const unit = text.charCodeAt(start);
    let child = childOf(current, unit);
    while (child === undefined && current.fail !== undefined) {
      current = current.fail;
      child = childOf(current, unit);
    }
    current = child ?? root;
    longest[start] =
      current.literal && !touchesAt(text, start + current.depth)
        ? current.depth
        : (current.untouched?.depth ?? 0);
  }
  const spans: Span[] = [];
  let ended = -1;
  for (let start = 0; start < text.length; start++) {
    const length = longest[start] as number;
    if (length === 0 || start === ended || touchesBefore(text, start)) continue;
    ended = start + length;
    spans.push([start, ended]);
    start = ended - 1;
  }
  return spans;
}

/** The index of the first code unit at or after `index` that {@link escapeText} decides on; the length when none. */
function decidedFrom(text: string, index: number): number {
  DECIDED.lastIndex = index;
  return DECIDED.test(text) ? DECIDED.lastIndex - 1 : text.length;
}

/**
 * Whether the {@link DECIDED} code unit at `index` of `text`, in the run
 * `[from, to)` between spans, takes a `\` to read as itself. `rendered` is the
 * line with its spans rendered, in which the unit sits at `renderedIndex`. A
 * span reads as a backtick to the code points beside it, which is what its
 * delimiter is.
 */
function escapes(
  text: string,
  index: number,
  from: number,
  to: number,
  rendered: string,
  renderedIndex: number,
): boolean {
  switch (text[index]) {
    case '\\': {
      /**
       * A backslash is literal before anything else; before trailing
       * whitespace it would escape the `&` of the reference that whitespace
       * becomes. The run ends at the end of the line or at a span.
       */
      if (index + 1 === to) return true;
      // One code unit: no code point outside the BMP is punctuation or whitespace.
      const next = text[index + 1] as string;
      return ASCII_PUNCTUATION.test(next) || /\s/.test(next);
    }
    case '_':
      // Intraword, between two letters or digits, it opens no emphasis.
      return !(
        index > from &&
        index + 1 < to &&
        WORD_CHARACTER.test(pointBefore(text, index)) &&
        WORD_CHARACTER.test(pointAt(text, index + 1))
      );
    case '<':
      // Tested against the line as rendered: a span after it is backticks.
      MARKUP_OPENER.lastIndex = renderedIndex;
      return MARKUP_OPENER.test(rendered);
    case '&':
      // An entity is matched within the run only.
      REFERENCE_AT.lastIndex = index;
      return REFERENCE_AT.test(text) && REFERENCE_AT.lastIndex <= to;
    default:
      return true;
  }
}

/** `text` with each of `spans` rendered as a {@link codeSpan}. */
function withSpans(text: string, spans: readonly Span[]): string {
  const out = new Output();
  let from = 0;
  for (const [start, end] of spans) {
    out.add(text.slice(from, start));
    out.add(codeSpan(text.slice(start, end)));
    from = end;
  }
  out.add(text.slice(from));
  return out.join();
}

/**
 * Escapes `text`, a line without its edge whitespace, and renders each of
 * `spans` as a {@link codeSpan}: a `\` before one stays escaped, and an `_`
 * beside one is never intraword.
 *
 * The result is built from slices of `text` between the code units it
 * escapes, so its working memory stays proportional to the output, and a line
 * with nothing to escape and no span comes back as itself.
 */
function escapeText(text: string, spans: readonly Span[]): string {
  const rendered = spans.length === 0 ? text : withSpans(text, spans);
  let out: Output | undefined;
  let written = 0; // `text` before this is in `out`
  let shift = 0; // how much longer the spans so far render than they are
  let from = 0;
  // The next decided unit, kept across spans: a scan never starts before one it found.
  let next = -1;
  for (const [start, end] of [...spans, [text.length, text.length] as const]) {
    if (next < from) next = decidedFrom(text, from);
    for (; next < start; next = decidedFrom(text, next + 1)) {
      if (!escapes(text, next, from, start, rendered, next + shift)) continue;
      out ??= new Output();
      out.add(text.slice(written, next));
      out.add('\\');
      written = next;
    }
    if (start < end) {
      const span = codeSpan(text.slice(start, end));
      out ??= new Output();
      out.add(text.slice(written, start));
      out.add(span);
      written = end;
      shift += span.length - (end - start);
    }
    from = end;
  }
  if (out === undefined) return text;
  out.add(text.slice(written));
  return out.join();
}

/**
 * Escapes the characters on one line that a CommonMark inline or block parse
 * would read as syntax, rendering each occurrence of a `literals` value as a
 * code span. `line` holds no line break; its leading and trailing
 * whitespace becomes numeric references, since a paragraph strips spaces and
 * tabs and a GFM table cell (markdown-it's `String.prototype.trim`) strips
 * every Unicode whitespace character. U+000B (vertical tab) is the exception
 * and stays literal: markdown-it decodes `&#11;` as U+FFFD, while the literal
 * character reads back wherever no trim reaches it.
 */
function escapeLine(line: string, literals: LiteralNode | undefined): string {
  const lead = /^[^\S\v]*/u.exec(line)?.[0] ?? '';
  if (lead.length === line.length) return toReferences(line);
  // Found by scanning back from the end, so its cost is linear in the line.
  // Every whitespace character is one UTF-16 code unit, and the scan never
  // reaches `lead`: the character just after it is not edge whitespace.
  let end = line.length;
  while (EDGE_SPACE.test(line[end - 1] as string)) end--;
  const trail = line.slice(end);
  const text = line.slice(lead.length, end);
  let core = escapeText(text, literals === undefined ? [] : literalSpans(text, literals));
  // Block structure is read from the start of the line, so a marker only opens
  // a heading, quote, list, rule, or setext underline when no indentation
  // precedes it — and indentation here is always a reference.
  if (lead === '') core = escapeLineStart(core);
  // An ATX heading drops a `#` run that ends its line after a space or tab as
  // its closing sequence; escaping the run's last `#` keeps it text. Trailing
  // whitespace is a reference, which already ends the run.
  if (trail === '') core = core.replace(/(?<=[ \t]#*)#$/, '\\#');
  return `${toReferences(lead)}${core}${toReferences(trail)}`;
}

/**
 * Escapes a block marker opening a line: an ATX heading opener (one to six `#`
 * before a space, a tab, or the end), a line of `#` alone, which a heading
 * reads as its closing sequence, `>`, a list marker, a thematic break, a
 * setext underline, or a GFM table delimiter row (`:-`, `-:`), which turns the
 * line above into a header even when its only pipe is escaped.
 */
function escapeLineStart(core: string): string {
  if (
    /^(?:#{1,6}|[-+])(?:[ \t]|$)/.test(core) ||
    /^-[- \t]*$/.test(core) ||
    /^#+$/.test(core) ||
    /^=+$/.test(core) ||
    /^:?-+:?$/.test(core) ||
    core.startsWith('>')
  ) {
    return `\\${core}`;
  }
  // Ordered list marker: escape the delimiter, since `1\.` is the shortest literal form.
  return core.replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2');
}

/**
 * Each character of `whitespace`, a run of edge whitespace, as its decimal
 * numeric reference (`&#32;`, `&#9;`, `&#160;`). A run of one character is one
 * repeated reference, so working memory stays proportional to the output.
 * Every whitespace character is one UTF-16 code unit.
 */
function toReferences(whitespace: string): string {
  if (whitespace === '') return '';
  const out = new Output();
  for (let start = 0; start < whitespace.length; ) {
    const unit = whitespace.charCodeAt(start);
    let end = start + 1;
    while (whitespace.charCodeAt(end) === unit) end++;
    out.add(`&#${unit};`.repeat(end - start));
    start = end;
  }
  return out.join();
}

/**
 * Encodes `text` as Markdown that a CommonMark parse reads back as exactly
 * `text`: no emphasis, code, link, image, raw HTML, autolink, entity, heading,
 * quote, list, rule, or table. Use it on every string a `format()` interpolates
 * that the tool did not author, so `content[]` carries the value
 * `structuredContent` does.
 *
 * Only what can parse as syntax is escaped, so ordinary text stays readable:
 * `<=50`, `AT&T`, `C#`, `C# 12`, `a # b`, `snake_case`, and `C:\Users\x` come
 * back unchanged.
 * - A backslash before ASCII punctuation, whitespace, or the end of the line.
 * - `` ` `` `*` `[` `]` `|` `~` everywhere, and `_` unless a letter or digit
 *   sits on both sides of it.
 * - `<` before a letter, `/`, `!`, `?`, or an email autolink; `&` before an
 *   entity-shaped run (`&copy;`, `&#123;`).
 * - At the start of every line: an ATX heading opener (`#` to `######` before
 *   a space, a tab, or the line end), a line of `#` alone, which a heading
 *   would read as its closing sequence, `>`, a list marker, a thematic break, a
 *   setext underline, and a GFM table delimiter row.
 * - At the end of every line, the last `#` of a run a space or tab precedes
 *   (`abc #` → `abc \#`), which an ATX heading would drop as its closing
 *   sequence.
 * - Leading and trailing whitespace on each line, every Unicode whitespace
 *   character but U+000B included, becomes a numeric reference (`&#32;`,
 *   `&#9;`, `&#160;`), since a paragraph strips spaces and tabs and a GFM
 *   table cell strips the rest. A vertical tab stays literal: markdown-it
 *   decodes its reference as U+FFFD.
 * - A line break becomes a hard break (`\` before it), so the value stays one
 *   paragraph; a final line break becomes `&#10;`, where a hard break cannot
 *   stand. CR and CRLF read back as LF.
 *
 * The output is inline text, and reads back exactly in these slots: a value
 * of one line in a paragraph, after a label on the same line
 * (`Error: ${escapeMarkdownInline(message)}`), and in an ATX heading, list
 * item, block quote, or GFM table cell; a value with line breaks in a
 * paragraph, list item, or block quote, since a heading or table row ends at
 * the line break. Two encoded values placed edge to edge can still form syntax
 * neither holds (`<` then `b>`), so separate them with authored text. A NUL
 * character is outside the guarantee — CommonMark replaces it with U+FFFD.
 *
 * @example
 * ```ts
 * escapeMarkdownInline('A*p* <b>x</b>\n- y'); // 'A\\*p\\* \\<b>x\\</b>\\\n\\- y'
 * ```
 */
export function escapeMarkdownInline(text: string): string {
  return escapeLines(text, undefined);
}

/**
 * {@link escapeMarkdownInline}, except that each occurrence of a `literals`
 * value renders as a {@link codeSpan}, so a reader copying it from the text
 * carries no escape. The tool error renderer's encoder for the values an
 * `McpError` declares (`McpError.literals`).
 *
 * An occurrence counts when no letter, digit, or `_` touches it on either side
 * and it does not start where another ended (two spans edge to edge read as
 * one); between overlapping ones, the leftmost wins, then the longest. One
 * that would reach into a line's edge whitespace does not count. An empty
 * value, one holding a line break, and one holding a lone surrogate are
 * ignored. The text around each span is escaped as {@link escapeMarkdownInline}
 * escapes it, a span reading as a backtick to its neighbours, and a parse
 * reads the text and the spans' content back as `text`. With no occurrence the
 * output is {@link escapeMarkdownInline}'s. Linear in the length of `text` and
 * `literals` together.
 *
 * @internal
 */
export function escapeMarkdownInlineWithLiterals(
  text: string,
  literals: readonly string[],
): string {
  return escapeLines(text, literals.length === 0 ? undefined : literalTrie(literals));
}

/**
 * Escapes `text` line by line, joining the lines with hard breaks; a final
 * line break becomes `&#10;`. Lines are read in place and the output built in
 * chunks, so memory stays proportional to the output however many lines
 * `text` holds.
 */
function escapeLines(text: string, literals: LiteralNode | undefined): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  let end = normalized.indexOf('\n');
  if (end === -1) return escapeLine(normalized, literals);
  const out = new Output();
  out.add(escapeLine(normalized.slice(0, end), literals));
  for (let start = end + 1; start < normalized.length; start = end + 1) {
    end = normalized.indexOf('\n', start);
    if (end === -1) end = normalized.length;
    out.add('\\\n');
    out.add(escapeLine(normalized.slice(start, end), literals));
  }
  if (normalized.endsWith('\n')) out.add('&#10;');
  return out.join();
}

/**
 * An `http:` or `https:` URL a link destination can carry: one `URL` parses
 * and that holds no line break, which a destination cannot span.
 */
function isWebUrl(url: string): boolean {
  if (/[\r\n]/.test(url)) return false;
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

/** `url` as a `<…>` destination, which admits spaces and parentheses unescaped. */
function destination(url: string): string {
  return `<${url.replace(/[\\<>]/g, '\\$&').replace(ENTITY_AMPERSAND, '\\&')}>`;
}

/** The literal-text form of a link or image whose URL cannot be a destination. */
function literalTarget(label: string, url: string, title?: string): string {
  const target = title ? `${url} "${title}"` : url;
  return escapeMarkdownInline(label === '' ? target : `${label} (${target})`);
}

/**
 * Renders `[label](<url>)` so a CommonMark parse reads back `label` as the
 * link text and `url` as the destination, byte for byte: the label goes
 * through {@link escapeMarkdownInline}, and the destination is wrapped in
 * `<…>` with `\`, `<`, and `>` backslash-escaped rather than percent-encoded,
 * so it still equals the URL `structuredContent` carries.
 *
 * Only an absolute `http:` or `https:` URL renders as a link. Anything else —
 * `javascript:`, `data:`, a relative path, an unparseable string — renders as
 * literal text, `label (url)`, so the value stays visible without becoming a
 * live target.
 *
 * @example
 * ```ts
 * markdownLink('[docs]', 'https://example.com/q?x=<1>');
 * // '[\\[docs\\]](<https://example.com/q?x=\\<1\\>>)'
 * markdownLink('run', 'javascript:alert(1)'); // 'run (javascript:alert(1))'
 * ```
 */
export function markdownLink(label: string, url: string): string {
  if (!isWebUrl(url)) return literalTarget(label, url);
  return `[${escapeMarkdownInline(label)}](${destination(url)})`;
}

/**
 * Renders `![alt](<url> "title")` under the same rules as {@link markdownLink}:
 * the alt text escaped, the destination in `<…>`, and a non-`http(s)` URL as
 * literal text (`alt (url "title")`). Use it for an image field — a logo, a
 * thumbnail, a chart — so `content[]` shows the image rather than its URL
 * escaped into prose. A title, when given, is quoted with `"` and `\`
 * backslash-escaped and line breaks written as `&#10;`.
 *
 * @example
 * ```ts
 * markdownImage('Team logo', 'https://cdn.example/a b.png');
 * // '![Team logo](<https://cdn.example/a b.png>)'
 * ```
 */
export function markdownImage(alt: string, url: string, title?: string): string {
  if (!isWebUrl(url)) return literalTarget(alt, url, title);
  const titlePart = title
    ? ` "${title
        .replace(/[\\"]/g, '\\$&')
        .replace(ENTITY_AMPERSAND, '\\&')
        .replace(/\r\n?|\n/g, '&#10;')}"`
    : '';
  return `![${escapeMarkdownInline(alt)}](${destination(url)}${titlePart})`;
}
