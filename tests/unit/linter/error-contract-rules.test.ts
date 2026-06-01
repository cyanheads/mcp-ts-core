/**
 * @fileoverview Tests for the declarative error contract lint rules.
 * @module tests/unit/linter/error-contract-rules.test
 */

import { describe, expect, it } from 'vitest';

import {
  lintErrorContract,
  lintErrorContractConformance,
} from '@/linter/rules/error-contract-rules.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

describe('lintErrorContract', () => {
  it('returns no diagnostics when errors is undefined', () => {
    expect(lintErrorContract(undefined, 'tool', 'x')).toEqual([]);
  });

  it('errors when errors is not an array', () => {
    const d = lintErrorContract({}, 'tool', 'x');
    expect(d).toHaveLength(1);
    expect(d[0]?.rule).toBe('error-contract-type');
    expect(d[0]?.severity).toBe('error');
  });

  it('accepts a well-formed contract', () => {
    const d = lintErrorContract(
      [
        {
          code: JsonRpcErrorCode.NotFound,
          reason: 'no_match',
          when: 'PMID not found',
          recovery: 'Try a broader query and retry the request.',
        },
        {
          code: JsonRpcErrorCode.RateLimited,
          reason: 'queue_full',
          when: 'Queue at capacity',
          retryable: true,
          recovery: 'Wait a few seconds before retrying the call.',
        },
      ],
      'tool',
      'x',
    );
    expect(d).toEqual([]);
  });

  it('errors when entry is not an object', () => {
    const d = lintErrorContract(['just a string'], 'tool', 'x');
    expect(d.map((x) => x.rule)).toContain('error-contract-entry-type');
  });

  it('errors when code is missing or wrong type', () => {
    const d = lintErrorContract([{ reason: 'r', when: 'w' }], 'tool', 'x');
    expect(d.map((x) => x.rule)).toContain('error-contract-code-type');
  });

  it('errors when code is not a real JsonRpcErrorCode', () => {
    const d = lintErrorContract([{ code: 9999, reason: 'r', when: 'w' }], 'tool', 'x');
    expect(d.map((x) => x.rule)).toContain('error-contract-code-unknown');
  });

  it('warns when code is JsonRpcErrorCode.UnknownError', () => {
    // UnknownError is the auto-classifier's giveup-fallback — declaring it in a
    // contract conveys nothing useful to clients.
    const d = lintErrorContract(
      [{ code: JsonRpcErrorCode.UnknownError, reason: 'huh', when: 'something broke' }],
      'tool',
      'x',
    );
    const finding = d.find((x) => x.rule === 'error-contract-code-unknown-error');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('UnknownError');
  });

  it('warns and short-circuits on an empty contract', () => {
    const d = lintErrorContract([], 'tool', 'x');
    expect(d).toHaveLength(1);
    expect(d[0]?.rule).toBe('error-contract-empty');
    expect(d[0]?.severity).toBe('warning');
  });

  it('errors when reason is missing', () => {
    const d = lintErrorContract([{ code: JsonRpcErrorCode.NotFound, when: 'w' }], 'tool', 'x');
    expect(d.map((x) => x.rule)).toContain('error-contract-reason-required');
  });

  it('warns when reason is not snake_case', () => {
    const d = lintErrorContract(
      [{ code: JsonRpcErrorCode.NotFound, reason: 'NotFound', when: 'w' }],
      'tool',
      'x',
    );
    const reasonFmt = d.find((x) => x.rule === 'error-contract-reason-format');
    expect(reasonFmt?.severity).toBe('warning');
  });

  it('errors on duplicate reason within a contract', () => {
    const d = lintErrorContract(
      [
        { code: JsonRpcErrorCode.NotFound, reason: 'r1', when: 'w' },
        { code: JsonRpcErrorCode.RateLimited, reason: 'r1', when: 'w' },
      ],
      'tool',
      'x',
    );
    expect(d.map((x) => x.rule)).toContain('error-contract-reason-unique');
  });

  it('errors when when is missing', () => {
    const d = lintErrorContract([{ code: JsonRpcErrorCode.NotFound, reason: 'r' }], 'tool', 'x');
    expect(d.map((x) => x.rule)).toContain('error-contract-when-required');
  });

  it('warns when retryable is not a boolean', () => {
    const d = lintErrorContract(
      [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w', retryable: 'yes' }],
      'tool',
      'x',
    );
    expect(d.map((x) => x.rule)).toContain('error-contract-retryable-type');
  });

  describe('recovery rules', () => {
    it('errors when recovery is missing', () => {
      const d = lintErrorContract(
        [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }],
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).toContain('error-contract-recovery-required');
    });

    it('errors when recovery is not a string', () => {
      const d = lintErrorContract(
        [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w', recovery: 42 }],
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).toContain('error-contract-recovery-required');
    });

    it('errors when recovery is empty', () => {
      const d = lintErrorContract(
        [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w', recovery: '' }],
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).toContain('error-contract-recovery-empty');
    });

    it('errors when recovery is whitespace-only', () => {
      const d = lintErrorContract(
        [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w', recovery: '   \t\n  ' }],
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).toContain('error-contract-recovery-empty');
    });

    it('warns when recovery has fewer than 5 words', () => {
      const d = lintErrorContract(
        [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w', recovery: 'Try again later.' }],
        'tool',
        'x',
      );
      const finding = d.find((x) => x.rule === 'error-contract-recovery-min-words');
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe('warning');
      expect(finding?.message).toContain('3 word');
    });

    it('accepts recovery with exactly 5 words', () => {
      const d = lintErrorContract(
        [
          {
            code: JsonRpcErrorCode.NotFound,
            reason: 'r',
            when: 'w',
            recovery: 'Try a different search term',
          },
        ],
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).not.toContain('error-contract-recovery-min-words');
    });

    it('does not double-flag a missing recovery as min-words too', () => {
      const d = lintErrorContract(
        [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }],
        'tool',
        'x',
      );
      // missing recovery → recovery-required only; min-words check is gated on
      // recovery being a non-empty string, so it should not also fire.
      expect(d.map((x) => x.rule)).not.toContain('error-contract-recovery-min-words');
    });
  });
});

describe('lintErrorContractConformance', () => {
  it('skips when no contract is declared', () => {
    const handler = new Function(
      'return async () => { throw new McpError(JsonRpcErrorCode.NotFound, "x"); }',
    )();
    const d = lintErrorContractConformance({ handler }, 'tool', 'x');
    expect(d).toEqual([]);
  });

  it('skips when handler is missing', () => {
    const d = lintErrorContractConformance(
      { errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }] },
      'tool',
      'x',
    );
    expect(d).toEqual([]);
  });

  it('does not flag codes mentioned only in comments', () => {
    const handler = new Function(
      `return async () => {
        // throws JsonRpcErrorCode.RateLimited if upstream is overloaded
        throw new McpError(JsonRpcErrorCode.NotFound, "x");
      }`,
    )();
    const d = lintErrorContractConformance(
      {
        handler,
        errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }],
      },
      'tool',
      'x',
    );
    // NotFound is declared → only the prefer-fail rule fires (no conformance miss).
    expect(d.map((x) => x.rule)).toContain('error-contract-prefer-fail');
    expect(d.map((x) => x.rule)).not.toContain('error-contract-conformance');
  });

  describe('baseline codes (auto-allowed)', () => {
    it.each([
      'InternalError',
      'ServiceUnavailable',
      'Timeout',
      'ValidationError',
      'SerializationError',
    ] as const)('skips %s', (codeName) => {
      const handler = new Function(
        `return async () => { throw new McpError(JsonRpcErrorCode.${codeName}, "x"); }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }],
        },
        'tool',
        'x',
      );
      expect(d).toEqual([]);
    });

    it('skips serviceUnavailable() factory call', () => {
      const handler = new Function(
        `return async () => { throw serviceUnavailable("upstream down"); }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }],
        },
        'tool',
        'x',
      );
      expect(d).toEqual([]);
    });
  });

  describe('error-contract-conformance (undeclared non-baseline codes)', () => {
    it('flags RateLimited when not declared', () => {
      const handler = new Function(
        `return async () => { throw new McpError(JsonRpcErrorCode.RateLimited, "slow"); }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'no match' }],
        },
        'tool',
        'x',
      );
      const conformance = d.find((x) => x.rule === 'error-contract-conformance');
      expect(conformance).toBeDefined();
      expect(conformance?.message).toContain('RateLimited');
      expect(conformance?.message).toContain('Baseline codes');
    });

    it('flags rateLimited() factory call when not declared', () => {
      const handler = new Function(`return async () => { throw rateLimited("slow"); }`)();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'no match' }],
        },
        'tool',
        'x',
      );
      expect(d.map((x) => x.rule)).toContain('error-contract-conformance');
    });

    it('mentions multiple undeclared codes in one diagnostic', () => {
      const handler = new Function(
        `return async () => {
          if (Math.random() > 0.3) throw new McpError(JsonRpcErrorCode.RateLimited, "slow");
          if (Math.random() > 0.5) throw new McpError(JsonRpcErrorCode.Forbidden, "no");
        }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'r', when: 'w' }],
        },
        'tool',
        'x',
      );
      const conformance = d.find((x) => x.rule === 'error-contract-conformance');
      expect(conformance?.message).toContain('RateLimited');
      expect(conformance?.message).toContain('Forbidden');
    });
  });

  describe('error-contract-prefer-fail (declared codes thrown directly)', () => {
    it('encourages routing through ctx.fail when a declared code is thrown directly', () => {
      const handler = new Function(
        `return async () => { throw new McpError(JsonRpcErrorCode.NotFound, "x"); }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'no match' }],
        },
        'tool',
        'x',
      );
      const preferFail = d.find((x) => x.rule === 'error-contract-prefer-fail');
      expect(preferFail).toBeDefined();
      expect(preferFail?.message).toContain('NotFound');
      expect(preferFail?.message).toContain("'no_match'");
      expect(preferFail?.message).toContain('ctx.fail');
    });

    it('lists multiple reasons when the same code maps to several entries', () => {
      const handler = new Function(`return async () => { throw notFound("x"); }`)();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [
            { code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'no match' },
            { code: JsonRpcErrorCode.NotFound, reason: 'withdrawn', when: 'withdrawn' },
          ],
        },
        'tool',
        'x',
      );
      const preferFail = d.find((x) => x.rule === 'error-contract-prefer-fail');
      expect(preferFail?.message).toContain("'no_match'");
      expect(preferFail?.message).toContain("'withdrawn'");
    });

    it('does not fire for baseline codes even when declared', () => {
      // If the user explicitly declares Timeout in the contract and then throws
      // it, we still skip — baseline codes are auto-allowed regardless.
      const handler = new Function(
        `return async () => { throw new McpError(JsonRpcErrorCode.Timeout, "x"); }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.Timeout, reason: 'slow', when: 'slow' }],
        },
        'tool',
        'x',
      );
      expect(d).toEqual([]);
    });

    it('does not treat JsonRpcErrorCode comparisons as direct throws', () => {
      const handler = new Function(
        `return async () => {
          try {
            throw new Error("boom");
          } catch (err) {
            if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
              throw ctx.fail("not_found", "Not found");
            }
            throw err;
          }
        }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'not_found', when: 'no match' }],
        },
        'tool',
        'x',
      );
      expect(d).toEqual([]);
    });
  });

  it('produces no diagnostics for a clean handler that uses ctx.fail', () => {
    // ctx.fail-routed throws don't reference JsonRpcErrorCode.X or a factory,
    // so they're invisible to the scan — and that's correct.
    const handler = new Function(
      `return async () => { throw ctx.fail('no_match', 'not found'); }`,
    )();
    const d = lintErrorContractConformance(
      {
        handler,
        errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'no match' }],
      },
      'tool',
      'x',
    );
    expect(d).toEqual([]);
  });
});
