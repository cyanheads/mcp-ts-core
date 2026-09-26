/**
 * @fileoverview Tests for the handler-body heuristic lint rules.
 * @module tests/unit/linter/handler-body-rules.test
 */

import { describe, expect, it } from 'vitest';

import { lintHandlerBody } from '@/linter/rules/handler-body-rules.js';

function lint(handler: unknown) {
  return lintHandlerBody({ handler, name: 'test_tool' }, 'tool');
}

describe('prefer-mcp-error-in-handler', () => {
  it('flags plain throw new Error', () => {
    const handler = async () => {
      throw new Error('something failed');
    };
    const d = lint(handler);
    expect(d.map((x) => x.rule)).toContain('prefer-mcp-error-in-handler');
  });

  it('does not flag throw new McpError', () => {
    // Build a handler whose source contains the real `throw new McpError(...)`
    // pattern so we exercise the regex's discrimination, not just any non-Error throw.
    const handler = new Function(
      'return async () => { throw new McpError(JsonRpcErrorCode.NotFound, "x"); }',
    )();
    expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
  });

  it('does not flag throw new TypeError or other built-ins', () => {
    const handler = async () => {
      throw new TypeError('bad type');
    };
    expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
  });

  it('ignores throw new Error inside a string literal', () => {
    const handler = async () => {
      const message = 'never use throw new Error(...) here';
      return message;
    };
    expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
  });

  it('ignores throw new Error inside a comment', () => {
    const handler = async () => {
      // Don't do: throw new Error('x')
      return null;
    };
    expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
  });

  /**
   * Bun's runtime transpiler rewrites `new Error(…)` to `Error(…)` for every
   * built-in error constructor, so `handler.toString()` under Bun never carries
   * the `new`. Vitest's own transform keeps it, which is why these spellings are
   * built with `new Function` — the only way to hand the rule Bun's exact output.
   */
  describe("Bun's transpiled spellings (#465)", () => {
    it('flags throw Error(…) without new', () => {
      const handler = new Function('return async () => { throw Error("boom"); }')();
      expect(lint(handler).map((x) => x.rule)).toContain('prefer-mcp-error-in-handler');
    });

    it.each(['TypeError', 'RangeError'])(
      'does not flag throw %s(…) without new, as it does not flag the new form',
      (ctor) => {
        const handler = new Function(`return async () => { throw ${ctor}("x"); }`)();
        expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
      },
    );

    it('does not flag a user error class whose name ends in Error', () => {
      const handler = new Function('return async () => { throw McpError("x"); }')();
      expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
    });

    it('ignores throw Error(…) inside a string literal', () => {
      const handler = new Function(
        'return async () => { const m = "never throw Error(\\"x\\") here"; return m; }',
      )();
      expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
    });

    it('ignores throw Error(…) inside a comment', () => {
      const handler = new Function('return async () => { /* throw Error("x") */ return null; }')();
      expect(lint(handler).map((x) => x.rule)).not.toContain('prefer-mcp-error-in-handler');
    });
  });
});

describe('prefer-error-factory', () => {
  it('flags new McpError(JsonRpcErrorCode.NotFound, ...)', () => {
    // We can't actually call new McpError without importing it, so use a proxy
    // function whose toString contains the pattern.
    const handler = new Function(
      'return async () => { throw new McpError(JsonRpcErrorCode.NotFound, "x"); }',
    )();
    const d = lint(handler);
    const factory = d.find((x) => x.rule === 'prefer-error-factory');
    expect(factory).toBeDefined();
    expect(factory?.message).toContain('notFound');
  });

  it.each([
    ['ServiceUnavailable', 'serviceUnavailable'],
    ['SerializationError', 'serializationError'],
  ])('flags %s → %s', (code, factory) => {
    const handler = new Function(
      `return async () => { throw new McpError(JsonRpcErrorCode.${code}, "x"); }`,
    )();
    const d = lint(handler);
    expect(d.find((x) => x.rule === 'prefer-error-factory')?.message).toContain(factory);
  });
});

