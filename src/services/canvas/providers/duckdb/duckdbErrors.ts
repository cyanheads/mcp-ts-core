/**
 * @fileoverview How the DuckDB canvas provider reports a failure: DuckDB's
 * error classes, read from the message prefix and mapped to framework errors
 * with the recovery each class calls for, and the structured rejections the
 * provider raises itself — a missing table, a name already staged, a view that
 * cannot be read, an export out of memory. Host directories are redacted from
 * every message, and a table or view name a message quotes is passed as
 * `literals`, so a tool's `content[]` renders it as code the caller can copy.
 * @module src/services/canvas/providers/duckdb/duckdbErrors
 */

import { databaseError, McpError, notFound, validationError } from '@/types-global/errors.js';

import { gateRecovery, SQL_GATE_REASONS } from '../../core/sqlGate.js';
import type { ExportFormat } from '../../types.js';

/**
 * The engine classes a view's own definition fails with when it is read against
 * the canvas as now staged: a table or column it reads is gone, it reads itself,
 * a function rejects an argument it passes, or a value it converts does not
 * fit. Anything else a read raises — an I/O or memory fault, an interrupt — is
 * the engine's, not the view's.
 */
export const VIEW_READ_FAILURE =
  /^(?:Catalog|Binder|Conversion|Invalid Input|Out of Range) Error\b/;

/** The recovery for a view that cannot be read: the two ways to make describe() answer again. */
const VIEW_UNREADABLE_RECOVERY =
  'Drop each view the message names, or define it again over the tables as now staged.';

/**
 * The rejection for a describe() that could not read the views in `views`:
 * each named with the engine's own message, every `redact` path in it replaced
 * with `[path]`; the raw engine errors stay on `cause`.
 */
export function viewUnreadableError(
  views: readonly { error: Error; name: string }[],
  redact: readonly string[],
): McpError {
  const named = views.map(({ error, name }) => ({
    name,
    engineMessage: redactPaths(error.message.trim(), redact),
  }));
  return validationError(
    `Canvas ${named.length === 1 ? 'view' : 'views'} could not be read: ${named.map((view) => `"${view.name}" — ${view.engineMessage}`).join('; ')}`,
    {
      reason: DUCKDB_ERROR_REASONS.viewUnreadable,
      views: named,
      recovery: { hint: VIEW_UNREADABLE_RECOVERY },
    },
    {
      cause: new AggregateError(
        views.map(({ error }) => error),
        'Canvas views could not be read.',
      ),
      literals: named.map((view) => view.name),
    },
  );
}

/**
 * The qualified name a catalog table miss reports, as the parse tree joins it;
 * `undefined` for any other failure. DuckDB writes the name bare before `does
 * not exist!`, and quoted before `does not exist because` a schema or catalog
 * is missing.
 */
export function catalogMissName(message: string): string | undefined {
  const match = /^Catalog Error: Table with name (.+) does not exist(!| because )/.exec(message);
  if (match?.[1] === undefined) return;
  return match[2] === '!' ? match[1] : match[1].replace(/^"(.*)"$/, '$1');
}

/**
 * Replace every occurrence of each host directory in an engine message with
 * `[path]`, longest first so a directory nested inside another is redacted
 * whole. DuckDB quotes the absolute export and scratch paths it failed on;
 * the part below the directory — the caller's own export name — stays. A
 * one-character path (the filesystem root) is skipped, since replacing it
 * would mangle every path in the message.
 */
export function redactPaths(message: string, paths: readonly string[]): string {
  return paths
    .filter((path) => path.length > 1)
    .sort((a, b) => b.length - a.length)
    .reduce((text, path) => text.replaceAll(path, '[path]'), message);
}

/**
 * Reason codes {@link classifyDuckdbError} sets on `data.reason`, the one
 * `describe()` sets on a view it cannot read, and the one `export()` sets when
 * the engine runs out of memory. Exported
 * alongside {@link SQL_GATE_REASONS} so a canvas-consuming tool can map an
 * engine failure onto an `errors[]` entry without duplicating the strings.
 */
