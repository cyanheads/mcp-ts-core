/**
 * @fileoverview Read-only SQL gate for the DataCanvas primitive. Engine-agnostic
 * pure validators the provider invokes after pulling DuckDB-specific metadata.
 *
 * Five layers of enforcement, each authoritative:
 *
 * 1. **Function deny-list (text scan).** Pre-EXPLAIN regex against the SQL
 *    (string literals stripped) for file/HTTP-reading table functions like
 *    `read_json`, `read_parquet`. These can lower into generic SEQ_SCAN
 *    operators that pass the operator allowlist; catching them by name closes
 *    that bypass.
 * 2. **Single-statement check.** Reject anything other than exactly one
 *    statement parsed by DuckDB. Comment-hidden second statements, Unicode
 *    tricks, and multi-statement smuggling collapse here.
 * 3. **Statement-type check.** Require `SELECT`. DDL, DML, and utility
 *    statements (PRAGMA/ATTACH/COPY/INSTALL/LOAD/SET/EXECUTE) fail to type as
 *    SELECT.
 * 4. **Parse-tree check.** Walk DuckDB's own parse of the statement and
 *    reject any call to a function that reads an engine setting, runs SQL or
 *    names a table from a string, reads a file, or reads `pragma_*` metadata —
 *    called, or bare where DuckDB binds the bare name as the call — and any
 *    table reference that names a file. DuckDB resolves these while binding,
 *    so the plan need not name them. `query()` over a plain string literal is
 *    the one admitted call: its SQL is gated as its own statement, to a fixed
 *    nesting depth.
 * 5. **Plan-walk allowlist + denied-function rescan.** Walk the
 *    `EXPLAIN (FORMAT JSON)` tree; reject any operator outside the allowlist
 *    and any scan whose function-identity field names a deny-listed function.
 *
 * The gate sits on top of the engine's own bound: a canvas's DuckDB instance
 * reads and writes only under the export root and its scratch directory.
 *
 * Rejection paths throw `ValidationError` with a structured `data.reason` and a
 * `data.recovery.hint` phrased for a caller that can only reach the canvas
 * through a consuming server's tools.
 *
 * @module src/services/canvas/core/sqlGate
 */

import { validationError } from '@/types-global/errors.js';

/**
 * DuckDB statement-type string. Only `SELECT` is accepted; everything else
 * (DDL, DML, utility) is rejected. Modeled as a string surface rather than an
 * owned enum so the gate matches on whatever DuckDB emits.
 */
export type DuckdbStatementType = string;

/** Subset of statement types the gate permits. */
export const ALLOWED_STATEMENT_TYPES: ReadonlySet<DuckdbStatementType> = new Set(['SELECT']);

/**
 * Reason codes set on `validationError.data.reason` by gate assertions.
 * Consumers can import the {@link SqlGateReason} union to translate gate
 * denials into typed contract reasons without duplicating the strings.
 */
export const SQL_GATE_REASONS = {
  multiStatement: 'multi_statement',
  nonSelectStatement: 'non_select_statement',
  /**
   * A read that failed to prepare (unknown column/function/expression), as
   * DuckDB's parse of it says, or a statement that failed to parse and opens
   * like a read ({@link isReadShaped}).
   */
  invalidSql: 'invalid_sql',
  planOperatorNotAllowed: 'plan_operator_not_allowed',
  deniedFunction: 'denied_function',
  deniedFunctionInPlan: 'denied_function_in_plan',
  identifierEmpty: 'identifier_empty',
  identifierShape: 'identifier_shape',
  identifierReserved: 'identifier_reserved',
  systemCatalogAccess: 'system_catalog_access',
} as const;

/** Union of all gate reason strings — see {@link SQL_GATE_REASONS}. */
export type SqlGateReason = (typeof SQL_GATE_REASONS)[keyof typeof SQL_GATE_REASONS];

/**
 * Recovery hint per gate reason.
 *
 * A gate rejection is read by a model that can only call the consuming
 * server's tools, so each hint names a capability rather than the framework
 * method behind it: the caller cannot invoke `registerTable` or `describe`, and
 * naming them invites a hallucinated tool call. The `Record` is exhaustive by
 * type, so a new reason cannot ship without one.
 */
const SQL_GATE_RECOVERY: Record<SqlGateReason, string> = {
  [SQL_GATE_REASONS.multiStatement]:
    'Send exactly one SELECT statement; split multi-statement SQL into separate calls.',
  [SQL_GATE_REASONS.nonSelectStatement]:
    'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
  [SQL_GATE_REASONS.invalidSql]:
    "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.",
  [SQL_GATE_REASONS.planOperatorNotAllowed]:
    'Rewrite using read-only SELECT constructs — joins, aggregates, window functions, and CTEs are supported.',
  [SQL_GATE_REASONS.deniedFunction]:
    'Remove the function the message names — only the staged tables are queryable.',
  [SQL_GATE_REASONS.deniedFunctionInPlan]:
    'Remove the file-reading or external-data function — only the staged tables are queryable.',
  [SQL_GATE_REASONS.identifierEmpty]:
    'Use a name of letters, digits, and underscores starting with a letter or underscore, 63 characters or fewer.',
  [SQL_GATE_REASONS.identifierShape]:
    'Use a name of letters, digits, and underscores starting with a letter or underscore, 63 characters or fewer.',
  [SQL_GATE_REASONS.identifierReserved]:
    'Choose a name that is not a SQL keyword — for example, prefix it with the dataset name.',
  [SQL_GATE_REASONS.systemCatalogAccess]:
    "Query only the staged dataframe tables; use this server's dataframe-describe tool to list them.",
};

/**
 * The wire-shaped recovery for a gate reason, ready to spread into an error's
 * `data`. The framework mirrors `data.recovery.hint` into `content[]`, so
 * spreading this is what puts a `Recovery:` line in front of a format()-only
 * client.
 */
export function gateRecovery(reason: SqlGateReason): { recovery: { hint: string } } {
  return { recovery: { hint: SQL_GATE_RECOVERY[reason] } };
}

