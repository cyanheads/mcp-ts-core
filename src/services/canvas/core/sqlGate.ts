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
 *    names a table from a string, or reads a file — called, or bare where
 *    DuckDB binds the bare name as the call — and any table reference
 *    that names a file. DuckDB resolves these while binding, so the plan need
 *    not name them. `query()` over a plain string literal is the one admitted
 *    call: its SQL is gated as its own statement, to a fixed nesting depth.
 * 5. **Plan-walk allowlist + denied-function rescan.** Walk the
 *    `EXPLAIN (FORMAT JSON)` tree; reject any operator outside the allowlist
 *    or any string field referencing a deny-listed function.
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
  /** SELECT-shaped statement that failed to prepare (unknown column/function/expression). */
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
 * Re-derive this set and {@link DENIED_TABLE_FUNCTIONS} whenever the
 * `@duckdb/node-api` peer range moves.
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
 * DuckDB v1.5.6 (`@duckdb/node-api` 1.5.6-r.1), plus extension readers named
 * ahead of any extension load. Re-derive this set and
 * {@link ALLOWED_PLAN_OPERATORS} whenever the `@duckdb/node-api` peer range
 * moves.
 */
export const DENIED_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  // CSV
  'read_csv',
  'read_csv_auto',
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
  // Parquet
  'read_parquet',
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
 * Bare-name regex for the plan-walk rescan only. DuckDB EXPLAIN metadata can
 * spell out a function as `Function: read_json` without parens. Restricted to
 * known function-name fields to avoid scanning user-projected string literals.
 */
const DENIED_FUNCTION_BARE_REGEX = new RegExp(
  String.raw`\b(${[...DENIED_TABLE_FUNCTIONS].join('|')})\b`,
  'gi',
);

/**
 * Deny the entire `pragma_*` namespace. DuckDB rewrites bare PRAGMA statements
 * (e.g. `PRAGMA table_info('t')`) into `SELECT * FROM pragma_table_info('t')`,
 * which types as SELECT and would otherwise pass `assertSelectOnly`. Covering
 * the namespace with a prefix regex rather than an enumerated set ensures new
 * pragma metadata TVFs DuckDB adds in future versions are also blocked.
 *
 * Two forms match the two scan layers:
 * - `DENIED_PRAGMA_CALL_REGEX` — call shape (`pragma_<name>(`) for the text scan
 * - `DENIED_PRAGMA_BARE_REGEX` — bare name for the plan-walk rescan on metadata fields
 *
 * See https://github.com/cyanheads/mcp-ts-core/issues/210.
 */
const DENIED_PRAGMA_CALL_REGEX = /\b(pragma_\w+)\s*\(/gi;
const DENIED_PRAGMA_BARE_REGEX = /\b(pragma_\w+)\b/gi;

/** Plan-node string fields where DuckDB stores lowered table-function names. */
const FUNCTION_METADATA_KEYS: ReadonlySet<string> = new Set([
  'extra_info',
  'function',
  'function_name',
  'table_function',
  'source',
]);

/**
 * Strip SQL block and line comments.
 *
 * The block-comment pass is an index walk rather than a lazy-quantifier
 * replace. `/\/\*[\s\S]*?\*\//g` takes time quadratic in the input on an
 * unterminated block opener followed by many further openers, and the SQL
 * reaching this gate is client-supplied (CodeQL `js/polynomial-redos`).
 *
 * Semantics are unchanged: the first block terminator after each opener closes
 * it, an unterminated opener is left in place along with everything after it,
 * and line comments are stripped in a second pass rather than interleaved — so
 * a `--` inside a block comment disappears with the block, and a block opener
 * inside a line comment never opens one.
 */
function stripSqlComments(sql: string): string {
  let stripped = '';
  let cursor = 0;
  for (;;) {
    const open = sql.indexOf('/*', cursor);
    if (open === -1) break;
    const close = sql.indexOf('*/', open + 2);
    if (close === -1) break;
    stripped += `${sql.slice(cursor, open)} `;
    cursor = close + 2;
  }
  return `${stripped}${sql.slice(cursor)}`.replace(/--[^\n]*/g, '');
}

/**
 * Strip standard SQL string literals. Doesn't handle E-strings or DuckDB
 * dollar-quoting; the plan-walk rescan catches anything that survives.
 */
function stripSqlStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Layer 1: pre-EXPLAIN function deny-list. Scans the SQL (string literals
 * stripped) for calls to any function in {@link DENIED_TABLE_FUNCTIONS} or the
 * `pragma_*` namespace so a malicious `read_json('/etc/passwd')` or
 * `pragma_table_info('t')` is rejected before reaching the planner.
 */
export function assertNoDeniedFunctions(sql: string): void {
  if (typeof sql !== 'string' || sql.length === 0) return;
  const stripped = stripSqlStringLiterals(stripSqlComments(sql));
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
    throw deniedFunctionError(
      fn,
      `Canvas query references disallowed table function: ${fn}. PRAGMA metadata functions are not permitted.`,
    );
  }
}