export const DUCKDB_ERROR_REASONS = {
  /** SQL the engine could not parse. */
  sqlParseError: 'sql_parse_error',
  /**
   * A write the engine refused, or a statement naming a file — refused by the
   * engine's configuration or by the gate — never the operating system
   * refusing a file, which is an I/O fault.
   */
  sqlReadOnly: 'sql_read_only',
  /**
   * A gated SELECT, or a view an export or import reads, that prepared cleanly
   * and then failed while it ran: on the staged data, or on an argument a
   * function rejects as it runs.
   */
  sqlExecutionError: 'sql_execution_error',
  /**
   * `describe()` read a view whose own definition fails against the tables as
   * now staged; `data.views` names each such view with the engine's message.
   */
  viewUnreadable: 'view_unreadable',
  /**
   * An export the engine ran out of memory writing, a `DatabaseError` whose
   * `data.format` names the format and whose hint says what fits: the rows are
   * too wide for the slice an export holds at once.
   */
  exportOutOfMemory: 'export_out_of_memory',
} as const;

/** Union of the engine-error reason strings — see {@link DUCKDB_ERROR_REASONS}. */
export type DuckdbErrorReason = (typeof DUCKDB_ERROR_REASONS)[keyof typeof DUCKDB_ERROR_REASONS];

/**
 * The recovery for SQL the engine could not parse, whether the statement is
 * refused as `sql_parse_error` or, SELECT-shaped, as `invalid_sql`. DuckDB v1.5
 * reads some keywords (`rows`, `name`) as an alias only after `AS`.
 */
const SQL_PARSE_RECOVERY =
  'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.';

/** The recovery for a write or a file read: what this surface can do instead. */
export const SQL_READ_ONLY_RECOVERY =
  "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.";

/**
 * The recovery for a constant in the SQL that a function rejects — a regex
 * pattern, a format string, a date part specifier — when the engine rejects it
 * as the statement is prepared.
 */
const CONSTANT_ARGUMENT_RECOVERY =
  'Correct the argument value the message names — a pattern, format string, or other constant the function cannot accept.';

/**
 * DuckDB's execution-error classes, the split its own `Exception::
 * IsExecutionError` makes: CONVERSION, INVALID_INPUT, OUT_OF_RANGE. The SQL
 * prepared, so the fault is in the data the caller asked the engine to
 * process, not in the engine — or in a constant argument a function rejects
 * only as it runs, which the message does not tell apart from a row's value.
 *
 * BINDER joins them because a binder error that reaches the classifier was
 * raised while a prepared statement ran: the gate refuses a SELECT that fails
 * to prepare as `invalid_sql` before anything runs. Two sources remain, both
 * the caller's SQL: a table function rejecting its arguments as it runs (a
 * zero step or an infinite bound in `range` or `generate_series`), and a view
 * bound by an export or import after the table it reads was staged again
 * without the column it names.
 *
 * `@duckdb/node-api` surfaces a bare `Error` — no `errorType`, no `code` — and
 * `@duckdb/node-bindings` binds neither `duckdb_error_data_error_type` nor
 * `duckdb_result_error_type`, so the leading class prefix is the only
 * discriminator available in process. It is anchored at the start on purpose:
 * `Out of Range Error` and `Out of Memory Error` land on opposite sides of the
 * split and diverge only after `Out of `, and an engine fault whose message
 * merely quotes a data-error class mid-sentence is still an engine fault.
 */
const DUCKDB_EXECUTION_ERROR_PREFIX = /^(Conversion|Invalid Input|Out of Range|Binder) Error\b/;

/** A class {@link DUCKDB_EXECUTION_ERROR_PREFIX} captures. */
type ExecutionErrorClass = 'Conversion' | 'Invalid Input' | 'Out of Range' | 'Binder';

/** The `sql_execution_error` recovery per execution-error class, each the fix that class calls for. */
const EXECUTION_ERROR_RECOVERY: Record<ExecutionErrorClass, string> = {
  Conversion:
    'Wrap the cast in TRY_CAST, or filter out the rows the message names before converting them.',
  'Invalid Input':
    'Correct the argument the message names if it is a constant in the SQL, such as a regex pattern or format string; otherwise filter out the rows whose values the function cannot read, or use the function’s TRY variant where it has one, such as TRY_CAST or TRY_STRPTIME.',
  'Out of Range':
    'Cast to a wider type such as HUGEINT or DOUBLE before the arithmetic that overflows, or filter out the rows whose values are out of range.',
  Binder:
    'Correct the argument the message names, such as a zero step or an infinite bound in range or generate_series. When it names a column, define the view that reads it again over the tables as now staged.',
};