/**
 * Allowlist of read-only operator names that can appear in an EXPLAIN plan.
 * Anything outside this set causes rejection. Notable exclusions:
 *
 * - `READ_CSV`, `READ_PARQUET`, `READ_JSON` — bypass canvas, read external files.
 * - `INSERT`, `UPDATE`, `DELETE`, `MERGE_INTO`, `CREATE_*`, `DROP`, `ALTER` — writes.
 * - `COPY_TO_FILE`, `BATCH_COPY_TO_FILE`, `COPY_DATABASE` — write a SELECT to a file/db.
 * - `ATTACH`, `DETACH`, `LOAD`, `PRAGMA`, `SET`, `SET_VARIABLE`, `RESET`, `TRANSACTION`,
 *   `EXECUTE`, `PREPARE`, `VACUUM`, `EXPORT`, `EXPLAIN_ANALYZE`, `CREATE_SECRET` — utility/system.
 * - `INOUT_FUNCTION` — table-valued function lowering (read_json/read_parquet/...);
 *   gated by the function deny-list rather than the operator allowlist.
 *
 * Last derived against `PhysicalOperatorToString` in DuckDB v1.5.6
 * (`@duckdb/node-api` 1.5.6-r.1):
 * https://github.com/duckdb/duckdb/blob/v1.5.6/src/common/enums/physical_operator_type.cpp
 * and re-checked against the plans DuckDB v2.0.0 (`@duckdb/node-api`
 * 2.0.0-r.1) emits, which fold GROUPING SETS, ROLLUP, and CUBE into CTEs over
 * operators already listed here, and plan an unqualified `SHOW <name>` as
 * `PRAGMA_SHOW` where v1.5.6 plans a `COLUMN_DATA_SCAN`. Re-derive this set and
 * {@link DENIED_TABLE_FUNCTIONS} whenever the `@duckdb/node-api` peer range
 * moves.
 */
export const ALLOWED_PLAN_OPERATORS: ReadonlySet<string> = new Set([
  // Scans (registered tables only)
  'TABLE_SCAN',
  'SEQ_SCAN',
  'COLUMN_DATA_SCAN',
  'CHUNK_SCAN',
  'CTE_SCAN',
  'REC_CTE_SCAN',
  'REC_REC_CTE_SCAN',
  'DELIM_SCAN',
  'EXPRESSION_SCAN',
  'POSITIONAL_SCAN',
  'DUMMY_SCAN',
  'EMPTY_RESULT',
  'IN_MEMORY_TABLE_SCAN',
  /**
   * Generated series. A table function plans under its own name, so these admit
   * only the `range` and `generate_series` table overloads called with constant
   * arguments; a column (lateral) or subquery argument plans as INOUT_FUNCTION,
   * which stays off this list, and a subquery's own operators stay in the plan.
   */
  'RANGE',
  'GENERATE_SERIES',
  // Projection / filter
  'PROJECTION',
  'FILTER',
  // Joins
  'HASH_JOIN',
  'NESTED_LOOP_JOIN',
  'BLOCKWISE_NL_JOIN',
  'IE_JOIN',
  'PIECEWISE_MERGE_JOIN',
  'CROSS_PRODUCT',
  'POSITIONAL_JOIN',
  'ASOF_JOIN',
  'LEFT_DELIM_JOIN',
  'RIGHT_DELIM_JOIN',
  'DELIM_JOIN',
  // Aggregates
  'HASH_GROUP_BY',
  'PERFECT_HASH_GROUP_BY',
  'UNGROUPED_AGGREGATE',
  'SIMPLE_AGGREGATE',
  'PARTITIONED_AGGREGATE',
  // Distinct / set ops
  'HASH_DISTINCT',
  'DISTINCT',
  'LIMITED_DISTINCT',
  'UNION',
  // Sorting / limits
  'ORDER_BY',
  'TOP_N',
  'LIMIT',
  'LIMIT_PERCENT',
  'STREAMING_LIMIT',
  // Window
  'WINDOW',
  'STREAMING_WINDOW',
  // Nested
  'UNNEST',
  // CTEs (DuckDB stringifies RECURSIVE_* as REC_*; long names kept for older versions)
  'CTE',
  'CTE_REF',
  'REC_CTE',
  'REC_KEY_CTE',
  'RECURSIVE_CTE',
  'MATERIALIZED_CTE',
  // Sampling
  'RESERVOIR_SAMPLE',
  'SAMPLE',
  'STREAMING_SAMPLE',
  // Result framing
  'RESULT_COLLECTOR',
  'EXPLAIN',
  // A table's column listing: `SHOW <name>` on DuckDB v2.0. Layer 4 refuses
  // every `pragma_*` call by name, so only the SHOW statement plans it.
  'PRAGMA_SHOW',
  // Pivot/unpivot collapsed planner forms
  'PIVOT',
  // Spatial — pre-staged, dormant until the `spatial` extension loads.
  // See https://github.com/cyanheads/mcp-ts-core/issues/106.
  'RTREE_INDEX_SCAN',
]);

/**
 * External-data table functions (files, HTTP, S3, lakehouse formats). These
 * lower into generic scan operators that pass the operator allowlist, so the
 * text-scan and plan-rescan defenses in this module catch them by name
 * regardless of how DuckDB lowers them.
 *
 * Last derived against the table functions `duckdb_functions()` lists on
 * DuckDB v1.5.6 and v2.0.0 (`@duckdb/node-api` 1.5.6-r.1 and 2.0.0-r.1), plus
 * extension readers named ahead of any extension load. Re-derive this set and
 * {@link ALLOWED_PLAN_OPERATORS} whenever the `@duckdb/node-api` peer range
 * moves.
 */
export const DENIED_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  // CSV
  'read_csv',
  'read_csv_auto',
  'read_single_csv_file',
  'sniff_csv',
  // DuckDB database files
  'read_duckdb',
  // JSON
  'read_json',
  'read_json_auto',
  'read_json_objects',
  'read_json_objects_auto',
  'read_ndjson',
  'read_ndjson_auto',
  'read_ndjson_objects',
  'read_single_json_file',
  // Parquet
  'read_parquet',
  'read_single_parquet_file',
  'parquet_scan',
  'parquet_metadata',
  'parquet_schema',
  'parquet_file_metadata',
  'parquet_full_metadata',
  'parquet_kv_metadata',
  'parquet_bloom_probe',
  // Text / blob / glob
  'read_text',
  'read_blob',
  'glob',
  // Iceberg / Delta
  'iceberg_scan',
  'iceberg_metadata',
  'iceberg_snapshots',
  'delta_scan',
  // Postgres / MySQL / SQLite scanners (extension-loaded; defense-in-depth)
  'postgres_scan',
  'postgres_query',
  'mysql_scan',
  'mysql_query',
  'sqlite_scan',
  'sqlite_query',
  // Spatial — pre-staged, dormant until the `spatial` extension loads.
  // ST_Read is a GDAL-backed reader for ~50 vector formats; ST_Drivers exposes
  // the bundled GDAL driver surface; rtree_index_dump leaks index internals.
  // See https://github.com/cyanheads/mcp-ts-core/issues/106.
  'st_read',
  'st_drivers',
  'rtree_index_dump',
]);

