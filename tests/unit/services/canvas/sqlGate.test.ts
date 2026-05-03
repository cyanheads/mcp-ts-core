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
  assertNoDeniedFunctions,
  assertPlanReadOnly,
  assertReadOnlyQuery,
  assertValidIdentifier,
  collectDisallowedOperators,
  collectPlanViolations,
  DENIED_TABLE_FUNCTIONS,
  quoteIdentifier,
} from '@/services/canvas/core/sqlGate.js';
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

describe('sqlGate · assertNoDeniedFunctions (issue #100)', () => {
  it.each([
    'read_json',
    'read_json_auto',
    'read_json_objects',
    'read_ndjson',
    'read_parquet',
    'parquet_scan',
    'parquet_metadata',
    'read_csv',
    'read_text',
    'read_blob',
    'glob',
    'iceberg_scan',
    'delta_scan',
    'postgres_scan',
    'sqlite_scan',
  ])('rejects %s function calls', (fn) => {
    let caught: unknown;
    try {
      assertNoDeniedFunctions(`SELECT * FROM ${fn}('/etc/passwd')`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data as { reason: string; function: string };
    expect(data.reason).toBe('denied_function');
    expect(data.function).toBe(fn);
  });

  it('matches case-insensitively', () => {
    expect(() => assertNoDeniedFunctions("SELECT * FROM Read_Json('/x')")).toThrow(
      /disallowed table function/,
    );
    expect(() => assertNoDeniedFunctions("SELECT * FROM READ_PARQUET('/x')")).toThrow(
      /disallowed table function/,
    );
  });

  it('tolerates whitespace between name and paren', () => {
    expect(() => assertNoDeniedFunctions("SELECT * FROM read_json   ('/x')")).toThrow(
      /disallowed table function/,
    );
    expect(() => assertNoDeniedFunctions("SELECT * FROM read_json\n('/x')")).toThrow(
      /disallowed table function/,
    );
  });

  it('blocks calls hidden behind block comments', () => {
    expect(() => assertNoDeniedFunctions("SELECT * FROM read_json /* hide */ ('/x')")).toThrow(
      /disallowed table function/,
    );
  });

  it('blocks calls preceded by line comments', () => {
    expect(() => assertNoDeniedFunctions("-- some comment\nSELECT * FROM read_json('/x')")).toThrow(
      /disallowed table function/,
    );
  });

  it('does not match the function name appearing only inside a string literal', () => {
    expect(() =>
      assertNoDeniedFunctions("SELECT 'read_json(/etc/passwd)' AS s FROM t"),
    ).not.toThrow();
  });

  it('does not match bare identifier mentions (no parens)', () => {
    expect(() => assertNoDeniedFunctions('SELECT read_json FROM t')).not.toThrow();
  });

  it('handles undefined / empty SQL gracefully', () => {
    expect(() => assertNoDeniedFunctions('')).not.toThrow();
    expect(() => assertNoDeniedFunctions(undefined as unknown as string)).not.toThrow();
  });
});

describe('sqlGate · plan-walk denied-function rescan (issue #100)', () => {
  it('rejects plans whose extra_info names a deny-listed function bare', () => {
    const plan = {
      name: 'PROJECTION',
      children: [
        {
          name: 'SEQ_SCAN',
          extra_info: 'Function: read_json\nFiles: [/etc/passwd]',
        },
      ],
    };
    let caught: unknown;
    try {
      assertPlanReadOnly(plan);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data as { reason: string; functions: string[] };
    expect(data.reason).toBe('denied_function_in_plan');
    expect(data.functions).toContain('read_json');
  });

  it('rejects plans whose function field names a deny-listed function', () => {
    const plan = {
      name: 'SEQ_SCAN',
      function: 'read_parquet',
    };
    expect(() => assertPlanReadOnly(plan)).toThrow(/disallowed table function in plan/);
  });

  it('rejects plans whose function call appears in non-metadata string fields', () => {
    const plan = {
      name: 'PROJECTION',
      // a non-metadata string field — uses call-shape regex
      description: "Computes read_json('/etc/passwd')",
    };
    expect(() => assertPlanReadOnly(plan)).toThrow(/disallowed table function in plan/);
  });

  it('does not false-positive on non-metadata string fields with bare function name', () => {
    const plan = {
      name: 'PROJECTION',
      // Bare 'read_json' in a non-metadata field — call-shape regex
      // won't match without parens, so this passes (defense is the SQL pre-scan).
      description: 'Bare mention: read_json',
      children: [{ name: 'SEQ_SCAN' }],
    };
    expect(() => assertPlanReadOnly(plan)).not.toThrow();
  });

  it('reports the denied-function violation before the operator violation', () => {
    const plan = {
      name: 'COPY_TO_FILE',
      extra_info: 'Function: read_json',
    };
    let caught: unknown;
    try {
      assertPlanReadOnly(plan);
    } catch (err) {
      caught = err;
    }
    expect((caught as McpError).data?.reason).toBe('denied_function_in_plan');
  });
});

describe('sqlGate · collectPlanViolations', () => {
  it('returns empty sets for a clean plan', () => {
    const result = collectPlanViolations(validSelectPlan);
    expect(result.offending.size).toBe(0);
    expect(result.deniedFunctions.size).toBe(0);
  });

  it('separately reports operator and function violations on the same plan', () => {
    const plan = {
      name: 'PROJECTION',
      children: [{ name: 'COPY_TO_FILE', extra_info: 'Function: read_json' }, { name: 'SEQ_SCAN' }],
    };
    const result = collectPlanViolations(plan);
    expect([...result.offending]).toEqual(['COPY_TO_FILE']);
    expect([...result.deniedFunctions]).toEqual(['read_json']);
  });
});

describe('sqlGate · DENIED_TABLE_FUNCTIONS', () => {
  it('contains the issue #100 functions', () => {
    expect(DENIED_TABLE_FUNCTIONS.has('read_json')).toBe(true);
    expect(DENIED_TABLE_FUNCTIONS.has('read_json_auto')).toBe(true);
    expect(DENIED_TABLE_FUNCTIONS.has('read_ndjson')).toBe(true);
    expect(DENIED_TABLE_FUNCTIONS.has('read_parquet')).toBe(true);
    expect(DENIED_TABLE_FUNCTIONS.has('parquet_scan')).toBe(true);
  });

  // Pre-staged hardening for issue #106 — block GDAL-backed file readers and
  // index-internals dumpers the moment anyone enables the spatial extension.
  it.each([
    'st_read',
    'st_drivers',
    'rtree_index_dump',
  ])('pre-stages spatial deny for %s (issue #106)', (fn) => {
    expect(DENIED_TABLE_FUNCTIONS.has(fn)).toBe(true);
    expect(() => assertNoDeniedFunctions(`SELECT * FROM ${fn}('/etc/passwd')`)).toThrow(
      /disallowed table function/i,
    );
  });

  it('matches ST_Read regardless of case (issue #106)', () => {
    expect(() => assertNoDeniedFunctions("SELECT * FROM ST_Read('/x.shp')")).toThrow(
      /disallowed table function/i,
    );
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

  // DuckDB v1.5.x stringifies operator names that the older long-form list
  // did not cover. Pinning each one here keeps the audit explicit if someone
  // later trims the allowlist.
  it.each([
    'TABLE_SCAN',
    'CTE_SCAN',
    'DELIM_SCAN',
    'POSITIONAL_SCAN',
    'REC_CTE_SCAN',
    'REC_REC_CTE_SCAN',
    'LEFT_DELIM_JOIN',
    'RIGHT_DELIM_JOIN',
    'STREAMING_WINDOW',
    'REC_CTE',
    'REC_KEY_CTE',
    'LIMITED_DISTINCT',
  ])('allowlist covers v1.5.x operator name: %s', (op) => {
    expect(ALLOWED_PLAN_OPERATORS.has(op)).toBe(true);
  });

  // Pre-staged hardening for the future spatial-extension opt-in (issue #106).
  // Dormant until the extension is loaded — the operator can't surface in a
  // plan without it.
  it('allowlist pre-stages RTREE_INDEX_SCAN for issue #106', () => {
    expect(ALLOWED_PLAN_OPERATORS.has('RTREE_INDEX_SCAN')).toBe(true);
  });

  it('plan operator allowlist explicitly excludes write/external operators', () => {
    expect(ALLOWED_PLAN_OPERATORS.has('INSERT')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('UPDATE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('DELETE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('MERGE_INTO')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('COPY_TO_FILE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('COPY_DATABASE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('READ_CSV')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('READ_PARQUET')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('PRAGMA')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('ATTACH')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('INOUT_FUNCTION')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('CREATE_TABLE_AS')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('CREATE_VIEW')).toBe(false);
  });
});
