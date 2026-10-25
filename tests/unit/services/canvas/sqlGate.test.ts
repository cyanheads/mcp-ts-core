/**
 * @fileoverview Tests for the canvas SQL gate. Validates its layers of
 * enforcement (function deny-lists, statement count, statement type, parse-tree
 * function check, plan-walk allowlist) and the identifier helpers. The gate
 * itself is engine-agnostic — these tests use hand-crafted parse-tree and plan
 * JSON without invoking DuckDB.
 * @module tests/unit/canvas/sqlGate.test
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PLAN_OPERATORS,
  ALLOWED_STATEMENT_TYPES,
  assertNoDeniedFunctions,
  assertNoDeniedParsedFunctions,
  assertNoSystemCatalogs,
  assertPlanReadOnly,
  assertQueryNesting,
  assertReadOnlyQuery,
  assertSelectOnly,
  assertValidIdentifier,
  BARE_FUNCTION_KEYWORDS,
  collectDisallowedOperators,
  collectPlanViolations,
  DENIED_BARE_KEYWORDS,
  DENIED_PARSED_FUNCTIONS,
  DENIED_TABLE_FUNCTIONS,
  findFileReference,
  MAX_QUERY_NESTING,
  quoteIdentifier,
  SQL_GATE_REASONS,
  type SqlGateReason,
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

  it.each(['1leading_digit', 'has space', 'has-dash', 'has.dot', 'has;semi', 'a"b'])(
    'rejects non-identifier shape: %s',
    (name) => {
      expect(() => assertValidIdentifier(name, 'table')).toThrow(/invalid/i);
    },
  );

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
  // Pre-staged hardening for issue #106 — block GDAL-backed file readers and
  // index-internals dumpers the moment anyone enables the spatial extension.
  it.each(['st_read', 'st_drivers', 'rtree_index_dump'])(
    'pre-stages spatial deny for %s (issue #106)',
    (fn) => {
      expect(DENIED_TABLE_FUNCTIONS.has(fn)).toBe(true);
      expect(() => assertNoDeniedFunctions(`SELECT * FROM ${fn}('/etc/passwd')`)).toThrow(
        /disallowed table function/i,
      );
    },
  );

  // File-reading table functions DuckDB v1.5.6 lists in duckdb_functions().
  it.each(['read_duckdb', 'parquet_bloom_probe', 'parquet_full_metadata'])(
    'denies the v1.5.6 file reader %s by name',
    (fn) => {
      expect(DENIED_TABLE_FUNCTIONS.has(fn)).toBe(true);
      expect(() => assertNoDeniedFunctions(`SELECT * FROM ${fn}('/etc/passwd')`)).toThrow(
        /disallowed table function/i,
      );
    },
  );

  // File-reading table functions new in DuckDB v2.0.0's duckdb_functions().
  it.each(['read_single_csv_file', 'read_single_json_file', 'read_single_parquet_file'])(
    'denies the v2.0.0 file reader %s by name',
    (fn) => {
      expect(DENIED_TABLE_FUNCTIONS.has(fn)).toBe(true);
      expect(() => assertNoDeniedFunctions(`SELECT * FROM ${fn}('/etc/passwd')`)).toThrow(
        /disallowed table function/i,
      );
      expect(ALLOWED_PLAN_OPERATORS.has(fn.toUpperCase())).toBe(false);
    },
  );
});

/**
 * Parse-tree fixtures in the shape `json_serialize_sql` emits on DuckDB
 * v1.5.6: a function call is an object with `class: 'FUNCTION'` and a
 * lowercased `function_name`; a table function wraps one under `function`.
 */
const constant = (value: string) => ({
  class: 'CONSTANT',
  type: 'VALUE_CONSTANT',
  alias: '',
  value: { type: { id: 'VARCHAR', type_info: null }, is_null: false, value },
});
const columnRef = (name: string) => ({
  class: 'COLUMN_REF',
  type: 'COLUMN_REF',
  alias: '',
  column_names: [name],
});
const call = (name: string, ...children: unknown[]) => ({
  class: 'FUNCTION',
  type: 'FUNCTION',
  function_name: name,
  schema: '',
  catalog: '',
  children,
});
const selectNode = (selectList: unknown[], fromTable: unknown = { type: 'EMPTY' }) => ({
  type: 'SELECT_NODE',
  select_list: selectList,
  from_table: fromTable,
  where_clause: null,
});
const parseTree = (node: unknown) => ({ error: false, statements: [{ node }] });