/**
 * Call-shape regex (`name(`). Caller strips comments and string literals first
 * so quoted text and comment-injected separators between a name and its `(`
 * can't false-positive or bypass.
 */
const DENIED_FUNCTION_CALL_REGEX = new RegExp(
  String.raw`\b(${[...DENIED_TABLE_FUNCTIONS].join('|')})\s*\(`,
  'gi',
);

/**
 * Bare-name regex for the plan-walk rescan only. A plan names a scan's function
 * without parentheses (`"Function": "READ_JSON"`). Restricted to
 * function-identity fields, so the caller's own literals and aliases elsewhere
 * in the plan are never read as a call.
 */
const DENIED_FUNCTION_BARE_REGEX = new RegExp(
  String.raw`\b(${[...DENIED_TABLE_FUNCTIONS].join('|')})\b`,
  'gi',
);

/**
 * Deny the entire `pragma_*` namespace. DuckDB rewrites bare PRAGMA statements
 * (e.g. `PRAGMA table_info('t')`) into `SELECT * FROM pragma_table_info('t')`,
 * which types as SELECT and would otherwise pass `assertSelectOnly`. Covering
 * the namespace by prefix rather than an enumerated set ensures new pragma
 * metadata TVFs DuckDB adds in future versions are also blocked.
 *
 * Each layer covers it by prefix:
 * - `DENIED_PRAGMA_CALL_REGEX` — call shape (`pragma_<name>(`) for the text scan
 * - layer 4 — any parsed call whose function name starts `pragma_`, however
 *   the name is quoted, cased, or qualified
 * - `DENIED_PRAGMA_BARE_REGEX` — bare name for the plan-walk rescan of
 *   function-identity fields
 *
 * See https://github.com/cyanheads/mcp-ts-core/issues/210.
 */
const DENIED_PRAGMA_CALL_REGEX = /\b(pragma_\w+)\s*\(/gi;
const DENIED_PRAGMA_BARE_REGEX = /\b(pragma_\w+)\b/gi;

/**
 * Plan-node fields that name a scan's function: on the node itself, whose keys
 * DuckDB writes lowercase, or inside its `extra_info` object, matched
 * case-insensitively, where DuckDB v1.5.6 and v2.0.0 write `Function`.
 */
const FUNCTION_METADATA_KEYS: ReadonlySet<string> = new Set([
  'function',
  'function_name',
  'table_function',
  'source',
]);

/** A name as DuckDB's tokenizer reads one: `$` continues a name but cannot start one. */
const SQL_NAME = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;

/** A number, so an `E` in its exponent is not read as an escape-string prefix. */
const SQL_NUMBER = /[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9][0-9_]*)?/y;

/** A dollar-quote delimiter: `$$` or `$tag$`, the tag a name without `$`. */
const SQL_DOLLAR_DELIMITER = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/** Inside a backtick-quoted name, text a DuckDB without backtick names reads as a token of its own. */
const BACKTICK_NAME_TOKEN_START = /['"$]|--|\/\*/;

/**
 * `sql` as the text scans read it: each comment a space, each string literal
 * `''`, names and the rest as written, divided where DuckDB's tokenizer
 * divides them — so text the engine reads as code is always scanned, and text
 * it reads as data never is. A standard literal ends at a `'` not doubled; an
 * escape literal (`E'…'`, the `E` not ending a longer name) also takes
 * backslash escapes; a dollar-quoted literal ends at its own `$tag$`, matched
 * case-sensitively. Block comments nest; a line comment ends at `\n` or `\r`.
 * `"…"` and backtick-quoted names are kept, each closed by an undoubled quote.
 *
 * Where the engine would fail to end a literal or name, or DuckDB versions
 * read the text differently, the rest is scanned as written: an escape literal
 * continued on a later line (v1.5 keeps its backslash escapes, v2.0 does not),
 * and a backtick-quoted name holding a quote, `$`, or comment opener (v1.5
 * reads a backtick as an operator and its contents as SQL). A block comment
 * the engine never closes fails the statement before it runs; from there each
 * comment closes at its first terminator, and with none the rest is scanned as
 * written.
 *
 * One pass that reads each character a bounded number of times, so the cost is
 * linear in the input; the SQL reaching this gate is client-supplied.
 */
function stripCommentsAndLiterals(sql: string): string {
  let out = '';
  let i = 0;
  let nested = true;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    let end: number;
    if (ch === '-' && next === '-') {
      end = lineCommentEnd(sql, i);
      out += ' ';
    } else if (ch === '/' && next === '*') {
      end = nested ? blockCommentEnd(sql, i) : -1;
      if (end === -1) {
        nested = false;
        const close = sql.indexOf('*/', i + 2);
        if (close === -1) break;
        end = close + 2;
      }
      out += ' ';
    } else if (ch === "'") {
      end = quotedEnd(sql, i, "'");
      if (end === -1) break;
      out += "''";
    } else if ((ch === 'E' || ch === 'e') && next === "'") {
      end = escapeLiteralEnd(sql, i + 1);
      if (end === -1 || continuesOnLaterLine(sql, end)) break;
      out += "''";
    } else if (ch === '$') {
      SQL_DOLLAR_DELIMITER.lastIndex = i;
      const delimiter = SQL_DOLLAR_DELIMITER.exec(sql)?.[0];
      if (delimiter === undefined) {
        end = i + 1;
        out += ch;
      } else {
        const close = sql.indexOf(delimiter, i + delimiter.length);
        if (close === -1) break;
        end = close + delimiter.length;
        out += "''";
      }
    } else if (ch === '"' || ch === '`') {
      end = quotedEnd(sql, i, ch);
      if (end === -1) break;
      if (ch === '`' && BACKTICK_NAME_TOKEN_START.test(sql.slice(i + 1, end - 1))) break;
      out += sql.slice(i, end);
    } else {
      const token = /[0-9]/.test(ch) ? SQL_NUMBER : SQL_NAME;
      token.lastIndex = i;
      end = token.exec(sql) === null ? i + 1 : token.lastIndex;
      out += sql.slice(i, end);
    }
    i = end;
  }
  return `${out}${sql.slice(i)}`;
}

