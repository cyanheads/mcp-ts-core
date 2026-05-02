/**
 * @fileoverview Read-only SQL gate for the DataCanvas primitive. Engine-agnostic
 * pure validators that the provider invokes after pulling DuckDB-specific
 * metadata (statement extraction, prepared-statement type, EXPLAIN plan JSON).
 *
 * Three layers of enforcement, each authoritative on its own:
 *
 * 1. **Single-statement check.** The provider parses the input via DuckDB's
 *    `extractStatements` and passes the count here. Anything other than 1 is
 *    rejected — comment-hidden second statements, multi-statement smuggling,
 *    and Unicode tricks all collapse here because DuckDB's parser is the
 *    arbiter, not a regex.
 * 2. **Statement-type check.** The provider prepares the single statement and
 *    passes the resulting `statementType`. We require `SELECT`. Any DDL, DML,
 *    or utility (PRAGMA/ATTACH/COPY/INSTALL/LOAD/SET/EXECUTE) fails to type as
 *    SELECT and is rejected here.
 * 3. **Plan-walk allowlist.** The provider runs `EXPLAIN (FORMAT JSON)` and
 *    passes the plan JSON. We walk every node and reject if any operator
 *    name is outside the curated allowlist — defense-in-depth against future
 *    DuckDB additions that might smuggle work into a SELECT envelope.
 *
 * Rejection paths throw `ValidationError` with a structured `data.reason`
 * suitable for surfacing to the agent.
 *
 * @module src/canvas/core/sqlGate
 */

import { validationError } from '@/types-global/errors.js';

/**
 * DuckDB statement-type strings emitted by the Neo client. Only `SELECT` is
 * accepted by the canvas. Other values (`INSERT`, `UPDATE`, `DELETE`,
 * `CREATE`, `DROP`, `ALTER`, `COPY`, `PRAGMA`, `ATTACH`, `DETACH`, `LOAD`,
 * `INSTALL`, `SET`, `RESET`, `EXECUTE`, `EXPLAIN`, `TRANSACTION`, `VACUUM`,
 * `CHECKPOINT`, `CALL`, …) are rejected outright. This is a surface — not
 * an enum we own — so the gate matches on the literal string emitted.
 */
export type DuckdbStatementType = string;

/** Subset of statement types the gate permits. */
export const ALLOWED_STATEMENT_TYPES: ReadonlySet<DuckdbStatementType> = new Set(['SELECT']);

/**
 * Curated allowlist of operator names that can appear in an EXPLAIN plan.
 * Sourced from DuckDB's logical/physical-plan node families (1.5.x). Not
 * every member is reachable from a SELECT — but every member is read-only.
 *
 * Pinned by `tests/canvas/sqlGate.fixtures.test.ts` against live DuckDB
 * EXPLAIN output so version bumps that add operators are caught in CI rather
 * than silently widening the gate.
 *
 * Operators **not** in this list cause rejection. Notable exclusions:
 *
 * - `READ_CSV`, `READ_PARQUET`, `READ_JSON` — bypass canvas, read external files.
 * - `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE_*`, `DROP_*`, `ALTER_*` — writes.
 * - `COPY_TO_FILE`, `BATCH_COPY_TO_FILE` — exports a SELECT to a file.
 * - `ATTACH`, `DETACH`, `LOAD`, `INSTALL`, `PRAGMA`, `SET`, `RESET` — utility.
 */
export const ALLOWED_PLAN_OPERATORS: ReadonlySet<string> = new Set([
  // Scans (registered tables only — file scans like READ_CSV are excluded)
  'SEQ_SCAN',
  'COLUMN_DATA_SCAN',
  'CHUNK_SCAN',
  'EXPRESSION_SCAN',
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
  'UNION',
  // Sorting / limits
  'ORDER_BY',
  'TOP_N',
  'LIMIT',
  'LIMIT_PERCENT',
  'STREAMING_LIMIT',
  // Window
  'WINDOW',
  // Nested
  'UNNEST',
  // CTEs
  'CTE',
  'CTE_REF',
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
]);

/**
 * Public entry point — validates the trio of `(statementCount, statementType,
 * planJson)`. Throws on the first violation, leaving the provider to pass
 * results back to the caller untouched on success.
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
 * Pre-EXPLAIN gate: validate statement count and type. Run before the EXPLAIN
 * call so non-SELECT statements (which DuckDB's EXPLAIN can't always wrap —
 * e.g. ATTACH/PRAGMA/COPY/INSTALL) fail with a structured ValidationError
 * here rather than a confusing parser error from EXPLAIN itself.
 */