describe('sqlGate · assertNoDeniedParsedFunctions', () => {
  it.each([...DENIED_PARSED_FUNCTIONS])('refuses %s as denied_function', (fn) => {
    const err = gateRejection(() =>
      assertNoDeniedParsedFunctions(parseTree(selectNode([call(fn, columnRef('x'))]))),
    );
    expect(err.data?.reason).toBe('denied_function');
    expect(err.data?.function).toBe(fn);
    expect(err.message).toBe(
      `Canvas query references disallowed function: ${fn}. Functions that read engine settings, change engine state, or run SQL or name a table from a string, are not permitted.`,
    );
  });

  it('covers every scalar that reads a setting, the string-named runners, and the external-resource functions', () => {
    expect([...DENIED_PARSED_FUNCTIONS].sort()).toEqual([
      'create_external_resource',
      'current_schema',
      'current_schemas',
      'current_setting',
      'deregister_external_resource',
      'destroy_external_resource',
      'in_search_path',
      'index_key',
      'query',
      'query_table',
      'register_external_resource',
      'register_external_resource_type',
    ]);
  });

  it.each([...DENIED_TABLE_FUNCTIONS])(
    'refuses the file reader %s by name, as the text scan does',
    (fn) => {
      const tree = parseTree(
        selectNode([{ class: 'STAR', type: 'STAR' }], {
          type: 'TABLE_FUNCTION',
          function: call(fn, constant('/x')),
        }),
      );
      const err = gateRejection(() => assertNoDeniedParsedFunctions(tree));
      expect(err.data?.reason).toBe('denied_function');
      expect(err.data?.function).toBe(fn);
      expect(err.message).toBe(
        `Canvas query references disallowed table function: ${fn}. File-reading and external-data functions are not permitted.`,
      );
    },
  );

  it('finds a call nested in a subquery inside a join, inside another call', () => {
    const tree = parseTree(
      selectNode([{ class: 'STAR', type: 'STAR' }], {
        type: 'JOIN',
        left: { type: 'BASE_TABLE', table_name: 't' },
        right: {
          type: 'SUBQUERY',
          subquery: {
            node: selectNode([
              call('upper', call('lower', call('current_setting', constant('x')))),
            ]),
          },
        },
      }),
    );
    expect(gateRejection(() => assertNoDeniedParsedFunctions(tree)).data?.function).toBe(
      'current_setting',
    );
  });

  it('finds query() as a table function in FROM', () => {
    const tree = parseTree(
      selectNode([{ class: 'STAR', type: 'STAR' }], {
        type: 'TABLE_FUNCTION',
        function: call('query', call('concat', constant('SELECT 1'), constant(''))),
      }),
    );
    expect(gateRejection(() => assertNoDeniedParsedFunctions(tree)).data?.function).toBe('query');
  });

  it('matches the function name case-insensitively', () => {
    const tree = parseTree(selectNode([call('CURRENT_SETTING', constant('x'))]));
    expect(gateRejection(() => assertNoDeniedParsedFunctions(tree)).data?.function).toBe(
      'current_setting',
    );
  });

  it('passes a tree that names the function only as data or as a column', () => {
    const tree = parseTree(
      selectNode([
        constant('current_setting(temp_directory)'),
        { class: 'COLUMN_REF', type: 'COLUMN_REF', column_names: ['query'] },
        call('upper', constant('query(SELECT 1)')),
        { class: 'FUNCTION', function_name: 42 },
      ]),
    );
    expect(() => assertNoDeniedParsedFunctions(tree)).not.toThrow();
  });

  it('passes a tree of allowed calls, and tolerates degenerate input', () => {
    expect(() =>
      assertNoDeniedParsedFunctions(parseTree(selectNode([call('sum', constant('1'))]))),
    ).not.toThrow();
    expect(() => assertNoDeniedParsedFunctions(null)).not.toThrow();
    expect(() => assertNoDeniedParsedFunctions('not-a-tree')).not.toThrow();
  });
});