/** Index of the `\n` or `\r` ending the line comment opened at `start`, or the input's end. */
function lineCommentEnd(sql: string, start: number): number {
  let i = start + 2;
  while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
  return i;
}

/** Index past the terminator closing the block comment opened at `start`, counting nested openers; -1 when unterminated. */
function blockCommentEnd(sql: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth++;
      i += 2;
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      i += 2;
      if (--depth === 0) return i;
    } else {
      i++;
    }
  }
  return -1;
}

/** Index past the `quote` closing the quoted text opened at `start`, a doubled `quote` standing for one; -1 when unterminated. */
function quotedEnd(sql: string, start: number, quote: string): number {
  let from = start + 1;
  for (;;) {
    const close = sql.indexOf(quote, from);
    if (close === -1) return -1;
    if (sql[close + 1] !== quote) return close + 1;
    from = close + 2;
  }
}

/** Index past the `'` closing the escape literal whose opening `'` is at `start`; -1 when unterminated. */
function escapeLiteralEnd(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === '\\') {
      i += 2;
    } else if (sql[i] === "'") {
      if (sql[i + 1] !== "'") return i + 1;
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Whether the literal ending at `end` continues: whitespace and line comments
 * holding a line break, then a `'`, which DuckDB reads as more of the same
 * literal.
 */
function continuesOnLaterLine(sql: string, end: number): boolean {
  let i = end;
  let lineBreak = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '\n' || ch === '\r') {
      lineBreak = true;
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      i++;
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = lineCommentEnd(sql, i);
    } else {
      break;
    }
  }
  return lineBreak && sql[i] === "'";
}

/**
 * Layer 1: pre-EXPLAIN function deny-list. Scans the SQL (comments and string
 * literals stripped where the engine ends them — {@link stripCommentsAndLiterals})
 * for calls to any function in {@link DENIED_TABLE_FUNCTIONS} or the
 * `pragma_*` namespace so a malicious `read_json('/etc/passwd')` or
 * `pragma_table_info('t')` is rejected before reaching the planner.
 */
export function assertNoDeniedFunctions(sql: string): void {
  if (typeof sql !== 'string' || sql.length === 0) return;
  const stripped = stripCommentsAndLiterals(sql);
  DENIED_FUNCTION_CALL_REGEX.lastIndex = 0;
  const match = DENIED_FUNCTION_CALL_REGEX.exec(stripped);
  if (match?.[1]) {
    const fn = match[1].toLowerCase();
    throw deniedFunctionError(fn, deniedTableFunctionMessage(fn));
  }
  // Deny pragma_* table function calls (whole namespace, not just known names).
  DENIED_PRAGMA_CALL_REGEX.lastIndex = 0;
  const pragmaMatch = DENIED_PRAGMA_CALL_REGEX.exec(stripped);
  if (pragmaMatch?.[1]) {
    const fn = pragmaMatch[1].toLowerCase();
    throw deniedFunctionError(fn, deniedPragmaMessage(fn));
  }
}

/** Whether `fn`, lowercased, is in the `pragma_*` metadata namespace. */
function isPragmaFunction(fn: string): boolean {
  return fn.startsWith('pragma_');
}

/** The rejection message for a call to a `pragma_*` metadata function. */
function deniedPragmaMessage(fn: string): string {
  return `Canvas query references disallowed table function: ${fn}. PRAGMA metadata functions are not permitted.`;
}

/**
 * The `denied_function` rejection naming `fn`, carrying `hint` as its recovery
 * when given and the reason's catalog hint otherwise.
 */
function deniedFunctionError(fn: string, message: string, hint?: string) {
  return validationError(message, {
    reason: SQL_GATE_REASONS.deniedFunction,
    function: fn,
    ...(hint === undefined
      ? gateRecovery(SQL_GATE_REASONS.deniedFunction)
      : { recovery: { hint } }),
  });
}

/** The rejection message for a call to a {@link DENIED_TABLE_FUNCTIONS} reader. */
function deniedTableFunctionMessage(fn: string): string {
  return `Canvas query references disallowed table function: ${fn}. File-reading and external-data functions are not permitted.`;
}

/**
 * Functions refused by name in the parsed statement, beyond
 * {@link DENIED_TABLE_FUNCTIONS}: the scalars that read an engine setting;
 * `query`, `query_table`, and `index_key`, which run SQL or name a table from
 * a string; and the external-resource table functions, which change engine
 * state and take the functions they call as strings. DuckDB resolves these
 * while binding, so the plan need not name them. `query` is admitted over a
 * single plain string literal, whose SQL the caller of
 * {@link assertNoDeniedParsedFunctions} gates as its own statement.
 *
 * Last derived against `duckdb_functions()` on DuckDB v1.5.6 and v2.0.0:
 * `current_setting` reads any setting; `current_schema`, `current_schemas`,
 * and `in_search_path` read the `schema` / `search_path` settings. The
 * settings table functions (`duckdb_settings`, `duckdb_profiling_settings`)
 * plan as their own operators, which {@link ALLOWED_PLAN_OPERATORS} excludes.
 * `index_key` and the external-resource functions are new in v2.0.
 * Re-derive alongside {@link DENIED_TABLE_FUNCTIONS}.
 */
export const DENIED_PARSED_FUNCTIONS: ReadonlySet<string> = new Set([
  'create_external_resource',
  'current_setting',
  'current_schema',
  'current_schemas',
  'deregister_external_resource',
  'destroy_external_resource',
  'in_search_path',
  'index_key',
  'query',
  'query_table',
  'register_external_resource',
  'register_external_resource_type',
]);

/**
 * Names DuckDB binds as a function call when written bare, without
 * parentheses: an unqualified column reference of one of these names, quoted
 * or not and in any case, reads the function whenever no column of that name
 * is in scope. The parse tree writes it as a one-part `COLUMN_REF`, so only
 * the name says it may be a call.
 *
 * Last derived against DuckDB v1.5.6 (`GetSQLValueFunctionName`) and v2.0.0
 * by running `SELECT <name>` for every name `duckdb_functions()` lists plus
 * these: on both, these bind and no other name does. Re-derive alongside
 * {@link DENIED_TABLE_FUNCTIONS}; `canvas-gate-bypass.test.ts` fails when the
 * engine's set moves.
 */