describe('preserve-cause-on-rethrow', () => {
  it('flags catch+throw McpError without cause', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (error) { throw new McpError(JsonRpcErrorCode.InvalidParams, 'bad', { x: 1 }); }
      }`,
    )();
    const d = lint(handler);
    expect(d.map((x) => x.rule)).toContain('preserve-cause-on-rethrow');
  });

  it('does not flag when cause is preserved via 4th arg', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (error) { throw new McpError(JsonRpcErrorCode.InvalidParams, 'bad', {}, { cause: error }); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).not.toContain('preserve-cause-on-rethrow');
  });

  it('does not flag bare re-throw', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (error) { throw error; }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).not.toContain('preserve-cause-on-rethrow');
  });

  it('does not flag factory call with cause option', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (error) { throw notFound('missing', {}, { cause: error }); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).not.toContain('preserve-cause-on-rethrow');
  });

  it('flags factory call without cause', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (error) { throw serviceUnavailable('upstream down'); }
      }`,
    )();
    const d = lint(handler);
    expect(d.map((x) => x.rule)).toContain('preserve-cause-on-rethrow');
  });

  it('does not flag { cause: cause } when the catch binding is named cause', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (cause) { throw notFound('x', undefined, { cause: cause }); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).not.toContain('preserve-cause-on-rethrow');
  });

  /** Bun prints `{ cause: cause }` as `{ cause }`, and authors write the shorthand too. */
  it('does not flag the { cause } shorthand when the catch binding is named cause (#465)', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (cause) { throw notFound("x", void 0, { cause }); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).not.toContain('preserve-cause-on-rethrow');
  });

  it('still flags the { cause } shorthand when it names something other than the catch binding', () => {
    const handler = new Function(
      `return async () => {
        const cause = new Error('unrelated');
        try { return 1; }
        catch (e) { throw notFound('x', undefined, { cause }); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).toContain('preserve-cause-on-rethrow');
  });

  it('flags a catch (e) that throws a factory with no options at all', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (e) { throw notFound('x'); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).toContain('preserve-cause-on-rethrow');
  });

  it('does not treat a longer identifier starting with cause as the shorthand', () => {
    const handler = new Function(
      `return async () => {
        try { return 1; }
        catch (cause) { throw notFound('x', undefined, { causeChain }); }
      }`,
    )();
    expect(lint(handler).map((x) => x.rule)).toContain('preserve-cause-on-rethrow');
  });
});

describe('no-stringify-upstream-error', () => {
  it('flags JSON.stringify inside throw expression', () => {
    const source = [
      'return async () => {',
      '  const e = { x: 1 };',
      '  throw new Error(`bad: ' + '$' + '{JSON.stringify(e)}`);',
      '}',
    ].join('\n');
    const handler = new Function(source)();
    const d = lint(handler);
    expect(d.map((x) => x.rule)).toContain('no-stringify-upstream-error');
  });

  it('does not flag JSON.stringify outside a throw', () => {
    const handler = async (input: { x: unknown }) => ({ result: JSON.stringify(input.x) });
    expect(lint(handler).map((x) => x.rule)).not.toContain('no-stringify-upstream-error');
  });
});

describe('lintHandlerBody — edge cases', () => {
  it('returns no diagnostics when handler is missing', () => {
    expect(lintHandlerBody({ name: 'x' }, 'tool')).toEqual([]);
  });

  it('returns no diagnostics for a clean handler', () => {
    const handler = async (input: { x: number }) => ({ doubled: input.x * 2 });
    expect(lint(handler)).toEqual([]);
  });

  it('uses <unnamed> when name is missing', () => {
    const handler = async () => {
      throw new Error('x');
    };
    const d = lintHandlerBody({ handler }, 'tool');
    expect(d[0]?.definitionName).toBe('<unnamed>');
  });

  it('respects definitionType in messages', () => {
    const handler = async () => {
      throw new Error('x');
    };
    const d = lintHandlerBody({ handler, name: 'r' }, 'resource');
    expect(d[0]?.message).toContain('resource');
  });
});

describe('malformed def entries', () => {
  it('returns [] instead of throwing on a null/undefined def', () => {
    expect(() => lintHandlerBody(null, 'tool')).not.toThrow();
    expect(lintHandlerBody(null, 'tool')).toEqual([]);
    expect(lintHandlerBody(undefined, 'tool')).toEqual([]);
  });
});