describe('sqlGate · assertNoDeniedParsedFunctions · bare function keywords', () => {
  const baseTable = (table_name: string) => ({ type: 'BASE_TABLE', table_name });
  const qualifiedRef = (...parts: string[]) => ({
    class: 'COLUMN_REF',
    type: 'COLUMN_REF',
    alias: '',
    column_names: parts,
  });

  it('names current_schema as the one denied function DuckDB binds bare', () => {
    expect([...DENIED_BARE_KEYWORDS]).toEqual(['current_schema']);
    for (const name of DENIED_BARE_KEYWORDS) expect(DENIED_PARSED_FUNCTIONS.has(name)).toBe(true);
  });

  it('lists the names DuckDB v1.5.6 and v2.0.0 bind without parentheses', () => {
    expect([...BARE_FUNCTION_KEYWORDS].sort()).toEqual([
      'current_catalog',
      'current_date',
      'current_role',
      'current_schema',
      'current_time',
      'current_timestamp',
      'current_user',
      'localtime',
      'localtimestamp',
      'session_user',
      'user',
    ]);
  });

  it.each([
    ['lowercase', 'current_schema'],
    ['quoted uppercase', 'CURRENT_SCHEMA'],
    ['mixed case', 'Current_Schema'],
  ])(
    'refuses an unqualified %s current_schema, telling the caller to qualify a column',
    (_label, name) => {
      const err = gateRejection(() =>
        assertNoDeniedParsedFunctions(parseTree(selectNode([columnRef(name)]))),
      );
      expect(err.data?.reason).toBe('denied_function');
      expect(err.data?.function).toBe('current_schema');
      expect(err.message).toBe(
        'Canvas query references disallowed function: current_schema. DuckDB reads an unqualified current_schema as that function, written without parentheses; to read a staged column named current_schema, qualify it with its table (<table>.current_schema).',
      );
      expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
        'Remove the function the message names — only the staged tables are queryable.',
      );
    },
  );

  it('finds a bare current_schema in a WHERE comparison under an operator', () => {
    const tree = parseTree({
      ...selectNode([columnRef('x')], baseTable('t')),
      where_clause: {
        class: 'COMPARISON',
        type: 'COMPARE_EQUAL',
        left: { class: 'OPERATOR', type: 'ARRAY_EXTRACT', children: [columnRef('current_schema')] },
        right: constant('main'),
      },
    });
    expect(gateRejection(() => assertNoDeniedParsedFunctions(tree)).data?.function).toBe(
      'current_schema',
    );
  });

  it('passes current_schema qualified with its table, and as data or an alias', () => {
    const tree = parseTree(
      selectNode(
        [
          qualifiedRef('c', 'current_schema'),
          qualifiedRef('main', 'c', 'current_schema'),
          constant('current_schema'),
          { ...columnRef('x'), alias: 'current_schema' },
        ],
        baseTable('c'),
      ),
    );
    expect(() => assertNoDeniedParsedFunctions(tree)).not.toThrow();
  });

  it('passes unqualified columns named after other denied functions and other bare keywords', () => {
    const names = [
      ...[...DENIED_PARSED_FUNCTIONS].filter((fn) => fn !== 'current_schema'),
      ...[...BARE_FUNCTION_KEYWORDS].filter((name) => name !== 'current_schema'),
    ];
    const tree = parseTree(selectNode(names.map(columnRef), baseTable('q')));
    expect(() => assertNoDeniedParsedFunctions(tree)).not.toThrow();
  });
});

/** `query(...)` as a FROM-clause table function, the way DuckDB v1.5.6 serializes it. */
const queryFrom = (...args: unknown[]) =>
  parseTree(
    selectNode([{ class: 'STAR', type: 'STAR' }], {
      type: 'TABLE_FUNCTION',
      function: call('query', ...args),
    }),
  );