export const BARE_FUNCTION_KEYWORDS: ReadonlySet<string> = new Set([
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

/**
 * The {@link BARE_FUNCTION_KEYWORDS} that are also
 * {@link DENIED_PARSED_FUNCTIONS} — on DuckDB v1.5.6 and v2.0.0, `current_schema` alone.
 * Layer 4 refuses an unqualified column reference of one of these names, since
 * the parse tree cannot tell a staged column of that name from the function;
 * the column stays reachable qualified with its table. The rest read no engine
 * setting: `current_catalog` is the admitted `current_database()`, the user and
 * role names are constants, and the others read the clock.
 */
export const DENIED_BARE_KEYWORDS: ReadonlySet<string> = new Set(
  [...BARE_FUNCTION_KEYWORDS].filter((name) => DENIED_PARSED_FUNCTIONS.has(name)),
);

/** A denied name the parse tree reaches, and whether it was written as a call or bare. */
interface DeniedReference {
  fn: string;
  form: 'call' | 'bare';
}

/**
 * Layer 4: reject a call to any function in {@link DENIED_PARSED_FUNCTIONS},
 * in {@link DENIED_TABLE_FUNCTIONS}, or in the `pragma_*` namespace anywhere in
 * `parseTree`, the statement as DuckDB's `json_serialize_sql` parses it, and an
 * unqualified column reference named in {@link DENIED_BARE_KEYWORDS}. A call is
 * any object carrying a string `function_name`; string constants, column
 * references, and table references never carry one, so a name that appears
 * only as data, a column, or a view passes.
 *
 * `query` over a single plain string literal is admitted, and the SQL of every
 * admitted call is returned in walk order. The literal is all the text layers
 * cannot see, so the caller must gate each returned string as its own
 * statement, through every layer that runs before the plan walk, before
 * running the SQL that holds it. Any other argument to `query` — an
 * expression, a cast, a column, a parameter, a named or second argument — is
 * refused, since its string is not known until the engine computes it.
 */
export function assertNoDeniedParsedFunctions(parseTree: unknown): string[] {
  const literals: string[] = [];
  const denied = findDeniedCall(parseTree, literals);
  if (denied === undefined) return literals;
  const { fn, form } = denied;
  // A bare name may be a staged column DuckDB would bind, which the parse tree
  // cannot tell from the function — so the refusal says so, and its hint says
  // to qualify the column instead of the catalog's "remove the function".
  if (form === 'bare') {
    throw deniedFunctionError(
      fn,
      `Canvas query references ${fn} unqualified. DuckDB reads that as the ${fn}() function unless a column of that name is in scope, so the canvas refuses it either way.`,
      `Qualify a column named ${fn} with its table (<table>.${fn}), or remove the reference — the ${fn}() function is not available.`,
    );
  }
  throw deniedFunctionError(
    fn,
    DENIED_TABLE_FUNCTIONS.has(fn)
      ? deniedTableFunctionMessage(fn)
      : isPragmaFunction(fn)
        ? deniedPragmaMessage(fn)
        : `Canvas query references disallowed function: ${fn}. Functions that read engine settings, change engine state, or run SQL or name a table from a string, are not permitted.`,
  );
}

/**
 * The first denied name a depth-first walk of `node` reaches, called or bare,
 * collecting into `literals` the SQL of each `query` call it admits.
 */
function findDeniedCall(node: unknown, literals: string[]): DeniedReference | undefined {
  if (node === null || typeof node !== 'object') return;
  const call = node as CallArguments & {
    class?: unknown;
    column_names?: unknown;
    function_name?: unknown;
  };
  if (typeof call.function_name === 'string') {
    const fn = call.function_name.toLowerCase();
    const literal = fn === 'query' ? soleStringLiteral(call) : undefined;
    if (literal !== undefined) literals.push(literal);
    else if (
      DENIED_PARSED_FUNCTIONS.has(fn) ||
      DENIED_TABLE_FUNCTIONS.has(fn) ||
      isPragmaFunction(fn)
    ) {
      return { fn, form: 'call' };
    }
  }
  if (
    call.class === 'COLUMN_REF' &&
    Array.isArray(call.column_names) &&
    call.column_names.length === 1 &&
    typeof call.column_names[0] === 'string'
  ) {
    const name = call.column_names[0].toLowerCase();
    if (DENIED_BARE_KEYWORDS.has(name)) return { fn: name, form: 'bare' };
  }
  for (const value of Object.values(node)) {
    const found = findDeniedCall(value, literals);
    if (found !== undefined) return found;
  }
  return;
}

/**
 * A function call's arguments as `json_serialize_sql` writes them: `children`
 * on DuckDB v1.5, `arguments` on v2.0.
 */
interface CallArguments {
  arguments?: unknown;
  children?: unknown;
}

/**
 * The string of `call`'s arguments when they are exactly one unnamed, non-null
 * string constant; `undefined` for any other shape. DuckDB v2.0 serializes that
 * constant as `{ name: '', expression: { literal: { kind: 'STRING', text } } }`,
 * v1.5.6 as a `VARCHAR` `value`; both carry the string unescaped, as the engine
 * runs it.
 */
function soleStringLiteral(call: CallArguments): string | undefined {
  if (Array.isArray(call.arguments)) {
    if (call.arguments.length !== 1) return;
    const arg = call.arguments[0] as {
      expression?: {
        alias?: unknown;
        class?: unknown;
        literal?: { kind?: unknown; text?: unknown };
      };
      name?: unknown;
    } | null;
    const expression = arg?.expression;
    if (
      arg?.name !== '' ||
      expression?.class !== 'CONSTANT' ||
      expression.alias !== '' ||
      expression.literal?.kind !== 'STRING' ||
      typeof expression.literal.text !== 'string'
    ) {
      return;
    }
    return expression.literal.text;
  }
  const args = call.children;
  if (!Array.isArray(args) || args.length !== 1) return;
  const arg = args[0] as {
    alias?: unknown;
    class?: unknown;
    value?: { is_null?: unknown; type?: { id?: unknown }; value?: unknown };
  } | null;
  if (
    arg?.class !== 'CONSTANT' ||
    arg.alias !== '' ||
    arg.value?.is_null !== false ||
    arg.value.type?.id !== 'VARCHAR' ||
    typeof arg.value.value !== 'string'
  ) {
    return;
  }
  return arg.value.value;
}

/**
 * How many `query()` string literals deep the gate follows a statement. One
 * level is the literal of a `query()` call in the statement itself.
 */
export const MAX_QUERY_NESTING = 4;

/**
 * Reject a `query()` string literal `depth` levels deep when that is past
 * {@link MAX_QUERY_NESTING}, as `denied_function`.
 */
export function assertQueryNesting(depth: number): void {
  if (depth <= MAX_QUERY_NESTING) return;
  throw deniedFunctionError(
    'query',
    `Canvas query nests query() more than ${MAX_QUERY_NESTING} levels deep.`,
  );
}

/**
 * Schemas and catalogs a canvas's database has. A table reference qualified
 * by anything else cannot name a staged table, view, or CTE.
 */
const DATABASE_QUALIFIERS: ReadonlySet<string> = new Set([
  'memory',
  'system',
  'temp',
  'main',
  'information_schema',
  'pg_catalog',
]);

/**
 * Layer 4: the first table reference in `parseTree` that names a file rather
 * than a staged table, view, or CTE, as its qualified name; `undefined` when
 * there is none. DuckDB reads a table name it cannot find in the catalog as a
 * file path, so a reference counts as a file when its name holds a dot — no
 * canvas name can — or a qualifier the database does not have. A DESCRIBE's
 * subject is a reference like any other, and so is a SHOW's, which DuckDB v2.0
 * writes as the `SHOW_REF`'s own `table_name`.
 *
 * A CTE whose name holds a dot is refused too: the parse tree writes a CTE
 * reference as a `BASE_TABLE` like any other, and exempting the names a
 * statement's `cte_map`s define would also admit a same-named reference
 * outside that CTE's scope, which DuckDB reads as a file.
 *
 * `skip` exempts the references whose qualified name equals it: the name the
 * catalog reported missing when the statement failed to prepare, which DuckDB
 * looked up as a table rather than reading as a file.
 */
export function findFileReference(parseTree: unknown, skip?: string): string | undefined {
  if (parseTree === null || typeof parseTree !== 'object') return;
  const ref = parseTree as {
    catalog_name?: unknown;
    schema_name?: unknown;
    table_name?: unknown;
    type?: unknown;
  };
  if (
    (ref.type === 'BASE_TABLE' || ref.type === 'SHOW_REF') &&
    typeof ref.table_name === 'string'
  ) {
    const qualifiers = [ref.catalog_name, ref.schema_name].filter(
      (part): part is string => typeof part === 'string' && part !== '',
    );
    const name = [...qualifiers, ref.table_name].join('.');
    if (
      name !== skip &&
      (ref.table_name.includes('.') ||
        qualifiers.some((part) => !DATABASE_QUALIFIERS.has(part.toLowerCase())))
    ) {
      return name;
    }
  }
  for (const value of Object.values(parseTree)) {
    const found = findFileReference(value, skip);
    if (found !== undefined) return found;
  }
  return;
}

/**
 * DuckDB's internal metadata views that resolve without a schema: the
 * `system.main` views (`duckdb_tables`, `sqlite_master`, `pragma_database_list`,
 * …) and the `system.pg_catalog` views. Each reads catalog metadata — its
 * columns through DESCRIBE or a scan the optimizer removes — however the
 * reference is qualified.
 *
 * Last derived from `duckdb_views()` (internal views in the `system` catalog's
 * `main` and `pg_catalog` schemas) on DuckDB v1.5.6 and v2.0.0, which list the
 * same 36. Re-derive alongside {@link DENIED_TABLE_FUNCTIONS};
 * `canvas-gate-bypass.test.ts` fails when the engine's set moves.
 */
export const INTERNAL_METADATA_VIEWS: ReadonlySet<string> = new Set([
  'duckdb_columns',
  'duckdb_constraints',
  'duckdb_databases',
  'duckdb_indexes',
  'duckdb_logs',
  'duckdb_schemas',
  'duckdb_tables',
  'duckdb_types',
  'duckdb_views',
  'pragma_database_list',
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'pg_am',
  'pg_attrdef',
  'pg_attribute',
  'pg_class',
  'pg_collation',
  'pg_constraint',
  'pg_database',
  'pg_depend',
  'pg_description',
  'pg_enum',
  'pg_index',
  'pg_indexes',
  'pg_namespace',
  'pg_prepared_statements',
  'pg_proc',
  'pg_sequence',
  'pg_sequences',
  'pg_settings',
  'pg_tables',
  'pg_tablespace',
  'pg_type',
  'pg_views',
]);

/**
 * System-catalog namespace patterns for the text-scan deny layer.
 *
 * Covers bare and dotted references to the `information_schema` and
 * `pg_catalog` schemas, the `duckdb_<name>(` call namespace, and every
 * {@link INTERNAL_METADATA_VIEWS} name, schema-qualified or not. Comments and
 * string literals are stripped before the scan so a catalog name written as
 * data does not false-positive.
 *
 * Three forms to cover how each namespace can appear in SQL:
 * - `information_schema.` / `pg_catalog.` — schema-qualified table or view
 *   reference; bare `information_schema` alone selects the schema namespace.
 * - `duckdb_<word>(` — metadata TVF call shape (e.g. `duckdb_tables()`).
 * - an internal view name as a whole word (`sqlite_master`, `pg_class`), in
 *   any case, quoted or not — the name is the reference.
 */
const SYSTEM_CATALOG_REGEX = new RegExp(
  String.raw`\b(information_schema|pg_catalog)\b|\b(duckdb_\w+)\s*\(|\b(${[...INTERNAL_METADATA_VIEWS].join('|')})\b`,
  'gi',
);

/**
 * Optional gate layer: reject references to system catalog namespaces.
 *
 * Enable via `QueryOptions.denySystemCatalogs` or
 * `RegisterViewOptions.denySystemCatalogs` on servers that use a hidden shared
 * canvas where handle possession is the access boundary. When enabled, any
 * reference to `information_schema`, `pg_catalog`, `duckdb_<name>()`, or one of
 * DuckDB's internal metadata views ({@link INTERNAL_METADATA_VIEWS} —
 * `duckdb_tables`, `sqlite_master`, `pg_class`, …), schema-qualified or not,
 * throws `ValidationError` with `data.reason: 'system_catalog_access'`. A
 * column or alias spelled like one of those names is refused too: the scan
 * reads names, not their role in the statement.
 *
 * Comments and string literals are stripped before the scan where the engine
 * ends them (identical pre-processing to {@link assertNoDeniedFunctions}).
 */
export function assertNoSystemCatalogs(sql: string): void {
  if (typeof sql !== 'string' || sql.length === 0) return;
  const stripped = stripCommentsAndLiterals(sql);
  SYSTEM_CATALOG_REGEX.lastIndex = 0;
  const match = SYSTEM_CATALOG_REGEX.exec(stripped);
  if (match) {
    const name = (match[1] ?? match[2] ?? match[0]).toLowerCase();
    throw validationError(
      `Canvas query references a system catalog: ${name}. System catalogs are not permitted.`,
      {
        reason: SQL_GATE_REASONS.systemCatalogAccess,
        catalog: name,
        ...gateRecovery(SQL_GATE_REASONS.systemCatalogAccess),
      },
    );
  }
}

/**
 * Layers 2, 3, and 5 only, over metadata the caller supplies. Throws on the
 * first violation. Layer 1 ({@link assertNoDeniedFunctions}) runs separately
 * before `extractStatements`, and layer 4 ({@link assertNoDeniedParsedFunctions}
 * and {@link findFileReference}) on the statement's parse tree before EXPLAIN;
 * a caller running SQL through this alone gets neither.
 */
export function assertReadOnlyQuery(input: {
  /** Number of statements DuckDB extracted from the user-supplied SQL. */
  statementCount: number;
  /** DuckDB statement type for the (single) prepared statement. */
  statementType: DuckdbStatementType;
  /** Parsed `EXPLAIN (FORMAT JSON)` payload. */
  planJson: unknown;
}): void {
  assertSelectOnly(input);
  assertPlanReadOnly(input.planJson);
}

/**
 * Layers 2-3: validate statement count and type before EXPLAIN. Non-SELECT
 * statements (ATTACH/PRAGMA/COPY/INSTALL/...) fail here with a structured
 * ValidationError rather than a confusing parser error from EXPLAIN itself.
 */
export function assertSelectOnly(input: {
  statementCount: number;
  statementType: DuckdbStatementType;
}): void {
  if (input.statementCount !== 1) {
    throw validationError('Canvas query must contain exactly one SQL statement.', {
      reason: SQL_GATE_REASONS.multiStatement,
      statementCount: input.statementCount,
      ...gateRecovery(SQL_GATE_REASONS.multiStatement),
    });
  }
  if (!ALLOWED_STATEMENT_TYPES.has(input.statementType)) {
    throw validationError(`Canvas query must be SELECT; got ${input.statementType}.`, {
      reason: SQL_GATE_REASONS.nonSelectStatement,
      statementType: input.statementType,
      ...gateRecovery(SQL_GATE_REASONS.nonSelectStatement),
    });
  }
}

/**
 * The `non_select_statement` recovery for a statement holding a PIVOT that
 * DuckDB could not take as one SELECT. Worded as a fact, so it still reads true
 * for a statement refused for another reason that merely holds the keyword.
 */
const PIVOT_RECOVERY =
  'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.';

/**
 * `PIVOT`, or DuckDB's synonym `PIVOT_WIDER`, with the prefix that makes the
 * word a name rather than the keyword (an alias after `AS`, a column after a
 * `.`) captured so the caller can pass over it.
 */
const PIVOT_WORD = /(\bas\s+|\.\s*)?\bpivot(?:_wider)?\b/gi;

/** A double-quoted or backtick-quoted name, which never holds a keyword. */
const QUOTED_NAME = /"(?:[^"]|"")*"|`(?:[^`]|``)*`/g;

