/**
 * @fileoverview Encoders that place text the caller did not author into
 * Markdown so a CommonMark parse reads it back unchanged:
 * {@link escapeMarkdownInline} for running text, {@link markdownLink} and
 * {@link markdownImage} for link and image syntax. `content[]` carries the same
 * data as `structuredContent`, so an upstream string must render as itself,
 * never as emphasis, a link, raw HTML, or a list it happens to resemble.
 * @module src/utils/formatting/markdownInline
 */

/** An `&` that starts a run CommonMark decodes as an entity or numeric reference. */
const ENTITY_AMPERSAND = /&(?=#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|[A-Za-z][A-Za-z0-9]{1,31};)/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ALWAYS_ESCAPED = new Set(['`', '*', '[', ']', '|', '~']);
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
/**
 * A `<` that opens raw HTML or a URI autolink, or an email autolink, whose
 * local part may start with a digit or symbol (`<1@a.io>`). Sticky, matched at
 * the `<` in place.
 */
const MARKUP_OPENER = /<(?:[A-Za-z/!?]|[^\s<>@]*@[^\s<>]*>)/y;

/**
 * Escapes the characters on one line that a CommonMark inline or block parse
 * would read as syntax. `line` holds no line break; its leading and trailing
 * whitespace becomes numeric references, since a paragraph strips spaces and
 * tabs and a GFM table cell (markdown-it's `String.prototype.trim`) strips
 * every Unicode whitespace character. U+000B (vertical tab) is the exception
 * and stays literal: markdown-it decodes `&#11;` as U+FFFD, while the literal
 * character reads back wherever no trim reaches it.
 */
function escapeLine(line: string): string {
  const lead = /^[^\S\v]*/u.exec(line)?.[0] ?? '';
  if (lead.length === line.length) return toReferences(line);
  const trail = /[^\S\v]*$/u.exec(line)?.[0] ?? '';
  const text = line.slice(lead.length, line.length - trail.length);
  // Code points, so a neighbour outside the BMP is tested as one character.
  const chars = Array.from(text);
  const out: string[] = [];
  let offset = 0;
  for (let i = 0; i < chars.length; offset += (chars[i] as string).length, i++) {
    const ch = chars[i] as string;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    let escaped: boolean;
    if (ch === '\\') {
      // A backslash is literal before anything else; before trailing whitespace
      // it would escape the `&` of the reference that whitespace becomes.
      escaped = next === undefined || ASCII_PUNCTUATION.test(next) || /\s/.test(next);
    } else if (ch === '_') {
      escaped = !(
        prev !== undefined &&
        next !== undefined &&
        WORD_CHARACTER.test(prev) &&
        WORD_CHARACTER.test(next)
      );
    } else if (ch === '<') {
      MARKUP_OPENER.lastIndex = offset;
      escaped = MARKUP_OPENER.test(text);
    } else {
      escaped = ALWAYS_ESCAPED.has(ch);
    }
    out.push(escaped ? `\\${ch}` : ch);
  }
  let core = out.join('').replace(ENTITY_AMPERSAND, '\\&');
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
 * Escapes a block marker opening a line: `#`, `>`, a list marker, a thematic
 * break, a setext underline, or a GFM table delimiter row (`:-`, `-:`), which
 * turns the line above into a header even when its only pipe is escaped.
 */
function escapeLineStart(core: string): string {
  if (
    /^(?:#{1,6}|[-+])(?:[ \t]|$)/.test(core) ||
    /^-[- \t]*$/.test(core) ||
    /^=+$/.test(core) ||
    /^:?-+:?$/.test(core) ||
    core.startsWith('>')
  ) {
    return `\\${core}`;
  }
  // Ordered list marker: escape the delimiter, since `1\.` is the shortest literal form.
  return core.replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2');
}

/** Each whitespace character as its decimal numeric reference (`&#32;`, `&#9;`, `&#160;`). */
function toReferences(whitespace: string): string {
  return whitespace.replace(/\s/gu, (ch) => `&#${ch.codePointAt(0)};`);
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
 * - At the start of every line: `#`, `>`, a list marker, a thematic break, a
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
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let out = escapeLine(lines[0] as string);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    out += i === lines.length - 1 && line === '' ? '&#10;' : `\\\n${escapeLine(line)}`;
  }
  return out;
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