export function assertSelectOnly(input: {
  statementCount: number;
  statementType: DuckdbStatementType;
}): void {
  if (input.statementCount !== 1) {
    throw validationError('Canvas query must contain exactly one SQL statement.', {
      reason: 'multi_statement',
      statementCount: input.statementCount,
    });
  }
  if (!ALLOWED_STATEMENT_TYPES.has(input.statementType)) {
    throw validationError(
      `Canvas query must be SELECT; got ${input.statementType}. Mutations must use registerTable, drop, or clear.`,
      { reason: 'non_select_statement', statementType: input.statementType },
    );
  }
}

/**
 * Post-EXPLAIN gate: walk the plan tree and reject any operator outside the
 * curated allowlist. Defense-in-depth against future DuckDB additions that
 * smuggle work into a SELECT envelope.
 */
export function assertPlanReadOnly(planJson: unknown): void {
  const offending = collectDisallowedOperators(planJson);
  if (offending.size > 0) {
    throw validationError(
      `Canvas query contains disallowed operators: ${[...offending].sort().join(', ')}.`,
      {
        reason: 'plan_operator_not_allowed',
        operators: [...offending].sort(),
      },
    );
  }
}

/**
 * Walks the EXPLAIN plan and returns the set of operator names not in
 * `ALLOWED_PLAN_OPERATORS`. Exported for fixture-driven tests that want
 * to inspect the gate's view of a plan without throwing.
 *
 * Tolerant of structural variation — DuckDB emits operator identity under
 * either `name` (logical plan) or `operator_type` (physical/profile plan)
 * depending on the EXPLAIN flavor. We honor both. Children traversal
 * supports `children`, `child`, and `inputs` arrays.
 */
export function collectDisallowedOperators(planJson: unknown): Set<string> {
  const offending = new Set<string>();
  walk(planJson, offending);
  return offending;
}

function walk(node: unknown, offending: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, offending);
    return;
  }
  const obj = node as Record<string, unknown>;
  const operator = readOperatorName(obj);
  if (operator !== undefined && !ALLOWED_PLAN_OPERATORS.has(operator)) {
    offending.add(operator);
  }
  // Traverse known child slots; ignore string/number leaves.
  for (const key of ['children', 'child', 'inputs', 'plan', 'root']) {
    if (key in obj) walk(obj[key], offending);
  }
}

function readOperatorName(obj: Record<string, unknown>): string | undefined {
  const candidates = ['name', 'operator_type', 'operator', 'type'];
  for (const key of candidates) {
    const value = obj[key];
    if (typeof value === 'string' && value !== '') {
      return value.toUpperCase();
    }
  }
  return;
}

// ---------------------------------------------------------------------------
// Identifier validation and quoting
// ---------------------------------------------------------------------------

/**
 * Allowed shape for canvas-local table and column names. Matches the
 * conservative SQL identifier convention: starts with letter/underscore,
 * followed by letters/digits/underscores, max 63 chars (PostgreSQL/DuckDB cap).
 */
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * DuckDB reserved words that must not be used as bare identifiers. Not
 * exhaustive — this is a courtesy guard so misnamed tables fail at register
 * time rather than confusing-error time. The `IDENTIFIER_REGEX` is the
 * authoritative shape gate.
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

/**
 * Validate an identifier for use as a canvas-local table or column name.
 * Throws `ValidationError` on rejection.
 */
export function assertValidIdentifier(value: string, kind: 'table' | 'column'): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`Canvas ${kind} name must be a non-empty string.`, {
      reason: 'identifier_empty',
      kind,
    });
  }
  if (!IDENTIFIER_REGEX.test(value)) {
    throw validationError(
      `Canvas ${kind} name "${value}" is invalid. Use letters, digits, and underscores; must start with a letter or underscore; max 63 chars.`,
      { reason: 'identifier_shape', kind, value },
    );
  }
  if (RESERVED_IDENTIFIERS.has(value.toLowerCase())) {
    throw validationError(
      `Canvas ${kind} name "${value}" is a reserved SQL keyword. Choose another name.`,
      { reason: 'identifier_reserved', kind, value },
    );
  }
}

/**
 * Wrap an identifier in double quotes for safe inclusion in SQL. Internal
 * double quotes are doubled per the SQL standard. Callers should still
 * validate via {@link assertValidIdentifier} before quoting — this helper
 * only escapes; it does not validate shape.
 */
export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