/**
 * Layers 2-3 for a statement DuckDB could not take as one SELECT — it extracted
 * several statements, or its serializer cannot represent the one — that holds a
 * PIVOT keyword outside comments, string literals, and quoted names. A PIVOT
 * without an IN list is such a statement: DuckDB creates an enum type of the
 * pivoted column's values before its SELECT runs, which v1.5 extracts as two
 * statements and v2.0 as one its serializer cannot represent. Either way it is
 * refused as `non_select_statement`, before anything is prepared, with a hint
 * naming the list. Called only on that path: a PIVOT that lists its values is
 * one SELECT and never reaches it. A text with a `;` before its last statement
 * is the caller's several statements, left to `multi_statement`.
 */
export function assertNoPivot(sql: string): void {
  const code = stripCommentsAndLiterals(sql).replace(QUOTED_NAME, '""');
  let end = code.length;
  while (end > 0 && /[\s;]/.test(code.charAt(end - 1))) end--;
  if (code.lastIndexOf(';', end - 1) !== -1) return;
  for (const [, nameBefore] of code.matchAll(PIVOT_WORD)) {
    if (nameBefore !== undefined) continue;
    throw validationError('Canvas query must be SELECT.', {
      reason: SQL_GATE_REASONS.nonSelectStatement,
      statementType: 'UNKNOWN',
      recovery: { hint: PIVOT_RECOVERY },
    });
  }
}