/**
 * DuckDB's refusals, anchored on the class prefix the engine gives them:
 * `Permission Error` (file access with `enable_external_access` off), and a
 * write attempted in a read-only transaction (`TransactionContext Error: …
 * read-only mode`) or against a read-only database (`Invalid Input Error: …
 * attached in read-only mode!`). An `IO Error` never matches, whatever its
 * text: `Permission denied` and `Read-only file system` there are the
 * operating system refusing a file, an engine fault the caller cannot act on.
 */
const DUCKDB_REFUSAL =
  /^(?:Permission Error\b|(?:TransactionContext|Invalid Input) Error: .*\bread-only mode\b)/;

/**
 * DuckDB's parser class, bare as `run()` reports it or behind the wrapper
 * `@duckdb/node-api` puts on a statement-extraction failure (`extractStatements()`,
 * and `start()` through it). Anchored like the other classes: a quoted file
 * name mentioning "syntax" is not one.
 */
const DUCKDB_PARSER_ERROR_PREFIX = /^(?:Failed to extract statements: )?Parser Error\b/;

/**
 * The classes, other than the parser's, that fail a SELECT while it is
 * prepared and each call for their own recovery. A `Conversion Error` raised
 * then comes from a constant the engine folds, such as a `date_trunc`
 * specifier, since no row has been read. A `Binder Error` — an unknown column,
 * a grouping or signature mismatch — and anything else take the `invalid_sql`
 * reason's own hint.
 */
const PREPARE_ERROR_CLASS = /^(Catalog|Conversion|Invalid Input|IO) Error\b/;

/** A class {@link PREPARE_ERROR_CLASS} captures. */
type PrepareErrorClass = 'Catalog' | 'Conversion' | 'Invalid Input' | 'IO';

/** The `invalid_sql` recovery per prepare-time class, each the fix that class calls for. */
const PREPARE_ERROR_RECOVERY: Record<PrepareErrorClass, string> = {
  Catalog:
    "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.",
  Conversion: CONSTANT_ARGUMENT_RECOVERY,
  'Invalid Input': CONSTANT_ARGUMENT_RECOVERY,
  IO: SQL_READ_ONLY_RECOVERY,
};

/**
 * A catalog miss naming a table bare, as DuckDB reports one an executing
 * statement could not find. Anchored, so an engine fault quoting it
 * mid-message stays a fault; a schema miss ends `does not exist because` and
 * never matches.
 */
const DUCKDB_MISSING_TABLE = /^Catalog Error: Table with name (.+?) does not exist!/;

/**
 * DuckDB's out-of-memory class, which can carry {@link DUCKDB_TUNING_ADVICE}:
 * by its name, or from the appender, which reports the engine's message
 * without its class, by the allocation it failed.
 */
const DUCKDB_OUT_OF_MEMORY_PREFIX =
  /^(?:Out of Memory Error\b|Failed to append: (?:could not|failed to) allocate\b)/;

/**
 * Where the advice DuckDB appends to an out-of-memory message starts: `SET`
 * statements for threads, insertion order, and the memory limit, each one a
 * canvas refuses, so a caller can act on none of it.
 */
const DUCKDB_TUNING_ADVICE = '\n\nPossible solutions:';

/**
 * The `export_out_of_memory` recovery per format. Every export writes from one
 * engine thread, 2,048 rows at a time; a CSV export holds about three copies of
 * that slice as text and a JSON export about 13, which is why only JSON's hint
 * names a cheaper format.
 */
const EXPORT_OUT_OF_MEMORY_RECOVERY: Record<ExportFormat, string> = {
  json: 'A JSON export needs roughly 26 MB of canvas memory per KB of row width, since it holds about 13 copies of 2,048 rows as JSON text at once. Export as CSV or Parquet, which need far less, or export a selection that leaves out the widest columns.',
  csv: 'The export holds 2,048 rows in memory at a time, and rows this wide do not fit in the canvas memory limit. Export a selection that leaves out the widest columns, or ask the operator to raise CANVAS_DEFAULT_MEMORY_LIMIT_MB.',
  parquet:
    'The export holds 2,048 rows in memory at a time, and rows this wide do not fit in the canvas memory limit. Export a selection that leaves out the widest columns, or ask the operator to raise CANVAS_DEFAULT_MEMORY_LIMIT_MB.',
};

