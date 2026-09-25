/**
 * @fileoverview Tests for the declarative error contract lint rules.
 * @module tests/unit/linter/error-contract-rules.test
 */

import { describe, expect, it } from 'vitest';

import {
  lintErrorContract,
  lintErrorContractConformance,
  lintErrorContractRecoveryUnforwarded,
  lintErrorContractUnthrown,
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

  // Issue #380 — `severity` selects a logger method, so an unrecognized value
  // is a hard failure rather than inert metadata.
  describe('severity rules (#380)', () => {
    /** Diagnostics for a minimal well-formed entry carrying `severity`. */
    function lintSeverity(severity: unknown) {
      return lintErrorContract(
        [
          {
            code: JsonRpcErrorCode.InvalidRequest,
            reason: 'consent_declined',
            when: 'The caller declined the confirmation prompt.',
            recovery: 'Re-run the tool and confirm the prompt to proceed.',
            severity,
          },
        ],
        'tool',
        'x',
      );
    }

    it.each(['debug', 'info', 'notice', 'warning'] as const)('accepts %s', (severity) => {
      expect(lintSeverity(severity)).toEqual([]);
    });

    it.each([
      ['error', 'the default level, which is expressed by omitting the field'],
      ['crit', 'a level above error'],
      ['WARNING', 'the right level in the wrong case'],
      ['warn', 'the pino spelling rather than the logger method name'],
      [42, 'a non-string'],
      [null, 'a null'],
    ])('rejects %o — %s', (severity, _why) => {
      const finding = lintSeverity(severity).find(
        (x) => x.rule === 'error-contract-severity-unknown',
      );
      expect(finding?.severity).toBe('error');
      expect(finding?.message).toContain('debug');
      expect(finding?.message).toContain('warning');
    });
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
  });

  describe('throw-awareness — comparisons and case labels are not throws (#191)', () => {
    it('does not count a JsonRpcErrorCode comparison as a direct throw', () => {
      // The only throw is ctx.fail — the NotFound reference is a comparison in a
      // catch that re-routes correctly. Neither conformance rule should fire.
      const handler = new Function(
        `return async () => {
          try {
            await doThing();
          } catch (err) {
            if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
              throw ctx.fail('not_found', 'gone');
            }
            throw err;
          }
        }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'not_found', when: 'no record' }],
        },
        'tool',
        'x',
      );
      expect(d).toEqual([]);
    });

    it('does not count a JsonRpcErrorCode case label as a direct throw', () => {
      const handler = new Function(
        `return async () => {
          switch (someCode) {
            case JsonRpcErrorCode.RateLimited:
              return retry();
          }
          throw ctx.fail('not_found', 'gone');
        }`,
      )();
      const d = lintErrorContractConformance(
        {
          handler,
          errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'not_found', when: 'no record' }],
        },
        'tool',
        'x',
      );
      // RateLimited appears only in a case label → must not be flagged as undeclared,
      // and NotFound is never thrown → prefer-fail must not fire either.
      expect(d.map((x) => x.rule)).not.toContain('error-contract-conformance');
      expect(d.map((x) => x.rule)).not.toContain('error-contract-prefer-fail');
    });
  });

  it('keeps its own diagnostics when a declared reason is never thrown (#290 regression)', () => {
    // `error-contract-unthrown` is a separate rule; adding it must not change
    // what the conformance scan reports for the same definition.
    const handler = new Function(
      `return async () => { throw ctx.fail('no_match', 'not found'); }`,
    )();
    const d = lintErrorContractConformance(
      {
        handler,
        errors: [
          { code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'no match' },
          { code: JsonRpcErrorCode.NotFound, reason: 'site_not_found', when: 'bad site' },
        ],
      },
      'tool',
      'x',
    );
    expect(d).toEqual([]);
  });
});

// Issue #290 — the conformance scan runs in one direction only: codes observed
// in the handler that were never declared. A declared reason no code path can
// produce is the inverse, and it costs the client, which plans around the
// advertised failure surface.
describe('lintErrorContractUnthrown', () => {
  /** A handler function compiled from source text, as the linter sees it. */
  const handlerOf = (body: string) => new Function(`return async ${body}`)();

  /** Reasons flagged as unthrown for a handler body and a declared contract. */
  function unthrownReasons(body: string, reasons: readonly string[]): string[] {
    const d = lintErrorContractUnthrown(
      {
        handler: handlerOf(body),
        errors: reasons.map((reason) => ({
          code: JsonRpcErrorCode.NotFound,
          reason,
          when: 'w',
          recovery: 'Try a different identifier and call again.',
        })),
      },
      'tool',
      'water_get_series',
    );
    for (const diagnostic of d) {
      expect(diagnostic.rule).toBe('error-contract-unthrown');
      expect(diagnostic.severity).toBe('warning');
    }
    return d.map((x) => x.message);
  }

  it('flags a declared reason no ctx.fail names', () => {
    const [message, ...rest] = unthrownReasons(
      `(input, ctx) => { if (!rows.length) throw ctx.fail('no_match', 'No rows in range'); }`,
      ['no_match', 'site_not_found'],
    );

    expect(rest).toEqual([]);
    expect(message).toContain("tool 'water_get_series'");
    expect(message).toContain("'site_not_found'");
    // Both fixes, because which one is right is the author's call.
    expect(message).toMatch(/wire the throw/i);
    expect(message).toMatch(/drop the entry/i);
  });

  it('flags every unmatched reason of a multi-entry contract', () => {
    expect(
      unthrownReasons(`(input, ctx) => { throw ctx.fail('a', 'x'); }`, ['a', 'b', 'c']),
    ).toHaveLength(2);
  });

  it('counts a reason reached only through ctx.recoveryFor as thrown', () => {
    // The reason is produced by a service that spreads the resolver; the
    // handler names it, which is all the scan can ask for.
    expect(
      unthrownReasons(
        `(input, ctx) => {
          if (a) throw ctx.fail('no_match', 'x');
          throw validationError('bad', { reason: 'parse_failed', ...ctx.recoveryFor('parse_failed') });
        }`,
        ['no_match', 'parse_failed'],
      ),
    ).toEqual([]);
  });

  it('stays silent when every declared reason is matched', () => {
    expect(
      unthrownReasons(
        `(input, ctx) => {
          if (a) throw ctx.fail('no_match', 'x');
          throw ctx.fail("site_not_found", 'y');
        }`,
        ['no_match', 'site_not_found'],
      ),
    ).toEqual([]);
  });

  describe('trigger — only a handler that already throws literally', () => {
    it('stays silent when the handler holds no literal ctx.fail at all', () => {
      // Its reasons are produced somewhere the scan cannot reach; firing here
      // would warn on every service-layer definition.
      expect(unthrownReasons(`(input, ctx) => { throw notFound('gone'); }`, ['no_match'])).toEqual(
        [],
      );
    });

    it.each([
      ['a variable', `(input, ctx) => { throw ctx.fail(reason, 'x'); }`],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: handler source under test, not an interpolation.
      ['a template literal', "(input, ctx) => { throw ctx.fail(`no_${kind}`, 'x'); }"],
      ['a map lookup', `(input, ctx) => { throw ctx.fail(REASONS[kind], 'x'); }`],
    ])('stays silent when a ctx.fail takes %s as its first argument', (_label, body) => {
      expect(unthrownReasons(body, ['no_match', 'site_not_found'])).toEqual([]);
    });

    it('bails on the whole definition when one site of several is non-literal', () => {
      expect(
        unthrownReasons(
          `(input, ctx) => {
            if (a) throw ctx.fail('no_match', 'x');
            throw ctx.fail(dynamicReason, 'y');
          }`,
          ['no_match', 'site_not_found'],
        ),
      ).toEqual([]);
    });
  });

  describe('a reason inside a comment or another literal is not a throw', () => {
    it('does not count a ctx.fail written inside a line comment', () => {
      expect(
        unthrownReasons(
          `(input, ctx) => {
            // once this lands: throw ctx.fail('site_not_found', 'x');
            throw ctx.fail('no_match', 'y');
          }`,
          ['no_match', 'site_not_found'],
        ),
      ).toHaveLength(1);
    });

    it('does not count a ctx.fail written inside a block comment', () => {
      expect(
        unthrownReasons(
          `(input, ctx) => {
            /* throw ctx.fail('site_not_found', 'x'); */
            throw ctx.fail('no_match', 'y');
          }`,
          ['no_match', 'site_not_found'],
        ),
      ).toHaveLength(1);
    });

    it('does not count a reason that appears only inside another string', () => {
      expect(
        unthrownReasons(
          `(input, ctx) => {
            log("ctx.fail('site_not_found')");
            throw ctx.fail('no_match', 'y');
          }`,
          ['no_match', 'site_not_found'],
        ),
      ).toHaveLength(1);
    });

    it('reads the reason from the raw source, not the blanked scan text', () => {
      // `stripCommentsAndStrings` blanks literal contents and keeps the quotes,
      // so the reason survives only in the source at the same offset.
      expect(
        unthrownReasons(`(input, ctx) => { throw ctx.fail('site_not_found', 'x'); }`, [
          'site_not_found',
        ]),
      ).toEqual([]);
    });
  });

  describe('skips', () => {
    it('skips a definition with no contract', () => {
      expect(
        lintErrorContractUnthrown(
          { handler: handlerOf(`(input, ctx) => { throw ctx.fail('a', 'x'); }`) },
          'tool',
          'x',
        ),
      ).toEqual([]);
    });

    it('skips a definition with no handler', () => {
      expect(
        lintErrorContractUnthrown(
          { errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'a', when: 'w' }] },
          'tool',
          'x',
        ),
      ).toEqual([]);
    });
  });

  it('applies to resources too', () => {
    const d = lintErrorContractUnthrown(
      {
        handler: handlerOf(`(params, ctx) => { throw ctx.fail('no_match', 'x'); }`),
        errors: [
          { code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'w' },
          { code: JsonRpcErrorCode.NotFound, reason: 'stale', when: 'w' },
        ],
      },
      'resource',
      'item://{id}',
    );

    expect(d).toHaveLength(1);
    expect(d[0]?.definitionType).toBe('resource');
    expect(d[0]?.message).toContain("resource 'item://{id}'");
  });

  // Issue #462 — the trigger switches the rule on for the whole definition, so a
  // handler mixing one local precondition with service-produced reasons drew one
  // warning per service reason, with no way to clear it.
  describe("thrownBy: 'service' (#462)", () => {
    /** One local precondition, then delegation — the shape the marker exists for. */
    const MIXED = `(input, ctx) => {
      if (input.query === '*') throw ctx.fail('query_too_broad', 'Wildcard query');
      return getItemService().search(input, ctx);
    }`;

    /** Messages flagged for the mixed handler with `marked` reasons carrying the field. */
    function flagged(marked: readonly string[]): string[] {
      return lintErrorContractUnthrown(
        {
          handler: handlerOf(MIXED),
          errors: ['query_too_broad', 'item_not_found', 'bad_cursor'].map((reason) => ({
            code: JsonRpcErrorCode.NotFound,
            reason,
            when: 'w',
            recovery: 'Broaden the query and search again.',
            ...(marked.includes(reason) ? { thrownBy: 'service' as const } : {}),
          })),
        },
        'tool',
        'search_items',
      ).map((x) => x.message);
    }

    it('flags both service-produced reasons when neither is marked', () => {
      const messages = flagged([]);
      expect(messages).toHaveLength(2);
      expect(messages.join('\n')).toContain("'item_not_found'");
      expect(messages.join('\n')).toContain("'bad_cursor'");
    });

    it('stays silent on a marked entry no literal call names', () => {
      expect(flagged(['item_not_found', 'bad_cursor'])).toEqual([]);
    });

    it('keeps flagging an unmarked dead entry beside a marked one', () => {
      const messages = flagged(['item_not_found']);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("'bad_cursor'");
      expect(messages[0]).not.toContain("'item_not_found'");
    });

    it('names all three fixes', () => {
      const [message] = flagged([]);
      expect(message).toMatch(/wire the throw/i);
      expect(message).toMatch(/drop the entry/i);
      expect(message).toContain("thrownBy: 'service'");
    });

    it('marks entries on resources too', () => {
      expect(
        lintErrorContractUnthrown(
          {
            handler: handlerOf(`(params, ctx) => { throw ctx.fail('no_match', 'x'); }`),
            errors: [
              { code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'w' },
              { code: JsonRpcErrorCode.NotFound, reason: 'stale', when: 'w', thrownBy: 'service' },
            ],
          },
          'resource',
          'item://{id}',
        ),
      ).toEqual([]);
    });
  });

  // Issue #462 — a non-literal `ctx.recoveryFor(` puts unknown reasons in play
  // exactly as a non-literal `ctx.fail(` does; only the fail scan was consulted.
  describe('an unreadable ctx.recoveryFor bails the definition (#462)', () => {
    it.each([
      [
        'a variable',
        `(input, ctx) => { throw ctx.fail('no_match', 'x', { ...ctx.recoveryFor(err.data.reason) }); }`,
      ],
      [
        'a template literal',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: handler source under test, not an interpolation.
        "(input, ctx) => { throw ctx.fail('no_match', 'x', { ...ctx.recoveryFor(`no_${kind}`) }); }",
      ],
      [
        'a map lookup',
        `(input, ctx) => { throw ctx.fail('no_match', 'x', { ...ctx.recoveryFor(REASONS[kind]) }); }`,
      ],
    ])('stays silent when a ctx.recoveryFor takes %s as its first argument', (_label, body) => {
      expect(unthrownReasons(body, ['no_match', 'site_not_found'])).toEqual([]);
    });
  });
});

// Issue #255 — a contract `recovery` string reaches the wire only when the
// throw site forwards it. A site that omits the forward lints clean today and
// error-path tests asserting `code` and `reason` pass with the hint absent.
describe('lintErrorContractRecoveryUnforwarded', () => {
  /** A handler function compiled from source text, as the linter sees it. */
  const handlerOf = (body: string) => new Function(`return async ${body}`)();

  /** Every reason the fixtures below throw, so the contract covers all of them. */
  const REASONS = ['rate_limited', 'no_match', 'bad_cursor'] as const;

  /** Diagnostics for a handler body against a contract declaring every fixture reason. */
  function diagnose(
    body: string,
    definitionType: 'tool' | 'resource' = 'tool',
    definitionName = 'search_items',
  ) {
    const d = lintErrorContractRecoveryUnforwarded(
      {
        handler: handlerOf(body),
        errors: REASONS.map((reason) => ({
          code: JsonRpcErrorCode.RateLimited,
          reason,
          when: 'w',
          recovery: 'Wait 30 seconds before retrying or reduce the batch size.',
        })),
      },
      definitionType,
      definitionName,
    );
    for (const diagnostic of d) {
      expect(diagnostic.rule).toBe('error-contract-recovery-unforwarded');
      expect(diagnostic.severity).toBe('warning');
    }
    return d;
  }

  /** Diagnostic messages for a handler body. */
  const messages = (body: string) => diagnose(body).map((x) => x.message);

  describe('sites that omit the forward', () => {
    it('flags a two-argument site and names the correction', () => {
      const [message, ...rest] = messages(
        `(input, ctx) => { throw ctx.fail('rate_limited', 'Upstream rate limit exceeded'); }`,
      );

      expect(rest).toEqual([]);
      expect(message).toContain("tool 'search_items'");
      expect(message).toContain("'rate_limited'");
      expect(message).toContain("ctx.recoveryFor('rate_limited')");
    });

    it('flags a site that passes only the reason', () => {
      expect(messages(`(input, ctx) => { throw ctx.fail('rate_limited'); }`)).toHaveLength(1);
    });

    it('flags a data object whose keys carry no recovery', () => {
      expect(
        messages(`(input, ctx) => { throw ctx.fail('rate_limited', 'slow', { attempts: 3 }); }`),
      ).toHaveLength(1);
    });

    it('flags one site of a handler that wires the other', () => {
      const [message, ...rest] = messages(
        `(input, ctx) => {
          if (a) throw ctx.fail('no_match', 'x', { ...ctx.recoveryFor('no_match') });
          throw ctx.fail('rate_limited', 'y');
        }`,
      );

      expect(rest).toEqual([]);
      expect(message).toContain("'rate_limited'");
      expect(message).not.toContain("'no_match'");
    });

    it('flags only the bare one of two sites naming the same reason', () => {
      expect(
        messages(
          `(input, ctx) => {
            if (a) throw ctx.fail('no_match', 'x', { ...ctx.recoveryFor('no_match') });
            if (b) throw ctx.fail('no_match', 'y');
          }`,
        ),
      ).toHaveLength(1);
    });

    it('applies to resources too', () => {
      const d = diagnose(
        `(params, ctx) => { throw ctx.fail('no_match', 'x'); }`,
        'resource',
        'item://{id}',
      );

      expect(d).toHaveLength(1);
      expect(d[0]?.definitionType).toBe('resource');
      expect(d[0]?.message).toContain("resource 'item://{id}'");
    });
  });

  describe('a resolver naming another reason', () => {
    it('warns naming both reasons when spread into the data object', () => {
      const [message, ...rest] = messages(
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', { ...ctx.recoveryFor('no_match') }); }`,
      );

      expect(rest).toEqual([]);
      expect(message).toContain("'rate_limited'");
      expect(message).toContain("'no_match'");
    });

    it('warns naming both reasons when passed as the data argument', () => {
      const [message] = messages(
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', ctx.recoveryFor('no_match')); }`,
      );

      expect(message).toContain("'rate_limited'");
      expect(message).toContain("'no_match'");
    });
  });

  describe('accepted forwarding forms', () => {
    it.each([
      [
        'spread into the data object',
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', { ...ctx.recoveryFor('rate_limited') }); }`,
      ],
      [
        'passed as the data argument',
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', ctx.recoveryFor('rate_limited')); }`,
      ],
      [
        'an explicit recovery key',
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', { recovery: { hint: 'Retry in ' + n + 's.' } }); }`,
      ],
      [
        'spread alongside other keys',
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', { attempts: 3, ...ctx.recoveryFor('rate_limited') }); }`,
      ],
    ])('stays silent for a resolver %s', (_label, body) => {
      expect(messages(body)).toEqual([]);
    });

    it('reads past a nested object and a comma inside a nested call', () => {
      // The data argument is the third top-level argument, not the third comma.
      expect(
        messages(
          `(input, ctx) => {
            throw ctx.fail('rate_limited', renderMessage(input.query, retries), {
              meta: { retries, window: { seconds: 30 } },
              ...ctx.recoveryFor('rate_limited'),
            });
          }`,
        ),
      ).toEqual([]);
    });

    it('checks a site nested inside a closure', () => {
      expect(
        messages(
          `(input, ctx) => {
            return input.ids.map((id) => {
              if (!lookup(id)) throw ctx.fail('no_match', 'missing ' + id);
              return id;
            });
          }`,
        ),
      ).toHaveLength(1);
    });
  });

  describe('bails — the scan cannot tell what the site carries', () => {
    it.each([
      ['an identifier', `(input, ctx) => { throw ctx.fail('rate_limited', 'x', data); }`],
      [
        'a call other than the resolver',
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', buildErrorData(input)); }`,
      ],
      [
        'an object literal spreading another value',
        `(input, ctx) => { throw ctx.fail('rate_limited', 'x', { ...details }); }`,
      ],
    ])('stays silent for a data argument that is %s', (_label, body) => {
      expect(messages(body)).toEqual([]);
    });

    it.each([
      ['ctx.fail', `(input, ctx) => { throw ctx.fail(reason, 'x'); }`],
      [
        'ctx.recoveryFor',
        `(input, ctx) => {
          throw ctx.fail('rate_limited', 'x', { ...ctx.recoveryFor(err.data.reason) });
        }`,
      ],
    ])(
      'stays silent on the whole definition when %s takes a non-literal reason',
      (_label, body) => {
        expect(messages(body)).toEqual([]);
      },
    );

    it('stays silent for a reason whose resolver is hoisted above the throw', () => {
      expect(
        messages(
          `(input, ctx) => {
            const hint = ctx.recoveryFor('rate_limited');
            throw ctx.fail('rate_limited', 'x', { ...hint });
          }`,
        ),
      ).toEqual([]);
    });

    it('skips a definition with no contract', () => {
      expect(
        lintErrorContractRecoveryUnforwarded(
          { handler: handlerOf(`(input, ctx) => { throw ctx.fail('rate_limited', 'x'); }`) },
          'tool',
          'search_items',
        ),
      ).toEqual([]);
    });

    it('skips a definition with no handler', () => {
      expect(
        lintErrorContractRecoveryUnforwarded(
          { errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'w' }] },
          'tool',
          'search_items',
        ),
      ).toEqual([]);
    });
  });

  describe('a call inside a comment or another literal is not a site', () => {
    it('does not count a ctx.fail written inside a line comment', () => {
      expect(
        messages(
          `(input, ctx) => {
            // once this lands: throw ctx.fail('bad_cursor', 'x');
            throw ctx.fail('no_match', 'y', { ...ctx.recoveryFor('no_match') });
          }`,
        ),
      ).toEqual([]);
    });

    it('does not count a ctx.recoveryFor written inside another string', () => {
      // The forward is quoted, not called — the site is still bare.
      expect(
        messages(
          `(input, ctx) => {
            log("{ ...ctx.recoveryFor('no_match') }");
            throw ctx.fail('no_match', 'y');
          }`,
        ),
      ).toHaveLength(1);
    });
  });

  it("checks a thrownBy: 'service' entry the handler also throws locally", () => {
    // The marker takes an entry out of `error-contract-unthrown`'s reach; it
    // says nothing about a site that does exist.
    const d = lintErrorContractRecoveryUnforwarded(
      {
        handler: handlerOf(`(input, ctx) => { throw ctx.fail('no_match', 'x'); }`),
        errors: [
          {
            code: JsonRpcErrorCode.NotFound,
            reason: 'no_match',
            when: 'w',
            recovery: 'Broaden the query and search again.',
            thrownBy: 'service',
          },
        ],
      },
      'tool',
      'search_items',
    );

    expect(d).toHaveLength(1);
    expect(d[0]?.message).toContain("'no_match'");
  });
});
