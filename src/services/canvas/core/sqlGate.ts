/**
 * @fileoverview Read-only SQL gate for the DataCanvas primitive. Engine-agnostic
 * pure validators the provider invokes after pulling DuckDB-specific metadata.
 *
 * Four layers of enforcement, each authoritative:
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
 * 4. **Plan-walk allowlist + denied-function rescan.** Walk the
 *    `EXPLAIN (FORMAT JSON)` tree; reject any operator outside the allowlist
 *    or any string field referencing a deny-listed function.
 *
 * Rejection paths throw `ValidationError` with a structured `data.reason`.
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
  planOperatorNotAllowed: 'plan_operator_not_allowed',
  deniedFunction: 'denied_function',
  deniedFunctionInPlan: 'denied_function_in_plan',
  identifierEmpty: 'identifier_empty',
  identifierShape: 'identifier_shape',
  identifierReserved: 'identifier_reserved',
} as const;

/** Union of all gate reason strings — see {@link SQL_GATE_REASONS}. */
export type SqlGateReason = (typeof SQL_GATE_REASONS)[keyof typeof SQL_GATE_REASONS];

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
 * Source pinned against `PhysicalOperatorToString` in DuckDB v1.5.2:
 * https://github.com/duckdb/duckdb/blob/v1.5.2/src/common/enums/physical_operator_type.cpp
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
 */
export const DENIED_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  // CSV
  'read_csv',
  'read_csv_auto',
  'sniff_csv',
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
  'parquet_kv_metadata',
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

/** Plan-node string fields where DuckDB stores lowered table-function names. */
const FUNCTION_METADATA_KEYS: ReadonlySet<string> = new Set([
  'extra_info',
  'function',
  'function_name',
  'table_function',
  'source',
]);

/** Strip SQL block and line comments. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
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
 * stripped) for calls to any function in {@link DENIED_TABLE_FUNCTIONS} so a
 * malicious `read_json('/etc/passwd')` is rejected before reaching the planner.
 */
export function assertNoDeniedFunctions(sql: string): void {
  if (typeof sql !== 'string' || sql.length === 0) return;
  const stripped = stripSqlStringLiterals(stripSqlComments(sql));
  DENIED_FUNCTION_CALL_REGEX.lastIndex = 0;
  const match = DENIED_FUNCTION_CALL_REGEX.exec(stripped);
  if (match?.[1]) {
    const fn = match[1].toLowerCase();
    throw validationError(
      `Canvas query references disallowed table function: ${fn}. File-reading and external-data functions are not permitted.`,
      { reason: SQL_GATE_REASONS.deniedFunction, function: fn },
    );
  }
}

/**
 * Layers 2-4. Throws on the first violation. Layer 1
 * ({@link assertNoDeniedFunctions}) runs separately before `extractStatements`.
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
    });
  }
  if (!ALLOWED_STATEMENT_TYPES.has(input.statementType)) {
    throw validationError(
      `Canvas query must be SELECT; got ${input.statementType}. Mutations must use registerTable, drop, or clear.`,
      { reason: SQL_GATE_REASONS.nonSelectStatement, statementType: input.statementType },
    );
  }
}

/**
 * Layer 4: walk the plan tree and reject any operator outside the allowlist
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
      },
    );
  }
  if (offending.size > 0) {
    throw validationError(
      `Canvas query contains disallowed operators: ${[...offending].sort().join(', ')}.`,
      {
        reason: SQL_GATE_REASONS.planOperatorNotAllowed,
        operators: [...offending].sort(),
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
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') continue;
    const regex = FUNCTION_METADATA_KEYS.has(key)
      ? DENIED_FUNCTION_BARE_REGEX
      : DENIED_FUNCTION_CALL_REGEX;
    collectDeniedFunctionMatches(value, regex, deniedFunctions);
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
    });
  }
  if (!CANVAS_IDENTIFIER_REGEX.test(value)) {
    throw validationError(
      `Canvas ${kind} name "${value}" is invalid. Use letters, digits, and underscores; must start with a letter or underscore; max 63 chars.`,
      { reason: SQL_GATE_REASONS.identifierShape, kind, value },
    );
  }
  if (RESERVED_IDENTIFIERS.has(value.toLowerCase())) {
    throw validationError(
      `Canvas ${kind} name "${value}" is a reserved SQL keyword. Choose another name.`,
      { reason: SQL_GATE_REASONS.identifierReserved, kind, value },
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