/**
 * `err`, an export's failure as {@link classifyDuckdbError} left it, as
 * `export_out_of_memory` when the engine ran out of memory: the first line of
 * the engine's message, `format`, and that format's hint, with the raw engine
 * error on `cause`. Any other failure as it came.
 */
export function exportOutOfMemory(err: unknown, format: ExportFormat): unknown {
  if (!(err instanceof McpError) || !DUCKDB_OUT_OF_MEMORY_PREFIX.test(err.message)) return err;
  const lineEnd = err.message.indexOf('\n');
  return databaseError(
    lineEnd === -1 ? err.message : err.message.slice(0, lineEnd),
    {
      reason: DUCKDB_ERROR_REASONS.exportOutOfMemory,
      format,
      recovery: { hint: EXPORT_OUT_OF_MEMORY_RECOVERY[format] },
    },
    { cause: err.cause },
  );
}

/**
 * The `missing_table` `NotFound` for a canvas table that does not exist, as
 * `query()` gives a statement naming one and an export or import gives a view
 * whose table was dropped.
 */
export function missingTableError(tableName: string, cause: unknown): McpError {
  return notFound(
    `Canvas table "${tableName}" does not exist. The table may have expired, been dropped, or the name may be mistyped.`,
    {
      reason: 'missing_table',
      tableName,
      recovery: {
        hint: "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
      },
    },
    { cause, literals: [tableName] },
  );
}

/**
 * The engine's refusal of a `CREATE TABLE … AS` whose name another object
 * already holds: a table or view committed under it in any letter case, or a
 * table another transaction is still creating. A CTAS writes only its own
 * target's catalog entry, so either refusal is about that name. Read only at
 * the CTAS: the same texts from any other statement are a concurrent write,
 * which stays a `DatabaseError`.
 */
const CTAS_NAME_TAKEN =
  /^(?:Catalog Error: (?:Table|View) with name .+ already exists!|TransactionContext Error: Catalog write-write conflict on )/;

/** Whether `err` is a `CREATE TABLE … AS` refused because its name is taken — see {@link CTAS_NAME_TAKEN}. */
export function isCtasNameTaken(err: unknown): boolean {
  return err instanceof Error && CTAS_NAME_TAKEN.test(err.message);
}

/**
 * The `register_as_clash` rejection for a `query({ registerAs })` whose name a
 * staged table or view already holds, `cause` the engine's refusal when the
 * CTAS raised it.
 */
export function registerAsClash(tableName: string, cause?: unknown): McpError {
  return validationError(
    `Canvas table "${tableName}" already exists. Drop it before reusing the name.`,
    {
      reason: 'register_as_clash',
      tableName,
      recovery: {
        hint: "A table or view with this name is already staged on the canvas. Use another name for the result, or query the staged one if it holds what you need — list what is staged with this server's dataframe-describe tool.",
      },
    },
    cause === undefined ? { literals: [tableName] } : { cause, literals: [tableName] },
  );
}

/**
 * The engine's refusal of `CREATE OR REPLACE VIEW` over a table of the same
 * name in any letter case. DuckDB v2.0 quotes the name and v1.5 does not.
 */
const VIEW_OVER_TABLE =
  /^Catalog Error: Existing object .+ is of type Table, trying to replace with type View/;

/** Whether `err` is a view definition refused because a table holds its name — see {@link VIEW_OVER_TABLE}. */
export function isViewOverTable(err: unknown): boolean {
  return err instanceof Error && VIEW_OVER_TABLE.test(err.message);
}

/**
 * The engine's refusal of `DROP TABLE IF EXISTS` over a view of the same name
 * in any letter case, as an import's replace step meets one. DuckDB v2.0
 * quotes the name and v1.5 does not.
 */
const DROP_OVER_VIEW =
  /^Catalog Error: Existing object .+ is of type View, trying to drop type Table/;

/** Whether `err` is a table drop refused because a view holds the name — see {@link DROP_OVER_VIEW}. */
export function isDropOverView(err: unknown): boolean {
  return err instanceof Error && DROP_OVER_VIEW.test(err.message);
}

/**
 * The `view_table_clash` rejection for a `registerView()` whose name a staged
 * table holds, `cause` the engine's refusal when the view definition raised it.
 */
