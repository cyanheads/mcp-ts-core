/**
 * @fileoverview Sized CommonMark code literals: the inline code span and the
 * fenced code block, each delimited past the longest backtick run in its
 * content. Shared by `MarkdownBuilder.inlineCode()` / `.codeBlock()`,
 * `formatOutline()`, and the enrichment trailer, so every framework-built
 * literal wraps a value it did not author the same way.
 * @module src/utils/formatting/codeSpan
 */

/** The length of the longest run of backticks in `value`; 0 when it holds none. */
function longestBacktickRun(value: string): number {
  // Iterated rather than collected: a value that is mostly backticks yields as
  // many runs as it has characters.
  let longest = 0;
  for (const [run] of value.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * Wraps `value` in an inline code span that reads back byte-identical under a
 * CommonMark parser.
 *
 * The backtick string is one longer than the longest backtick run in `value`,
 * since a span closes only on a run of exactly its opening length. A single
 * space pads each side when a backtick touches either end (it would otherwise
 * merge into the delimiter), or when the value both begins and ends with a
 * space without being all spaces (CommonMark strips one space from each side
 * of such content). A value with no backtick that does not both begin and end
 * with a space renders as a plain single-backtick span.
 *
 * An empty value renders as two backticks, and line endings are outside the
 * guarantee: a code span reads them back as spaces. {@link codeFence} holds a
 * value with line breaks.
 *
 * @param value - Text placed verbatim inside the span.
 * @returns The span, delimiters and any padding included.
 */
export function codeSpan(value: string): string {
  if (value === '') return '``';
  const fence = '`'.repeat(longestBacktickRun(value) + 1);
  const pad =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value))
      ? ' '
      : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/**
 * Wraps `content` in a fenced code block: an opening fence carrying `language`,
 * the content verbatim, and a closing fence, joined by line feeds, with no line
 * break after the closing fence.
 *
 * The fence is one backtick longer than the longest backtick run in `content`
 * and at least three, since a fenced block closes only on a run at least as
 * long as the one that opened it — content the caller did not author cannot
 * close the block early and be reparsed as Markdown. The block must start a
 * line and end one: a fence followed by text on its line does not close.
 *
 * @param content - Text placed verbatim between the fences.
 * @param language - Info string after the opening fence; empty for none.
 * @returns The block, both fences included.
 */
export function codeFence(content: string, language = ''): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}