/** The `denied_function` rejection naming `fn`. */
function deniedFunctionError(fn: string, message: string) {
  return validationError(message, {
    reason: SQL_GATE_REASONS.deniedFunction,
    function: fn,
    ...gateRecovery(SQL_GATE_REASONS.deniedFunction),
  });
}

/** The rejection message for a call to a {@link DENIED_TABLE_FUNCTIONS} reader. */
function deniedTableFunctionMessage(fn: string): string {
  return `Canvas query references disallowed table function: ${fn}. File-reading and external-data functions are not permitted.`;
}

/**
 * Functions refused by name in the parsed statement, beyond
 * {@link DENIED_TABLE_FUNCTIONS}: the scalars that read an engine setting, and
 * `query` and `query_table`, which run SQL or name a table from a string.
 * DuckDB resolves these while binding, so the plan never names them. `query`
 * is admitted over a single plain string literal, whose SQL the caller of
 * {@link assertNoDeniedParsedFunctions} gates as its own statement.
 *
 * Last derived against `duckdb_functions()` on DuckDB v1.5.6:
 * `current_setting` reads any setting; `current_schema`, `current_schemas`,
 * and `in_search_path` read the `schema` / `search_path` settings. The
 * settings table functions (`duckdb_settings`, `duckdb_profiling_settings`)
 * plan as their own operators, which {@link ALLOWED_PLAN_OPERATORS} excludes.
 * Re-derive alongside {@link DENIED_TABLE_FUNCTIONS}.
 */
export const DENIED_PARSED_FUNCTIONS: ReadonlySet<string> = new Set([
  'current_setting',
  'current_schema',
  'current_schemas',
  'in_search_path',
  'query',
  'query_table',
]);

/**
 * Names DuckDB binds as a function call when written bare, without
 * parentheses: an unqualified column reference of one of these names, quoted
 * or not and in any case, reads the function whenever no column of that name
 * is in scope. The parse tree writes it as a one-part `COLUMN_REF`, so only
 * the name says it may be a call.
 *
 * Last derived against DuckDB v1.5.6 (`GetSQLValueFunctionName`) by running
 * `SELECT <name>` for every name `duckdb_functions()` lists plus these: these
 * bind and no other name does. Re-derive alongside
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
 * {@link DENIED_PARSED_FUNCTIONS} — on DuckDB v1.5.6, `current_schema` alone.
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
 * Layer 4: reject a call to any function in {@link DENIED_PARSED_FUNCTIONS}
 * or {@link DENIED_TABLE_FUNCTIONS} anywhere in `parseTree`, the statement as
 * DuckDB's `json_serialize_sql` parses it, and an unqualified column reference
 * named in {@link DENIED_BARE_KEYWORDS}. A call is any object carrying a
 * string `function_name`; string constants and other column references never
 * carry one, so a name that appears only as data passes.
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
  throw deniedFunctionError(
    fn,
    form === 'bare'
      ? `Canvas query references disallowed function: ${fn}. DuckDB reads an unqualified ${fn} as that function, written without parentheses; to read a staged column named ${fn}, qualify it with its table (<table>.${fn}).`
      : DENIED_TABLE_FUNCTIONS.has(fn)
        ? deniedTableFunctionMessage(fn)
        : `Canvas query references disallowed function: ${fn}. Functions that read engine settings, or run SQL or name a table from a string, are not permitted.`,
  );
}

/**
 * The first denied name a depth-first walk of `node` reaches, called or bare,
 * collecting into `literals` the SQL of each `query` call it admits.
 */
