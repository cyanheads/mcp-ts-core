/**
 * @fileoverview Tests for the canvas SQL gate. Validates the three layers of
 * enforcement (statement count, statement type, plan-walk allowlist) and the
 * identifier helpers. The gate itself is engine-agnostic — these tests use
 * hand-crafted plan JSON without invoking DuckDB.
 * @module tests/unit/canvas/sqlGate.test
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PLAN_OPERATORS,
  ALLOWED_STATEMENT_TYPES,
  assertReadOnlyQuery,
  assertValidIdentifier,
  collectDisallowedOperators,
  quoteIdentifier,
} from '@/canvas/core/sqlGate.js';
import { McpError } from '@/types-global/errors.js';

const validSelectPlan = {
  name: 'PROJECTION',
  children: [
    {
      name: 'FILTER',
      children: [{ name: 'SEQ_SCAN' }],
    },
  ],
};

describe('sqlGate · assertReadOnlyQuery', () => {
  it('accepts a SELECT with allowlisted plan operators', () => {
    expect(() =>
      assertReadOnlyQuery({
        statementCount: 1,
        statementType: 'SELECT',
        planJson: validSelectPlan,
      }),
    ).not.toThrow();
  });

  it('rejects multi-statement input', () => {
    expect(() =>
      assertReadOnlyQuery({
        statementCount: 2,
        statementType: 'SELECT',
        planJson: validSelectPlan,
      }),
    ).toThrow(/exactly one SQL statement/i);
  });

  it.each([
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'DROP',
    'ALTER',
    'COPY',
    'PRAGMA',
    'ATTACH',
    'DETACH',
    'LOAD',
    'EXECUTE',
    'SET',
    'VACUUM',
    'CALL',
    'MULTI',
    'UNKNOWN',
  ])('rejects non-SELECT statement type: %s', (statementType) => {
    expect(() =>
      assertReadOnlyQuery({
        statementCount: 1,
        statementType,
        planJson: validSelectPlan,
      }),
    ).toThrow(/Canvas query must be SELECT/);
  });

  it('rejects plans containing disallowed operators', () => {
    const plan = {
      name: 'PROJECTION',
      children: [{ name: 'COPY_TO_FILE' }, { name: 'INSERT' }],
    };
    let caught: unknown;
    try {
      assertReadOnlyQuery({
        statementCount: 1,
        statementType: 'SELECT',
        planJson: plan,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data;
    expect(data?.reason).toBe('plan_operator_not_allowed');
    expect(data?.operators).toEqual(['COPY_TO_FILE', 'INSERT']);
  });

  it('handles plans where operator is on `operator_type` instead of `name`', () => {
    const plan = {
      operator_type: 'projection',
      children: [{ operator_type: 'seq_scan' }],
    };
    expect(() =>
      assertReadOnlyQuery({
        statementCount: 1,
        statementType: 'SELECT',
        planJson: plan,
      }),
    ).not.toThrow();
  });
});

describe('sqlGate · collectDisallowedOperators', () => {
  it('returns empty set for a clean plan', () => {
    expect(collectDisallowedOperators(validSelectPlan).size).toBe(0);
  });

  it('walks nested children', () => {
    const plan = {
      name: 'PROJECTION',
      children: [
        {
          name: 'HASH_JOIN',
          children: [{ name: 'SEQ_SCAN' }, { name: 'INSERT' }],
        },
      ],
    };
    expect([...collectDisallowedOperators(plan)]).toEqual(['INSERT']);
  });

  it('walks `child` and `inputs` keys too', () => {
    const plan = {
      name: 'PROJECTION',
      child: { name: 'COPY_TO_FILE' },
      inputs: [{ name: 'PRAGMA' }],
    };
    expect([...collectDisallowedOperators(plan)].sort()).toEqual(['COPY_TO_FILE', 'PRAGMA']);
  });

  it('tolerates non-object/non-array nodes', () => {
    expect(() => collectDisallowedOperators(null)).not.toThrow();
    expect(() => collectDisallowedOperators('string')).not.toThrow();
    expect(() => collectDisallowedOperators(42)).not.toThrow();
  });
});

describe('sqlGate · assertValidIdentifier', () => {
  it('accepts standard SQL identifiers', () => {
    for (const name of ['users', 'germplasm', 'col_1', 'a1', '_underscore']) {
      expect(() => assertValidIdentifier(name, 'table')).not.toThrow();
    }
  });

  it('rejects empty strings', () => {
    expect(() => assertValidIdentifier('', 'table')).toThrow(/non-empty string/);
  });

  it.each([
    '1leading_digit',
    'has space',
    'has-dash',
    'has.dot',
    'has;semi',
    'a"b',
  ])('rejects non-identifier shape: %s', (name) => {
    expect(() => assertValidIdentifier(name, 'table')).toThrow(/invalid/i);
  });

  it('rejects reserved keywords', () => {
    expect(() => assertValidIdentifier('select', 'table')).toThrow(/reserved/i);
    expect(() => assertValidIdentifier('FROM', 'column')).toThrow(/reserved/i);
  });

  it('caps length at 63', () => {
    const atCap = 'a'.repeat(63);
    const overCap = 'a'.repeat(64);
    expect(() => assertValidIdentifier(atCap, 'table')).not.toThrow();
    expect(() => assertValidIdentifier(overCap, 'table')).toThrow(/invalid/i);
  });
});

describe('sqlGate · quoteIdentifier', () => {
  it('wraps in double quotes', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
  });

  it('escapes embedded double quotes by doubling', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });
});

describe('sqlGate · exported allowlists', () => {
  it('SELECT is the only allowed statement type', () => {
    expect([...ALLOWED_STATEMENT_TYPES]).toEqual(['SELECT']);
  });

  it('plan operator allowlist contains read-only families', () => {
    expect(ALLOWED_PLAN_OPERATORS.has('SEQ_SCAN')).toBe(true);
    expect(ALLOWED_PLAN_OPERATORS.has('PROJECTION')).toBe(true);
    expect(ALLOWED_PLAN_OPERATORS.has('HASH_JOIN')).toBe(true);
    expect(ALLOWED_PLAN_OPERATORS.has('LIMIT')).toBe(true);
    expect(ALLOWED_PLAN_OPERATORS.has('WINDOW')).toBe(true);
    expect(ALLOWED_PLAN_OPERATORS.has('UNNEST')).toBe(true);
  });

  it('plan operator allowlist explicitly excludes write/external operators', () => {
    expect(ALLOWED_PLAN_OPERATORS.has('INSERT')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('UPDATE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('DELETE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('COPY_TO_FILE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('READ_CSV')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('READ_PARQUET')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('PRAGMA')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('ATTACH')).toBe(false);
  });
});