/**
 * An opening, past the whitespace and opening parentheses DuckDB skips, with a
 * keyword DuckDB parses as a query. A character class then a keyword: no
 * nested repetition, so a run that ends in anything else fails in linear time.
 */
const READ_OPENING =
  /^[\s(]*(?:select|with|from|values|table|pivot|pivot_wider|unpivot|pivot_longer|summarize|describe|show)\b/i;

/**
 * Whether a statement DuckDB could not parse opens like a read: past its leading
 * comments, whitespace, and opening parentheses, with a keyword DuckDB parses as
 * a query. Read over {@link stripCommentsAndLiterals}, so a keyword inside a
 * comment or string literal never counts, in time linear in the input. A
 * statement DuckDB parses has a parse tree to say whether it is a read, and is
 * never classified by this.
 */
export function isReadShaped(sql: string): boolean {
  return READ_OPENING.test(stripCommentsAndLiterals(sql));
}

/**
 * Layer 5: walk the plan tree and reject any operator outside the allowlist
 * or any deny-listed table function smuggled into a generic scan operator.
 */
export function assertPlanReadOnly(planJson: unknown): void {
  const { offending, deniedFunctions } = collectPlanViolations(planJson);
  if (deniedFunctions.size > 0) {
    throw validationError(
      `Canvas query references disallowed table function in plan: ${[...deniedFunctions].sort().join(', ')}.`,
      {
        reason: SQL_GATE_REASONS.deniedFunctionInPlan,
        functions: [...deniedFunctions].sort(),
        ...gateRecovery(SQL_GATE_REASONS.deniedFunctionInPlan),
      },
    );
  }
  if (offending.size > 0) {
    throw validationError(
      `Canvas query contains disallowed operators: ${[...offending].sort().join(', ')}.`,
      {
        reason: SQL_GATE_REASONS.planOperatorNotAllowed,
        operators: [...offending].sort(),
        ...gateRecovery(SQL_GATE_REASONS.planOperatorNotAllowed),
      },
    );
  }
}

/**
 * Returns operator names not in `ALLOWED_PLAN_OPERATORS`. Exported for
 * fixture-driven tests that want to inspect the gate's view without throwing.
 * Use {@link collectPlanViolations} to also surface deny-listed function
 * references in scan-operator metadata.
 */
export function collectDisallowedOperators(planJson: unknown): Set<string> {
  return collectPlanViolations(planJson).offending;
}

/**
 * Combined plan-walk: disallowed operators and the deny-listed table functions
 * the plan's scans name, returned separately so callers can word errors
 * appropriately.
 */
export function collectPlanViolations(planJson: unknown): {
  offending: Set<string>;
  deniedFunctions: Set<string>;
} {
  const offending = new Set<string>();
  const deniedFunctions = new Set<string>();
  walk(planJson, offending, deniedFunctions);
  return { offending, deniedFunctions };
}

function walk(node: unknown, offending: Set<string>, deniedFunctions: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, offending, deniedFunctions);
    return;
  }
  const obj = node as Record<string, unknown>;
  const operator = readOperatorName(obj);
  const admitted = operator !== undefined && ALLOWED_PLAN_OPERATORS.has(operator);
  if (operator !== undefined && !admitted) {
    offending.add(operator);
  }
  // A table function can lower into a generic scan operator, so a scan's
  // function is read from its function-identity fields as well as from the
  // operator name: bare names there, the call shape in other string fields.
  // Also scan for pragma_* metadata TVFs using the namespace-level regexes.
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') continue;
    const setRegex = FUNCTION_METADATA_KEYS.has(key)
      ? DENIED_FUNCTION_BARE_REGEX
      : DENIED_FUNCTION_CALL_REGEX;
    collectDeniedFunctionMatches(value, setRegex, deniedFunctions);
    const pragmaRegex = FUNCTION_METADATA_KEYS.has(key)
      ? DENIED_PRAGMA_BARE_REGEX
      : DENIED_PRAGMA_CALL_REGEX;
    collectDeniedFunctionMatches(value, pragmaRegex, deniedFunctions);
  }
  // `extra_info` names a scan's function beside fields that hold the caller's
  // own literals and aliases, so only its function-identity keys are read. A
  // scan names its own operator there (`Function: PRAGMA_SHOW` on PRAGMA_SHOW),
  // which the allowlist has already ruled on.
  const info = obj.extra_info;
  if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
    for (const [key, value] of Object.entries(info)) {
      if (typeof value !== 'string' || !FUNCTION_METADATA_KEYS.has(key.toLowerCase())) continue;
      if (admitted && value.toUpperCase() === operator) continue;
      collectDeniedFunctionMatches(value, DENIED_FUNCTION_BARE_REGEX, deniedFunctions);
      collectDeniedFunctionMatches(value, DENIED_PRAGMA_BARE_REGEX, deniedFunctions);
    }
  }
  for (const key of ['children', 'child', 'inputs', 'plan', 'root']) {
    if (key in obj) walk(obj[key], offending, deniedFunctions);
  }
}

