/**
 * @fileoverview Sized CommonMark inline code span — the inline counterpart to
 * `MarkdownBuilder.codeBlock()`'s fence sizing. Shared by
 * `MarkdownBuilder.inlineCode()` and `formatOutline()` so every framework-built
 * span wraps a value it did not author the same way.
 * @module src/utils/formatting/codeSpan
 */

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
 * guarantee: a code span reads them back as spaces.
 *
 * @param value - Text placed verbatim inside the span.
 * @returns The span, delimiters and any padding included.
 */
export function codeSpan(value: string): string {
  if (value === '') return '``';
  // Iterated rather than collected: a value that is mostly backticks yields as
  // many runs as it has characters.
  let longestRun = 0;
  for (const [run] of value.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(longestRun + 1);
  const pad =
    value.startsWith('`') ||
    value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value))
      ? ' '
      : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}