describe('sqlGate · assertNoDeniedParsedFunctions · query() over a string literal', () => {
  it('admits query() over one plain string literal and returns the literal', () => {
    expect(assertNoDeniedParsedFunctions(queryFrom(constant('SELECT x FROM t')))).toEqual([
      'SELECT x FROM t',
    ]);
  });

  it('returns every admitted literal, in walk order, wherever the calls sit', () => {
    const tree = parseTree(
      selectNode([{ class: 'STAR', type: 'STAR' }], {
        type: 'JOIN',
        left: { type: 'TABLE_FUNCTION', function: call('QUERY', constant('SELECT 1')) },
        right: {
          type: 'SUBQUERY',
          subquery: {
            node: selectNode([{ class: 'STAR', type: 'STAR' }], {
              type: 'TABLE_FUNCTION',
              function: call('query', constant("SELECT 'it''s'")),
            }),
          },
        },
      }),
    );
    expect(assertNoDeniedParsedFunctions(tree)).toEqual(['SELECT 1', "SELECT 'it''s'"]);
  });

  it('returns no literals for a tree without query()', () => {
    expect(
      assertNoDeniedParsedFunctions(parseTree(selectNode([call('sum', constant('1'))]))),
    ).toEqual([]);
  });

  it('still refuses a denied call elsewhere in a tree that holds an admitted query()', () => {
    const tree = parseTree(
      selectNode([call('current_setting', constant('x'))], {
        type: 'TABLE_FUNCTION',
        function: call('query', constant('SELECT 1')),
      }),
    );
    expect(gateRejection(() => assertNoDeniedParsedFunctions(tree)).data?.function).toBe(
      'current_setting',
    );
  });

  const typedConstant = (id: string, value: unknown, isNull = false) => ({
    class: 'CONSTANT',
    type: 'VALUE_CONSTANT',
    alias: '',
    value: { type: { id, type_info: null }, is_null: isNull, value },
  });

  it.each([
    ['a concatenation', [call('concat', constant('SELECT current_'), constant('setting(1)'))]],
    [
      'the || operator',
      [
        {
          class: 'FUNCTION',
          type: 'FUNCTION',
          alias: '',
          function_name: '||',
          children: [constant('a'), constant('b')],
        },
      ],
    ],
    [
      'a cast literal',
      [{ class: 'CAST', type: 'OPERATOR_CAST', alias: '', child: constant('SELECT 1') }],
    ],
    ['a column reference', [columnRef('sql_text')]],
    ['a parameter', [{ class: 'PARAMETER', type: 'VALUE_PARAMETER', alias: '', identifier: '1' }]],
    [
      'a collated literal',
      [{ class: 'COLLATE', type: 'COLLATE', alias: '', child: constant('SELECT 1') }],
    ],
    ['a named argument', [{ ...constant('SELECT 1'), alias: 'sql' }]],
    ['an integer constant', [typedConstant('INTEGER', 1)]],
    ['a NULL constant', [typedConstant('NULL', undefined, true)]],
    ['a constant missing its alias field', [{ ...constant('SELECT 1'), alias: undefined }]],
    ['two literals', [constant('SELECT 1'), constant('SELECT 2')]],
    ['no argument', []],
  ])('refuses query() over %s with the existing message and hint', (_label, args) => {
    const err = gateRejection(() => assertNoDeniedParsedFunctions(queryFrom(...args)));
    expect(err.data?.reason).toBe('denied_function');
    expect(err.data?.function).toBe('query');
    expect(err.message).toBe(
      'Canvas query references disallowed function: query. Functions that read engine settings, change engine state, or run SQL or name a table from a string, are not permitted.',
    );
    expect((err.data?.recovery as { hint?: string } | undefined)?.hint).toBe(
      'Remove the function the message names — only the staged tables are queryable.',
    );
  });

  /**
   * `query(...)` as DuckDB v2.0.0 serializes it: each argument under
   * `arguments[]` as `{ name, expression }`, a constant carrying
   * `literal: { kind, text }` instead of `value`.
   */
  const literal = (kind: string, text: string) => ({
    class: 'CONSTANT',
    type: 'VALUE_CONSTANT',
    alias: '',
    literal: { kind, text },
  });
  const argument = (expression: unknown, name = '') => ({ name, expression });
  const v2QueryFrom = (...args: unknown[]) =>
    parseTree(
      selectNode([{ class: 'STAR', type: 'STAR' }], {
        type: 'TABLE_FUNCTION',
        function: {
          class: 'FUNCTION',
          type: 'FUNCTION',
          function_name: 'query',
          schema: '',
          catalog: '',
          arguments: args,
          qualified_name: { path: ['query'] },
        },
      }),
    );

  it('admits query() over one plain string literal in the v2.0.0 argument shape', () => {
    expect(
      assertNoDeniedParsedFunctions(v2QueryFrom(argument(literal('STRING', 'SELECT x FROM t')))),
    ).toEqual(['SELECT x FROM t']);
  });

  it.each([
    ['a NULL literal', [argument(literal('NULL_LITERAL', ''))]],
    ['an integer literal', [argument(literal('INTEGER', '1'))]],
    ['a named argument', [argument({ ...literal('STRING', 'SELECT 1'), alias: 'sql' }, 'sql')]],
    [
      'a cast literal',
      [
        argument({
          class: 'CAST',
          type: 'OPERATOR_CAST',
          alias: '',
          child: literal('STRING', 'x'),
        }),
      ],
    ],
    [
      'two literals',
      [argument(literal('STRING', 'SELECT 1')), argument(literal('STRING', 'SELECT 2'))],
    ],
    ['no argument', []],
  ])('refuses query() over %s in the v2.0.0 argument shape', (_label, args) => {
    const err = gateRejection(() => assertNoDeniedParsedFunctions(v2QueryFrom(...args)));
    expect(err.data?.reason).toBe('denied_function');
    expect(err.data?.function).toBe('query');
  });

  it('refuses query_table() over a plain string literal', () => {
    const tree = parseTree(
      selectNode([{ class: 'STAR', type: 'STAR' }], {
        type: 'TABLE_FUNCTION',
        function: call('query_table', constant('t')),
      }),
    );
    expect(gateRejection(() => assertNoDeniedParsedFunctions(tree)).data?.function).toBe(
      'query_table',
    );
  });
});

