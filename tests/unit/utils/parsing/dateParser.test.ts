/**
 * @fileoverview Unit tests for the date parsing utilities, run against the real chrono-node.
 * @module tests/utils/parsing/dateParser.test
 */
import * as chrono from 'chrono-node';
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode } from '../../../../src/types-global/errors.js';
import {
  parseDateString,
  parseDateStringDetailed,
} from '../../../../src/utils/parsing/dateParser.js';

/**
 * tests/setup.ts stubs chrono-node for every file. Restore the real parser here so the
 * assertions read chrono's own output; `parse` is wrapped only so one case can inject a throw.
 */
vi.mock('chrono-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chrono-node')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

const context = {
  requestId: 'date-parser-test',
  timestamp: new Date().toISOString(),
};

/** Saturday 5 January 2030, noon local time. */
const saturday = new Date(2030, 0, 5, 12, 0, 0);

/** Local calendar parts, so every expectation holds in any timezone. */
const localDay = (date: Date | null) =>
  date && [date.getFullYear(), date.getMonth(), date.getDate()];

describe('parseDateString', () => {
  it('resolves a relative expression against the reference date', async () => {
    const result = await parseDateString('tomorrow at 9am', context, saturday);

    expect(localDay(result)).toEqual([2030, 0, 6]);
    expect(result?.getHours()).toBe(9);
  });

  it('resolves a bare weekday forward from the reference date, never into the past', async () => {
    const result = await parseDateString('Friday', context, saturday);

    expect(localDay(result)).toEqual([2030, 0, 11]);
  });

  it('returns null when the text holds no date', async () => {
    await expect(parseDateString('definitely not a date', context, saturday)).resolves.toBeNull();
  });
});

describe('parseDateStringDetailed', () => {
  it('returns each date expression with its matched text, resolved forward', async () => {
    const results = await parseDateStringDetailed(
      'Review on Friday and ship tomorrow',
      context,
      saturday,
    );

    expect(results.map((result) => [result.text, localDay(result.start.date())])).toEqual([
      ['on Friday', [2030, 0, 11]],
      ['tomorrow', [2030, 0, 6]],
    ]);
  });

  it('wraps unexpected errors in an McpError', async () => {
    vi.mocked(chrono.parse).mockImplementationOnce(() => {
      throw new Error('chrono blew up');
    });

    await expect(parseDateStringDetailed('tomorrow at 9', context)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ParseError,
      message: 'chrono blew up',
    });
  });
});