function findDeniedCall(node: unknown, literals: string[]): DeniedReference | undefined {
  if (node === null || typeof node !== 'object') return;
  const call = node as {
    children?: unknown;
    class?: unknown;
    column_names?: unknown;
    function_name?: unknown;
  };
  if (typeof call.function_name === 'string') {
    const fn = call.function_name.toLowerCase();
    const literal = fn === 'query' ? soleStringLiteral(call.children) : undefined;
    if (literal !== undefined) literals.push(literal);
    else if (DENIED_PARSED_FUNCTIONS.has(fn) || DENIED_TABLE_FUNCTIONS.has(fn)) {
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
 * The string of `args` when it is exactly one unnamed, non-null `VARCHAR`
 * constant, as `json_serialize_sql` on DuckDB v1.5.6 serializes a string
 * literal; `undefined` for any other shape.
 */
function soleStringLiteral(args: unknown): string | undefined {
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
 * subject is a reference like any other.
 *
 * A CTE whose name holds a dot is refused too: the parse tree writes a CTE
 * reference as a `BASE_TABLE` like any other, and exempting the names a
 * statement's `cte_map`s define would also admit a same-named reference
 * outside that CTE's scope, which DuckDB reads as a file.
 */
export function findFileReference(parseTree: unknown): string | undefined {
  if (parseTree === null || typeof parseTree !== 'object') return;
  const ref = parseTree as {
    catalog_name?: unknown;
    schema_name?: unknown;
    table_name?: unknown;
    type?: unknown;
  };
  if (ref.type === 'BASE_TABLE' && typeof ref.table_name === 'string') {
    const qualifiers = [ref.catalog_name, ref.schema_name].filter(
      (part): part is string => typeof part === 'string' && part !== '',
    );
    if (
      ref.table_name.includes('.') ||
      qualifiers.some((part) => !DATABASE_QUALIFIERS.has(part.toLowerCase()))
    ) {
      return [...qualifiers, ref.table_name].join('.');
    }
  }
  for (const value of Object.values(parseTree)) {
    const found = findFileReference(value);
    if (found !== undefined) return found;
  }
  return;
}

/**
 * System-catalog namespace patterns for the text-scan deny layer.
 *
 * Covers bare and dotted references to `information_schema`, `pg_catalog`,
 * `sqlite_master` (all three are reachable via DuckDB compatibility layers)
 * plus the `duckdb_<name>(` call namespace. String literals are stripped
 * before the scan so quoted catalog names do not false-positive.
 *
 * Two forms to cover how each namespace can appear in SQL:
 * - `information_schema.` / `pg_catalog.` — schema-qualified table or view
 *   reference; bare `information_schema` alone selects the schema namespace.
 * - `sqlite_master` — bare table name (no dot required).
 * - `duckdb_<word>(` — metadata TVF call shape (e.g. `duckdb_tables()`).
 */
const SYSTEM_CATALOG_REGEX =
  /\b(information_schema|pg_catalog)\b|\bsqlite_master\b|\b(duckdb_\w+)\s*\(/gi;

/**
 * Optional gate layer: reject references to system catalog namespaces.
 *
 * Enable via `QueryOptions.denySystemCatalogs` or
 * `RegisterViewOptions.denySystemCatalogs` on servers that use a hidden shared
 * canvas where handle possession is the access boundary. When enabled, any
 * reference to `information_schema`, `pg_catalog`, `sqlite_master`, or
 * `duckdb_<name>()` throws `ValidationError` with
 * `data.reason: 'system_catalog_access'`.
 *
 * Callers strip comments and string literals before this scan (identical
 * pre-processing to {@link assertNoDeniedFunctions}).
 */
export function assertNoSystemCatalogs(sql: string): void {
  if (typeof sql !== 'string' || sql.length === 0) return;
  const stripped = stripSqlStringLiterals(stripSqlComments(sql));
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
 * Combined plan-walk: disallowed operators and deny-listed table-function
 * references in string-valued fields, returned separately so callers can word
 * errors appropriately.
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
  if (operator !== undefined && !ALLOWED_PLAN_OPERATORS.has(operator)) {
    offending.add(operator);
  }
  // read_json/read_parquet lower into generic scan operators whose source
  // function appears in plan metadata, not the operator name. Use the bare
  // regex on known function-name fields, the call-shape regex elsewhere.
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
