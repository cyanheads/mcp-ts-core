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
  assertNoSystemCatalogs,
  assertPlanReadOnly,
  assertReadOnlyQuery,
  assertSelectOnly,
  assertValidIdentifier,
  collectDisallowedOperators,
  collectPlanViolations,
  DENIED_TABLE_FUNCTIONS,
  quoteIdentifier,
  SQL_GATE_REASONS,
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

describe('sqlGate · pragma_* deny-list (issue #210)', () => {
  it.each([
    'pragma_table_info',
    'pragma_database_list',
    'pragma_storage_info',
    'pragma_table_structure',
    'pragma_version',
    'pragma_user_agent',
    'pragma_some_future_function',
  ])('assertNoDeniedFunctions rejects %s call', (fn) => {
    let caught: unknown;
    try {
      assertNoDeniedFunctions(`SELECT * FROM ${fn}('t')`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data as { reason: string; function: string };
    expect(data.reason).toBe('denied_function');
    expect(data.function).toBe(fn);
  });

  it('assertNoDeniedFunctions rejects pragma_* calls case-insensitively', () => {
    expect(() => assertNoDeniedFunctions("SELECT * FROM PRAGMA_TABLE_INFO('t')")).toThrow(
      /disallowed table function/i,
    );
  });

  it('plan-walk rejects pragma_table_info in function metadata field', () => {
    const plan = {
      name: 'SEQ_SCAN',
      function_name: 'pragma_table_info',
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
    expect(data.functions).toContain('pragma_table_info');
  });

  it('plan-walk rejects pragma_database_list in extra_info field', () => {
    const plan = {
      name: 'PROJECTION',
      children: [
        {
          name: 'SEQ_SCAN',
          extra_info: 'Function: pragma_database_list',
        },
      ],
    };
    expect(() => assertPlanReadOnly(plan)).toThrow(/disallowed table function in plan/);
  });

  it('assertNoDeniedFunctions does not false-positive on pragma_ in a string literal', () => {
    expect(() => assertNoDeniedFunctions("SELECT 'pragma_table_info' AS s FROM t")).not.toThrow();
  });
});

// Issue #224 — opt-in system-catalog denial
describe('sqlGate · assertNoSystemCatalogs (issue #224)', () => {
  it('rejects information_schema reference', () => {
    let caught: unknown;
    try {
      assertNoSystemCatalogs('SELECT * FROM information_schema.tables');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data as { reason: string; catalog: string };
    expect(data.reason).toBe('system_catalog_access');
    expect(data.catalog).toContain('information_schema');
  });

  it('rejects pg_catalog reference', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM pg_catalog.pg_tables')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects sqlite_master reference', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM sqlite_master')).toThrow(/system catalog/i);
  });

  it('rejects duckdb_tables() call', () => {
    let caught: unknown;
    try {
      assertNoSystemCatalogs('SELECT * FROM duckdb_tables()');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = (caught as McpError).data as { reason: string };
    expect(data.reason).toBe('system_catalog_access');
  });

  it('rejects duckdb_columns() call', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM duckdb_columns()')).toThrow(
      /system catalog/i,
    );
  });

  it('does not reject catalog name appearing only in a string literal', () => {
    expect(() => assertNoSystemCatalogs("SELECT 'information_schema' AS s FROM t")).not.toThrow();
  });

  it('does not reject clean SELECT against a user table', () => {
    expect(() =>
      assertNoSystemCatalogs('SELECT id, name FROM germplasm WHERE id = 1'),
    ).not.toThrow();
  });

  it('handles empty / undefined SQL gracefully', () => {
    expect(() => assertNoSystemCatalogs('')).not.toThrow();
    expect(() => assertNoSystemCatalogs(undefined as unknown as string)).not.toThrow();
  });
});

describe('sqlGate · exported allowlists', () => {
  it('SELECT is the only allowed statement type', () => {
    expect([...ALLOWED_STATEMENT_TYPES]).toEqual(['SELECT']);
  });

  // Issue #236 — invalid_sql classifies SELECT-shaped statements that fail to
  // prepare (bad column/function), kept distinct from non_select_statement.
  it('SQL_GATE_REASONS includes invalid_sql distinct from non_select_statement', () => {
    expect(SQL_GATE_REASONS.invalidSql).toBe('invalid_sql');
    expect(SQL_GATE_REASONS.nonSelectStatement).toBe('non_select_statement');
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

describe('sqlGate · readOperatorName key fallback (name/operator_type/operator/type)', () => {
  it('reads operator identity from the `operator` key', () => {
    const plan = { operator: 'PROJECTION', children: [{ operator: 'SEQ_SCAN' }] };
    expect(() => assertPlanReadOnly(plan)).not.toThrow();
  });

  it('reads operator identity from the `type` key', () => {
    const plan = { type: 'PROJECTION', children: [{ type: 'SEQ_SCAN' }] };
    expect(() => assertPlanReadOnly(plan)).not.toThrow();
  });

  it('rejects a disallowed operator reported only via the `operator` key', () => {
    const plan = { operator: 'PROJECTION', children: [{ operator: 'INSERT' }] };
    expect(() => assertPlanReadOnly(plan)).toThrow(/disallowed operators/);
  });

  it('rejects a disallowed operator reported only via the `type` key', () => {
    const plan = { type: 'PROJECTION', children: [{ type: 'COPY_TO_FILE' }] };
    expect(() => assertPlanReadOnly(plan)).toThrow(/disallowed operators/);
  });

  it('skips an empty-string `name` and falls through to `operator_type`', () => {
    const plan = {
      name: '',
      operator_type: 'PROJECTION',
      children: [{ name: '', operator_type: 'SEQ_SCAN' }],
    };
    expect(() => assertPlanReadOnly(plan)).not.toThrow();
  });
});

describe('sqlGate · collectPlanViolations multi-function detection', () => {
  it('collects distinct denied functions surfaced under different metadata keys', () => {
    const plan = {
      name: 'PROJECTION',
      children: [
        { name: 'SEQ_SCAN', function: 'read_parquet' },
        { name: 'SEQ_SCAN', extra_info: 'Function: read_json\nFiles: [/x]' },
      ],
    };
    const result = collectPlanViolations(plan);
    expect([...result.deniedFunctions].sort()).toEqual(['read_json', 'read_parquet']);
    expect(result.offending.size).toBe(0); // SEQ_SCAN itself is allowlisted
  });

  it('dedupes the same denied function appearing more than once', () => {
    const plan = {
      name: 'PROJECTION',
      children: [
        { name: 'SEQ_SCAN', function: 'read_parquet' },
        { name: 'SEQ_SCAN', function_name: 'read_parquet' },
      ],
    };
    const result = collectPlanViolations(plan);
    expect([...result.deniedFunctions]).toEqual(['read_parquet']);
  });

  it('reports multiple denied functions sorted alphabetically on the thrown error', () => {
    const plan = {
      name: 'SEQ_SCAN',
      extra_info: 'Function: read_parquet',
      children: [{ name: 'SEQ_SCAN', function: 'read_json' }],
    };
    let caught: unknown;
    try {
      assertPlanReadOnly(plan);
    } catch (err) {
      caught = err;
    }
    const data = (caught as McpError).data as { functions: string[] };
    expect(data.functions).toEqual(['read_json', 'read_parquet']);
  });
});

describe('sqlGate · FUNCTION_METADATA_KEYS coverage (table_function, source)', () => {
  it('rejects a denied function named in the `table_function` field', () => {
    const plan = { name: 'SEQ_SCAN', table_function: 'read_csv' };
    let caught: unknown;
    try {
      assertPlanReadOnly(plan);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).data?.functions).toContain('read_csv');
  });

  it('rejects a denied function named in the `source` field', () => {
    const plan = { name: 'SEQ_SCAN', source: 'read_ndjson' };
    let caught: unknown;
    try {
      assertPlanReadOnly(plan);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).data?.functions).toContain('read_ndjson');
  });

  it('tolerates non-string metadata field values without crashing', () => {
    const plan = {
      name: 'SEQ_SCAN',
      extra_info: 12345,
      function: null,
      children: [{ name: 'PROJECTION' }],
    };
    expect(() => collectPlanViolations(plan)).not.toThrow();
  });
});

describe('sqlGate · assertNoSystemCatalogs case/whitespace tolerance', () => {
  it('rejects uppercase INFORMATION_SCHEMA', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM INFORMATION_SCHEMA.TABLES')).toThrow(
      /system catalog/i,
    );
  });

  it('rejects mixed-case duckdb_tables() with whitespace before the paren', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM DuckDB_Tables ()')).toThrow(
      /system catalog/i,
    );
  });
});

