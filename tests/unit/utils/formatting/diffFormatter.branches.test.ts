/**
 * @fileoverview Branch-focused tests for diff formatting fallbacks.
 * @module tests/utils/formatting/diffFormatter.branches.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode } from '../../../../src/types-global/errors.js';

const { createPatchMock, diffLinesMock, diffWordsMock } = vi.hoisted(() => ({
  createPatchMock: vi.fn(),
  diffLinesMock: vi.fn(),
  diffWordsMock: vi.fn(),
}));

vi.mock('diff', () => ({
  createPatch: createPatchMock,
  diffLines: diffLinesMock,
  diffWords: diffWordsMock,
}));

import { DiffFormatter } from '../../../../src/utils/formatting/diffFormatter.js';

describe('DiffFormatter branch behavior', () => {
  const formatter = new DiffFormatter();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a patch unchanged for an unknown format', async () => {
    createPatchMock.mockReturnValue('raw patch');

    const result = await formatter.diff('old', 'new', { format: 'future' as never });

    expect(result).toBe('raw patch');
  });

  it('keeps non-header body lines in inline output', async () => {
    createPatchMock.mockReturnValue(
      [
        'Index: a/file',
        '===================================================================',
        '--- old',
        '+++ new',
        '@@ -1 +1 @@',
        'unprefixed context',
        '-removed',
        '+added',
        ' unchanged',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );

    await expect(formatter.diff('old', 'new', { format: 'inline' })).resolves.toBe(
      'unprefixed context\n[-removed-]\n[+added+]\nunchanged',
    );
  });

  it.each([
    [new Error('patch exploded'), 'patch exploded'],
    ['patch rejected', 'patch rejected'],
  ])('normalizes a patch-generation failure %#', async (failure, message) => {
    createPatchMock.mockImplementation(() => {
      throw failure;
    });

    await expect(formatter.diff('old', 'new')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: `Failed to generate diff: ${message}`,
    });
  });

  it.each([
    [new Error('word diff exploded'), 'word diff exploded'],
    ['word diff rejected', 'word diff rejected'],
  ])('normalizes a word-diff failure %#', async (failure, message) => {
    diffWordsMock.mockImplementation(() => {
      throw failure;
    });

    await expect(formatter.diffWords('old', 'new')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: `Failed to generate word diff: ${message}`,
    });
  });

  it('treats absent change counts as zero', async () => {
    diffLinesMock.mockReturnValue([
      { added: true, count: 0 },
      { removed: true },
      { value: 'unchanged' },
    ]);

    await expect(formatter.getStats('old', 'new')).resolves.toEqual({
      additions: 0,
      deletions: 0,
      changes: 0,
    });
  });

  it.each([
    [new Error('stats exploded'), 'stats exploded'],
    ['stats rejected', 'stats rejected'],
  ])('normalizes a statistics failure %#', async (failure, message) => {
    diffLinesMock.mockImplementation(() => {
      throw failure;
    });

    await expect(formatter.getStats('old', 'new')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: `Failed to get diff stats: ${message}`,
    });
  });
});