export function viewTableClash(name: string, cause?: unknown): McpError {
  return validationError(
    `Canvas already contains a base table named "${name}". Drop the table or choose a different name.`,
    {
      reason: 'view_table_clash',
      name,
      recovery: { hint: 'Choose another name for the view, or drop the table first.' },
    },
    cause === undefined ? { literals: [name] } : { cause, literals: [name] },
  );
}

/**
 * The recovery for a SELECT-shaped statement that failed to parse or prepare,
 * by the engine's class prefix on `message`: syntax for a parser error, the
 * class's own fix for a catalog miss, a rejected argument, or a file, and the
 * `invalid_sql` hint for everything else.
 * @internal Exported for unit testing.
 */
export function prepareFailureRecovery(message: string): string {
  if (DUCKDB_PARSER_ERROR_PREFIX.test(message)) return SQL_PARSE_RECOVERY;
  const prepareClass = PREPARE_ERROR_CLASS.exec(message)?.[1] as PrepareErrorClass | undefined;
  return prepareClass === undefined
    ? gateRecovery(SQL_GATE_REASONS.invalidSql).recovery.hint
    : PREPARE_ERROR_RECOVERY[prepareClass];
}

/**
 * Map a DuckDB-thrown error to a framework error class. Classification is for
 * raw engine errors only — an already-structured `McpError` passes through
 * unchanged (#254): structured throws from inside the provider's try blocks
 * (`ensureTableMissing`'s `register_as_clash`, `resolveExportPath`'s path
 * validations) must keep their code and `data.reason` instead of being
 * reclassified as `DatabaseError`.
 *
 * The three caller-side classes are `ValidationError`, each matched on the
 * engine's own class prefix. A table missing while a statement runs — a view
 * an export or import reads, after its table was dropped — is the
 * `missing_table` `NotFound` that `query()` gives one missing at prepare time,
 * so the engine's spelling suggestion never reaches the caller. Everything
 * else — I/O, internal, out-of-memory, transaction conflict, interrupt — stays
 * `DatabaseError`, which is what an export or Parquet round-trip failing on the
 * filesystem must remain (#565); an out-of-memory message is cut before
 * DuckDB's tuning advice. Every `redact` path in the message becomes `[path]`;
 * the raw engine error, paths and advice included, stays on `cause`.
 * @internal Exported for unit testing.
 */
export function classifyDuckdbError(err: unknown, redact: readonly string[] = []): Error {
  if (err instanceof McpError) return err;
  if (err instanceof Error) {
    const msg = redactPaths(err.message, redact);
    // Checked before the execution prefix: a write refused by a read-only
    // database is phrased as an `Invalid Input Error`.
    if (DUCKDB_REFUSAL.test(msg)) {
      return engineFailure(
        DUCKDB_ERROR_REASONS.sqlReadOnly,
        `Canvas SQL rejected: ${msg}`,
        SQL_READ_ONLY_RECOVERY,
        err,
      );
    }
    const executionClass = DUCKDB_EXECUTION_ERROR_PREFIX.exec(msg)?.[1] as
      | ExecutionErrorClass
      | undefined;
    if (executionClass !== undefined) {
      return engineFailure(
        DUCKDB_ERROR_REASONS.sqlExecutionError,
        `Canvas query failed: ${msg}`,
        EXECUTION_ERROR_RECOVERY[executionClass],
        err,
      );
    }
    if (DUCKDB_PARSER_ERROR_PREFIX.test(msg)) {
      return engineFailure(
        DUCKDB_ERROR_REASONS.sqlParseError,
        `Canvas SQL rejected: ${msg}`,
        SQL_PARSE_RECOVERY,
        err,
      );
    }
    const missingTable = DUCKDB_MISSING_TABLE.exec(msg)?.[1];
    if (missingTable !== undefined) return missingTableError(missingTable, err);
    const advice = DUCKDB_OUT_OF_MEMORY_PREFIX.test(msg) ? msg.indexOf(DUCKDB_TUNING_ADVICE) : -1;
    return databaseError(advice === -1 ? msg : msg.slice(0, advice), undefined, { cause: err });
  }
  return databaseError('DuckDB threw a non-Error value.', {
    value: redactPaths(String(err), redact),
  });
}

/** A caller-side engine failure: reason, recovery, and the engine error chained. */
function engineFailure(
  reason: DuckdbErrorReason,
  message: string,
  hint: string,
  cause: Error,
): McpError {
  return validationError(message, { reason, recovery: { hint } }, { cause });
}
