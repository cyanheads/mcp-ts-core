/**
 * @fileoverview Tests for the shared `<think>` regex the text parsers use to strip an
 * LLM reasoning preamble: anchored to the first character, closed by the first `</think>`.
 * @module tests/unit/utils/parsing/thinkBlock.test
 */
import { describe, expect, it } from 'vitest';

import { jsonParser } from '@/utils/parsing/jsonParser.js';
import { thinkBlockRegex } from '@/utils/parsing/thinkBlock.js';

describe('thinkBlockRegex', () => {
  it('captures the block body and the trimmed payload after a leading block', () => {
    const match = '<think> plan </think>\n  {"a":1}'.match(thinkBlockRegex);

    expect(match?.slice(1)).toEqual([' plan ', '{"a":1}']);
  });

  it('closes on the first </think> and leaves later ones in the payload', () => {
    const match = '<think>a</think>{"note":"</think>"}'.match(thinkBlockRegex);

    expect(match?.slice(1)).toEqual(['a', '{"note":"</think>"}']);
  });

  it.each([
    ['preceded by whitespace', ' <think>a</think>{}'],
    ['after the payload starts', '{"a":1}<think>b</think>'],
    ['that is never closed', '<think>a {}'],
  ])('does not match a block %s', (_label, input) => {
    expect(input.match(thinkBlockRegex)).toBeNull();
  });

  it('leaves a <think> block inside a JSON string value to the parser', async () => {
    await expect(jsonParser.parse('{"note":"<think>x</think> y"}')).resolves.toEqual({
      note: '<think>x</think> y',
    });
  });
});