describe('sqlGate · assertReadOnlyQuery tolerates degenerate planJson', () => {
  it('does not throw for a null planJson (no operators to violate)', () => {
    expect(() =>
      assertReadOnlyQuery({ statementCount: 1, statementType: 'SELECT', planJson: null }),
    ).not.toThrow();
  });

  it('does not throw for a scalar (non-object) planJson', () => {
    expect(() =>
      assertReadOnlyQuery({ statementCount: 1, statementType: 'SELECT', planJson: 'not-a-plan' }),
    ).not.toThrow();
  });
});

describe('sqlGate · layer ordering (multi-statement / statement-type beat the plan-walk)', () => {
  it('rejects on the multi-statement layer even when the plan would also fail', () => {
    const badPlan = { name: 'INSERT' };
    expect(() =>
      assertReadOnlyQuery({ statementCount: 2, statementType: 'SELECT', planJson: badPlan }),
    ).toThrow(/exactly one SQL statement/i);
  });

  it('rejects on the statement-type layer even when the plan would also fail', () => {
    const badPlan = { name: 'INSERT' };
    expect(() =>
      assertReadOnlyQuery({ statementCount: 1, statementType: 'INSERT', planJson: badPlan }),
    ).toThrow(/Canvas query must be SELECT/);
  });
});

describe('sqlGate · assertValidIdentifier defensive runtime-type checks', () => {
  it('rejects non-string values at runtime, bypassing TS static types', () => {
    expect(() => assertValidIdentifier(undefined as unknown as string, 'table')).toThrow(
      /non-empty string/,
    );
    expect(() => assertValidIdentifier(123 as unknown as string, 'column')).toThrow(
      /non-empty string/,
    );
  });
});

describe('sqlGate · quoteIdentifier with multiple embedded quotes', () => {
  it('escapes every embedded quote, not just the first', () => {
    expect(quoteIdentifier('a"b"c')).toBe('"a""b""c"');
  });
});

describe('sqlGate · statement-type matching is exact-case', () => {
  it('rejects lowercase "select" — only the exact uppercase form is allowed', () => {
    expect(() => assertSelectOnly({ statementCount: 1, statementType: 'select' })).toThrow(
      /Canvas query must be SELECT/,
    );
  });
});

describe('sqlGate · assertNoDeniedFunctions reports the first match by position', () => {
  it('reports the first denied function when the SQL references two', () => {
    let caught: unknown;
    try {
      assertNoDeniedFunctions("SELECT * FROM read_csv('/a') JOIN read_json('/b') ON true");
    } catch (err) {
      caught = err;
    }
    const data = (caught as McpError).data as { function: string };
    expect(data.function).toBe('read_csv');
  });
});