describe('sqlGate · assertQueryNesting', () => {
  it('caps query() nesting at four levels', () => {
    expect(MAX_QUERY_NESTING).toBe(4);
  });

  it.each([1, 2, 3, 4])('admits a literal %i levels deep', (depth) => {
    expect(() => assertQueryNesting(depth)).not.toThrow();
  });

  it.each([5, 6, 50])('refuses a literal %i levels deep as denied_function', (depth) => {
    const err = gateRejection(() => assertQueryNesting(depth));
    expect(err.data?.reason).toBe('denied_function');
    expect(err.data?.function).toBe('query');
    expect(err.message).toBe('Canvas query nests query() more than 4 levels deep.');
  });
});

/** A `BASE_TABLE` reference as `json_serialize_sql` emits it on DuckDB v1.5.6. */
const tableRef = (table_name: string, schema_name = '', catalog_name = '') => ({
  type: 'BASE_TABLE',
  alias: '',
  schema_name,
  table_name,
  catalog_name,
});

describe('sqlGate · findFileReference', () => {
  it.each([
    ['a quoted path', tableRef('/srv/exports/a.csv'), '/srv/exports/a.csv'],
    ['a bare file name', tableRef('a.parquet'), 'a.parquet'],
    ['a path split into a schema and a table', tableRef('csv', 'a'), 'a.csv'],
    ['an unknown catalog', tableRef('t', 'main', 'other'), 'other.main.t'],
    ['a dotted name under a known schema', tableRef('a.csv', 'main'), 'main.a.csv'],
  ])('finds %s', (_label, from, name) => {
    expect(findFileReference(parseTree(selectNode([], from)))).toBe(name);
  });

  it('finds the subject of a DESCRIBE, nested in a subquery inside a join', () => {
    const describe = {
      type: 'SHOW_REF',
      show_type: 'DESCRIBE',
      table_name: '',
      query: selectNode([{ class: 'STAR', type: 'STAR' }], tableRef('a.json')),
    };
    const tree = parseTree(
      selectNode([], {
        type: 'JOIN',
        left: tableRef('t'),
        right: { type: 'SUBQUERY', subquery: { node: selectNode([], describe) } },
      }),
    );
    expect(findFileReference(tree)).toBe('a.json');
  });

  it('finds the subject of a SHOW the way DuckDB v2.0.0 writes it, on the SHOW_REF itself', () => {
    const show = {
      type: 'SHOW_REF',
      show_type: 'SHOW',
      table_name: '/srv/exports/a.csv',
      schema_name: '',
      catalog_name: '',
      query: null,
    };
    expect(findFileReference(parseTree(selectNode([], show)))).toBe('/srv/exports/a.csv');
    expect(
      findFileReference(parseTree(selectNode([], { ...show, table_name: 't' }))),
    ).toBeUndefined();
  });

  it.each([
    ['a staged table', tableRef('t')],
    ['a quoted name with spaces', tableRef('staged rows')],
    ['a schema-qualified table', tableRef('t', 'main')],
    ['a catalog-qualified table', tableRef('t', 'main', 'memory')],
    ['a catalog used as the schema', tableRef('t', 'memory')],
    ['a system catalog view', tableRef('tables', 'information_schema')],
    ['a pg_catalog table', tableRef('pg_class', 'pg_catalog')],
  ])('passes %s', (_label, from) => {
    expect(findFileReference(parseTree(selectNode([], from)))).toBeUndefined();
  });

  it('passes a path that appears only as data, and tolerates degenerate input', () => {
    const tree = parseTree(selectNode([constant('/srv/exports/a.csv')], tableRef('t')));
    expect(findFileReference(tree)).toBeUndefined();
    expect(findFileReference(null)).toBeUndefined();
    expect(findFileReference('not-a-tree')).toBeUndefined();
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
    expect(ALLOWED_PLAN_OPERATORS.has('READ_SINGLE_CSV_FILE')).toBe(false);
    expect(ALLOWED_PLAN_OPERATORS.has('DUCKDB_EXTERNAL_RESOURCES')).toBe(false);
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

// ---------------------------------------------------------------------------
// Comment stripping — linear-time scanner (#431)
// ---------------------------------------------------------------------------

/**
 * `stripSqlComments` is module-private; the deny-list scan runs over its output,
 * so whether a `read_json(` call survives stripping is the observable pin on
 * what the stripper did. Each case below is a shape where a different stripping
 * rule would flip the outcome.
 */
describe('sqlGate · comment stripping (#431)', () => {
  const denied = (sql: string) => () => assertNoDeniedFunctions(sql);

  it('closes a block comment at the first terminator, not the last', () => {
    // Lazy, not greedy: two separate comments, so the call between them survives.
    expect(denied("SELECT 1 /* a */ read_json('/x') /* b */ FROM t")).toThrow(
      /disallowed table function/,
    );
  });

  it('treats a nested opener as ordinary comment text', () => {
    expect(denied("SELECT 1 /* a /* read_json('/x') */ FROM t")).not.toThrow();
  });

  it('leaves an unterminated block comment — and everything after it — in place', () => {
    expect(denied("SELECT 1 /* unterminated read_json('/x')")).toThrow(/disallowed table function/);
  });

  it('strips block comments before line comments, so `--` inside a block is gone with it', () => {
    // Line-comment-first would swallow the block terminator and hide the call.
    expect(denied("SELECT 1 /* -- */ read_json('/x') FROM t")).toThrow(/disallowed table function/);
  });

  it('does not open a block comment from an opener inside a line comment', () => {
    expect(denied("SELECT 1 -- /* read_json('/x')\nFROM t")).not.toThrow();
  });

  it('leaves a block terminator with no opener untouched', () => {
    expect(denied("SELECT 1 */ read_json('/x') FROM t")).toThrow(/disallowed table function/);
  });

  it('scans a 1 MiB unterminated-comment payload in bounded time', () => {
    // The issue's reproduction at the default MCP_HTTP_MAX_BODY_BYTES cap.
    const sql = `/*${'a/*'.repeat(Math.floor((1024 * 1024 - 2) / 3))}`;
    expect(sql.length).toBeGreaterThan(1_000_000);

    const started = performance.now();
    assertNoDeniedFunctions(sql);
    assertNoSystemCatalogs(sql);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Recovery hints (#299)
// ---------------------------------------------------------------------------

/** Run a gate assertion expected to reject, and hand back the thrown McpError. */
function gateRejection(trigger: () => void): McpError {
  try {
    trigger();
  } catch (err) {
    if (err instanceof McpError) return err;
    throw err;
  }
  throw new Error('Expected the gate to reject.');
}

/**
 * One case per reason the gate itself throws, pinning the exact hint text. The
 * hint is what a model reads and acts on, so it is behavior: a reword here is a
 * wire change, not a cosmetic one. `invalid_sql` is absent because its only
 * throw site is the DuckDB provider's prepare-failure branch — the smoke suites
 * cover it end to end.
 */
const GATE_HINT_CASES: [SqlGateReason, () => void, string][] = [
  [
    SQL_GATE_REASONS.multiStatement,
    () => assertSelectOnly({ statementCount: 2, statementType: 'SELECT' }),
    'Send exactly one SELECT statement; split multi-statement SQL into separate calls.',
  ],
  [
    SQL_GATE_REASONS.nonSelectStatement,
    () => assertSelectOnly({ statementCount: 1, statementType: 'DROP' }),
    'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
  ],
  [
    SQL_GATE_REASONS.planOperatorNotAllowed,
    () => assertPlanReadOnly({ name: 'PROJECTION', children: [{ name: 'INSERT' }] }),
    'Rewrite using read-only SELECT constructs — joins, aggregates, window functions, and CTEs are supported.',
  ],
  [
    SQL_GATE_REASONS.deniedFunction,
    () => assertNoDeniedFunctions("SELECT * FROM read_json('/etc/passwd')"),
    'Remove the function the message names — only the staged tables are queryable.',
  ],
  [
    SQL_GATE_REASONS.deniedFunction,
    () =>
      assertNoDeniedParsedFunctions(
        parseTree(selectNode([call('current_setting', constant('x'))])),
      ),
    'Remove the function the message names — only the staged tables are queryable.',
  ],
  [
    SQL_GATE_REASONS.deniedFunctionInPlan,
    () => assertPlanReadOnly({ name: 'SEQ_SCAN', function: 'read_parquet' }),
    'Remove the file-reading or external-data function — only the staged tables are queryable.',
  ],
  [
    SQL_GATE_REASONS.identifierEmpty,
    () => assertValidIdentifier('', 'table'),
    'Use a name of letters, digits, and underscores starting with a letter or underscore, 63 characters or fewer.',
  ],
  [
    SQL_GATE_REASONS.identifierShape,
    () => assertValidIdentifier('bad-name!', 'table'),
    'Use a name of letters, digits, and underscores starting with a letter or underscore, 63 characters or fewer.',
  ],
  [
    SQL_GATE_REASONS.identifierReserved,
    () => assertValidIdentifier('select', 'table'),
    'Choose a name that is not a SQL keyword — for example, prefix it with the dataset name.',
  ],
  [
    SQL_GATE_REASONS.systemCatalogAccess,
    () => assertNoSystemCatalogs('SELECT * FROM information_schema.tables'),
    "Query only the staged dataframe tables; use this server's dataframe-describe tool to list them.",
  ],
];

describe('sqlGate · recovery hints (#299)', () => {
  it.each(GATE_HINT_CASES)(
    '%s carries its recovery hint on the wire',
    (reason, trigger, expectedHint) => {
      const err = gateRejection(trigger);
      const data = err.data as { reason?: string; recovery?: { hint?: string } };
      expect(data.reason).toBe(reason);
      expect(data.recovery?.hint).toBe(expectedHint);
    },
  );

  it('covers every gate-thrown reason, leaving only provider-thrown invalid_sql', () => {
    const covered = new Set<string>(GATE_HINT_CASES.map(([reason]) => reason));
    covered.add(SQL_GATE_REASONS.invalidSql);
    expect([...covered].sort()).toEqual([...Object.values(SQL_GATE_REASONS)].sort());
  });

  it('drops the unobservable denySystemCatalogs flag from the catalog message', () => {
    const err = gateRejection(() => assertNoSystemCatalogs('SELECT * FROM duckdb_tables()'));
    expect(err.message).toMatch(/references a system catalog/i);
    expect(err.message).not.toMatch(/denySystemCatalogs/);
  });

  it('drops the framework-method remedy from the non-SELECT message', () => {
    const err = gateRejection(() => assertSelectOnly({ statementCount: 1, statementType: 'DROP' }));
    expect(err.message).toBe('Canvas query must be SELECT; got DROP.');
  });
});