function collectDeniedFunctionMatches(value: string, regex: RegExp, sink: Set<string>): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(value);
  while (match !== null) {
    if (match[1]) sink.add(match[1].toLowerCase());
    match = regex.exec(value);
  }
}

function readOperatorName(obj: Record<string, unknown>): string | undefined {
  // DuckDB emits operator identity under different keys depending on the
  // EXPLAIN flavor (logical/physical/profile).
  for (const key of ['name', 'operator_type', 'operator', 'type']) {
    const value = obj[key];
    if (typeof value === 'string' && value !== '') return value.toUpperCase();
  }
  return;
}

// ---------------------------------------------------------------------------
// Identifier validation and quoting
// ---------------------------------------------------------------------------

/**
 * Allowed shape for canvas table/column names. SQL identifier convention:
 * letter/underscore start, letters/digits/underscores after, max 63 chars
 * (PostgreSQL/DuckDB cap). Exported so consumers can reuse it in Zod schemas
 * (`z.string().regex(CANVAS_IDENTIFIER_REGEX)`).
 */
export const CANVAS_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Courtesy guard against bare reserved words. Not exhaustive — the shape gate
 * is authoritative; this just produces a friendlier error at register time.
 */
const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'select',
  'from',
  'where',
  'order',
  'group',
  'having',
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'all',
  'distinct',
  'as',
  'and',
  'or',
  'not',
  'null',
  'true',
  'false',
  'case',
  'when',
  'then',
  'else',
  'end',
  'join',
  'inner',
  'outer',
  'left',
  'right',
  'full',
  'cross',
  'on',
  'using',
  'with',
  'recursive',
]);

/** Validate a canvas table or column name. Throws `ValidationError` on rejection. */
export function assertValidIdentifier(value: string, kind: 'table' | 'column'): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`Canvas ${kind} name must be a non-empty string.`, {
      reason: SQL_GATE_REASONS.identifierEmpty,
      kind,
      ...gateRecovery(SQL_GATE_REASONS.identifierEmpty),
    });
  }
  if (!CANVAS_IDENTIFIER_REGEX.test(value)) {
    throw validationError(
      `Canvas ${kind} name "${value}" is invalid. Use letters, digits, and underscores; must start with a letter or underscore; max 63 chars.`,
      {
        reason: SQL_GATE_REASONS.identifierShape,
        kind,
        value,
        ...gateRecovery(SQL_GATE_REASONS.identifierShape),
      },
    );
  }
  if (RESERVED_IDENTIFIERS.has(value.toLowerCase())) {
    throw validationError(
      `Canvas ${kind} name "${value}" is a reserved SQL keyword. Choose another name.`,
      {
        reason: SQL_GATE_REASONS.identifierReserved,
        kind,
        value,
        ...gateRecovery(SQL_GATE_REASONS.identifierReserved),
      },
    );
  }
}

/**
 * Double-quote-escape an identifier for SQL embedding. Validate via
 * {@link assertValidIdentifier} first — this helper only escapes, it does not
 * check shape.
 */
export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
