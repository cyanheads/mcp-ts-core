/**
 * @fileoverview Sentence punctuation and list joining for text the framework
 * writes around authored or caller-derived text.
 * @module src/utils/formatting/sentence
 */

/**
 * `text`, trimmed and ending in terminal punctuation, so whatever is joined
 * after it starts a new sentence. Punctuating at the join leaves authored text
 * alone, terminator or not: a contract entry's `when` (#389), which nothing
 * validates a punctuation convention on, and an issue message restated in an
 * argument hint beside the framework's own sentences (#493).
 */
export function terminateSentence(text: string): string {
  const trimmed = text.trim();
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** `lat`, `lat and lon`, `lat, lon and alt`. */
export function joinNames(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
