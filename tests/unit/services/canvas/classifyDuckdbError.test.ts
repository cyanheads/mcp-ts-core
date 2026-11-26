/**
 * @fileoverview Tests for the DuckDB error classifier. Pins the user-facing
 * error code/reason for each branch so regressions in the regex matchers or
 * the framework error mapping are caught at lint time. Pure function — no
 * DuckDB native bindings required.
 * @module tests/unit/canvas/classifyDuckdbError.test
 */

import { describe, expect, it } from 'vitest';

import {
  classifyDuckdbError,
  isCtasNameTaken,
  isDropOverView,
  isViewOverTable,
  prepareFailureRecovery,
  registerAsClash,
  viewTableClash,
  viewUnreadableError,
} from '@/services/canvas/providers/duckdb/duckdbErrors.js';
import { JsonRpcErrorCode, McpError, notFound, validationError } from '@/types-global/errors.js';
import { expectLinearCost } from '../../../helpers/cpu-time.js';

/**
 * Messages measured from `@duckdb/node-api` 1.5.5 (#565). The caller-side
 * branches are matched against these, not against wording guessed from the
 * branch names.
 */
const MEASURED = {
  /** `COPY … TO` / a file scan with `enable_external_access = false`. */
  externalAccessDenied:
    'Permission Error: Cannot access file "/srv/data/x.csv" - file system operations are disabled by configuration',
  /** A write inside `BEGIN TRANSACTION READ ONLY`. */
  readOnlyTransactionWrite:
    'TransactionContext Error: Cannot write to database "memory" - transaction is launched in read-only mode',
  /** A write statement against a database opened with `access_mode = READ_ONLY`. */
  readOnlyDatabaseWrite:
    'Invalid Input Error: Cannot execute statement of type "CREATE" on database "file" which is attached in read-only mode!',
  parserErrors: [
    'Parser Error: syntax error at or near "SELEC"\n\nLINE 1: SELEC 1\n        ^',
    'Parser Error: syntax error at end of input',
    `Parser Error: unterminated quoted string at or near "'unterminated"`,
  ],
  /**
   * `@duckdb/node-api` 1.5.6-r.2 and 2.0.0-r.1 wrap a parser error raised while
   * extracting statements — `extractStatements()`, and `start()` through it.
   * The first is a `CREATE TABLE … AS` DuckDB v1.5 cannot parse.
   */
  wrappedParserErrors: [
    'Failed to extract statements: Parser Error: syntax error at or near "DESCRIBE"\n\nLINE 1: CREATE TABLE "x" AS DESCRIBE SELECT 1\n                            ^',
    'Failed to extract statements: Parser Error: syntax error at end of input',
    'Failed to extract statements: Parser Error: syntax error at or near "+"\n\nLINE 1: SELECT 1 +\n                 ^',
  ],
  /** The operating system refusing a file DuckDB was told to write or read. */
  ioFaults: [
    'IO Error: Cannot open file "/srv/exports/out.csv": Permission denied',
    'IO Error: Failed to create directory "/tmp/mcp-canvas-AbC123/0f3c2b9e-6c1d-4a39-9d2e-6f1b7a0c5e44": Permission denied',
    'IO Error: Cannot open file "/srv/exports/out.csv": Read-only file system',
    // A caller-chosen export name must not steer the classification either.
    'IO Error: Cannot open file "/srv/exports/syntax_report.csv": Permission denied',
  ],
} as const;

/** The recovery a parser error carries, as `sql_parse_error` and as a SELECT's `invalid_sql`. */
const PARSE_HINT =
  'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.';

describe('classifyDuckdbError · measured caller-side messages (#565)', () => {
  it.each([MEASURED.externalAccessDenied, MEASURED.readOnlyTransactionWrite])(
    'keeps %s as sql_read_only',
    (message) => {
      const original = new Error(message);
      const mcp = classifyDuckdbError(original) as McpError;
      expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcp.data?.reason).toBe('sql_read_only');
      expect(mcp.cause).toBe(original);
    },
  );

  it.each(MEASURED.parserErrors)('keeps %s as sql_parse_error', (message) => {
    const mcp = classifyDuckdbError(new Error(message)) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.data?.reason).toBe('sql_parse_error');
  });

  it.each(MEASURED.wrappedParserErrors)(
    'classifies the statement-extraction parser error %s as sql_parse_error (#752)',
    (message) => {
      const original = new Error(message);
      const mcp = classifyDuckdbError(original) as McpError;
      expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcp.data?.reason).toBe('sql_parse_error');
      expect(mcp.message).toBe(`Canvas SQL rejected: ${message}`);
      expect((mcp.data as { recovery: { hint: string } }).recovery.hint).toBe(PARSE_HINT);
      expect(mcp.cause).toBe(original);
    },
  );

  it.each([
    'IO Error: Cannot open file "/srv/exports/Parser Error.csv": Permission denied',
    'IO Error: Cannot open file "/srv/exports/Failed to extract statements: Parser Error.csv": Permission denied',
    'Failed to extract statements: Error in native callback',
    'INTERNAL Error: Failed to extract statements: Parser Error: unexpected state',
  ])('keeps %s off the parser branch', (message) => {
    const mcp = classifyDuckdbError(new Error(message)) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.data?.reason).toBeUndefined();
  });

  // The write refusal leads with an execution-error class prefix, so it has to
  // be recognised before the #451 execution-error branch claims it.
  it('classifies a write refused by a read-only database as sql_read_only, not sql_execution_error', () => {
    const mcp = classifyDuckdbError(new Error(MEASURED.readOnlyDatabaseWrite)) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.data?.reason).toBe('sql_read_only');
    expect((mcp.data as { recovery: { hint: string } }).recovery.hint).not.toMatch(/TRY_CAST/);
  });

  it.each(MEASURED.ioFaults)('keeps the I/O fault %s a DatabaseError with no reason', (message) => {
    const original = new Error(message);
    const mcp = classifyDuckdbError(original) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.data?.reason).toBeUndefined();
    expect(mcp.cause).toBe(original);
  });
});

describe('classifyDuckdbError · host path redaction (#565)', () => {
  it('replaces a redacted directory with [path] and keeps the raw error on cause', () => {
    const original = new Error(MEASURED.ioFaults[0]);
    const mcp = classifyDuckdbError(original, ['/srv/exports']) as McpError;
    expect(mcp.message).toBe('IO Error: Cannot open file "[path]/out.csv": Permission denied');
    expect(mcp.cause).toBe(original);
    expect((mcp.cause as Error).message).toContain('/srv/exports/out.csv');
  });

  it('redacts the messages of the caller-side branches too', () => {
    const readOnly = classifyDuckdbError(new Error(MEASURED.externalAccessDenied), [
      '/srv/data',
    ]) as McpError;
    expect(readOnly.data?.reason).toBe('sql_read_only');
    expect(readOnly.message).toBe(
      'Canvas SQL rejected: Permission Error: Cannot access file "[path]/x.csv" - file system operations are disabled by configuration',
    );

    const execution = classifyDuckdbError(
      new Error('Conversion Error: Could not convert string "/srv/data/a" to INT32'),
      ['/srv/data'],
    ) as McpError;
    expect(execution.data?.reason).toBe('sql_execution_error');
    expect(execution.message).not.toContain('/srv/data');
  });

  it('redacts a nested directory whole, whichever order the paths arrive in', () => {
    const message =
      'IO Error: Failed to create directory "/data/tmp/mcp-canvas-AbC123/spill": Permission denied';
    for (const paths of [
      ['/data', '/data/tmp/mcp-canvas-AbC123'],
      ['/data/tmp/mcp-canvas-AbC123', '/data'],
    ]) {
      expect((classifyDuckdbError(new Error(message), paths) as McpError).message).toBe(
        'IO Error: Failed to create directory "[path]/spill": Permission denied',
      );
    }
  });

  it('replaces every occurrence, including paths full of regex metacharacters', () => {
    const dir = '/srv/a+b (1)/[x]';
    const mcp = classifyDuckdbError(
      new Error(`IO Error: could not move "${dir}/tmp_out.csv" to "${dir}/out.csv"`),
      [dir],
    ) as McpError;
    expect(mcp.message).toBe('IO Error: could not move "[path]/tmp_out.csv" to "[path]/out.csv"');
  });

  it('never redacts the filesystem root, which would mangle the whole message', () => {
    const mcp = classifyDuckdbError(new Error(MEASURED.ioFaults[0]), ['/', '']) as McpError;
    expect(mcp.message).toBe(MEASURED.ioFaults[0]);
  });
});

describe('classifyDuckdbError', () => {
  it('classifies parser errors as ValidationError with sql_parse_error reason', () => {
    const result = classifyDuckdbError(new Error('Parser Error: syntax error at end of input'));
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.message).toMatch(/Canvas SQL rejected:/);
    expect(mcp.data?.reason).toBe('sql_parse_error');
    expect(mcp.cause).toBeInstanceOf(Error);
  });

  it('classifies unmatched Error instances as DatabaseError preserving the cause', () => {
    const original = new Error('Out of memory');
    const result = classifyDuckdbError(original);
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.message).toBe('Out of memory');
    expect(mcp.cause).toBe(original);
  });

  it.each([
    ['a string', 'weird string thrown', 'weird string thrown'],
    ['null', null, 'null'],
    ['a plain object', { code: 42, detail: 'x' }, '[object Object]'],
    ['a number', 42, '42'],
  ])(
    'classifies a thrown %s as DatabaseError with the stringified value in data',
    (_label, thrown, expected) => {
      const result = classifyDuckdbError(thrown);
      expect(result).toBeInstanceOf(McpError);
      const mcp = result as McpError;
      expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
      expect(mcp.message).toMatch(/non-Error value/);
      expect(mcp.data?.value).toBe(expected);
    },
  );

  // Issue #254 — classification is for raw engine errors only. A structured
  // McpError thrown inside a provider try block (ensureTableMissing's
  // register_as_clash, resolveExportPath's path validations) must pass
  // through unchanged instead of being reclassified to DatabaseError, which
  // stripped code, data.reason, and data.tableName.
  it('issue #254 — passes an already-structured McpError through unchanged', () => {
    const original = validationError(
      'Canvas table "df_x" already exists. Drop it before reusing the name.',
      { reason: 'register_as_clash', tableName: 'df_x' },
    );
    const result = classifyDuckdbError(original);
    expect(result).toBe(original); // same instance — not rewrapped
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.data?.reason).toBe('register_as_clash');
    expect(mcp.data?.tableName).toBe('df_x');
  });

  it('issue #254 — the McpError guard wins over message-pattern matching', () => {
    // Message matches the parser-error regex, but the value is already
    // classified — it must not be re-tagged sql_parse_error.
    const original = notFound('syntax detail: table gone', { reason: 'missing_table' });
    expect(classifyDuckdbError(original)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Execution-time data errors (#451)
// ---------------------------------------------------------------------------

/**
 * DuckDB's own `Exception::IsExecutionError` is exactly CONVERSION,
 * INVALID_INPUT, and OUT_OF_RANGE. A BINDER error joins them here: the
 * provider refuses a statement that fails to prepare before it runs, so a
 * binder error reaching the classifier was raised while a prepared statement
 * ran. `@duckdb/node-api` surfaces a bare `Error` with no `errorType`, so the
 * leading class prefix is the only discriminator in process — and it has to be
 * anchored, since `Out of Range Error` and `Out of Memory Error` sit on
 * opposite sides of the split.
 */
describe('classifyDuckdbError · execution-time data errors (#451)', () => {
  /** The recovery a binder error raised while a prepared statement runs calls for. */
  const BINDER_EXECUTION_HINT =
    'Correct the argument the message names, such as a zero step or an infinite bound in range or generate_series. When it names a column, define the view that reads it again over the tables as now staged.';

  /**
   * An argument a function rejects as it runs: a row's value, or a constant in
   * the SQL, which the message cannot tell apart.
   */
  const INVALID_INPUT_HINT =
    'Correct the argument the message names if it is a constant in the SQL, such as a regex pattern or format string; otherwise filter out the rows whose values the function cannot read, or use the function’s TRY variant where it has one, such as TRY_CAST or TRY_STRPTIME.';

  /** Each class with a message measured from DuckDB v2.0.0, and the recovery that class calls for. */
  const EXECUTION_MESSAGES = [
    [
      "Conversion Error: Could not convert string 'n/a' to INT32 when casting from source column amount",
      'Wrap the cast in TRY_CAST, or filter out the rows the message names before converting them.',
    ],
    [
      'Invalid Input Error: Malformed JSON at byte 0 of input: invalid literal.  Input: "nope"',
      INVALID_INPUT_HINT,
    ],
    [
      'Invalid Input Error: Could not parse string "a" according to format specifier "%Y"',
      INVALID_INPUT_HINT,
    ],
    // Constants rejected as the statement runs: `format('{', 1)` on v1.5.6 and
    // v2.0.1, and a regex pattern on v2.0.1, which v1.5.6 rejects at prepare.
    ['Invalid Input Error: invalid format string', INVALID_INPUT_HINT],
    ['Invalid Input Error: missing ): (', INVALID_INPUT_HINT],
    [
      'Out of Range Error: Overflow in addition of INT64 (9223372036854775807 + 1)!',
      'Cast to a wider type such as HUGEINT or DOUBLE before the arithmetic that overflows, or filter out the rows whose values are out of range.',
    ],
    // A series rejecting its arguments as it runs, the same on v1.5.6.
    ['Binder Error: interval cannot be 0!', BINDER_EXECUTION_HINT],
    ['Binder Error: RANGE with infinite bounds is not supported', BINDER_EXECUTION_HINT],
    // A view whose staged table no longer has the column it reads, bound by an export.
    ['Binder Error: Referenced column "a" not found in FROM clause!', BINDER_EXECUTION_HINT],
  ] as const;

  it.each(EXECUTION_MESSAGES)(
    'classifies %s as a caller-side ValidationError with its class recovery',
    (message, hint) => {
      const original = new Error(message);
      const result = classifyDuckdbError(original);
      expect(result).toBeInstanceOf(McpError);
      const mcp = result as McpError;
      expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcp.data?.reason).toBe('sql_execution_error');
      expect(mcp.message).toBe(`Canvas query failed: ${message}`);
      expect((mcp.data as { recovery?: { hint?: string } }).recovery?.hint).toBe(hint);
      expect(mcp.cause).toBe(original);
    },
  );

  it.each([
    'Out of Memory Error: failed to allocate block of 262144 bytes',
    'IO Error: Cannot open file "/tmp/x.parquet": No such file or directory',
    'INTERNAL Error: Attempted to access index 3 within vector of size 2',
    'Constraint Error: NOT NULL constraint failed',
  ])('keeps %s on the engine-fault side as DatabaseError', (message) => {
    const result = classifyDuckdbError(new Error(message));
    expect((result as McpError).code).toBe(JsonRpcErrorCode.DatabaseError);
    expect((result as McpError).data?.reason).toBeUndefined();
  });

  it('matches the class prefix only at the start of the message', () => {
    // An engine message that merely mentions a data-error class mid-sentence is
    // not one — anchoring is what keeps an export-path I/O fault out of the
    // caller-side bucket.
    const result = classifyDuckdbError(
      new Error('IO Error: write failed while handling Conversion Error: cast overflow'),
    );
    expect((result as McpError).code).toBe(JsonRpcErrorCode.DatabaseError);
  });

  it('gives the sibling parse and read-only branches their own recovery hints', () => {
    const parse = classifyDuckdbError(
      new Error('Parser Error: syntax error at or near "FROM"'),
    ) as McpError;
    expect((parse.data as { recovery: { hint: string } }).recovery.hint).toBe(PARSE_HINT);

    const readOnly = classifyDuckdbError(new Error(MEASURED.readOnlyTransactionWrite)) as McpError;
    expect((readOnly.data as { recovery: { hint: string } }).recovery.hint).toBe(
      "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
    );
  });
});

// ---------------------------------------------------------------------------
// Out-of-memory messages
// ---------------------------------------------------------------------------

/** DuckDB's tuning advice, measured from v2.0.0: every statement in it is one a canvas refuses. */
const TUNING_ADVICE =
  "\n\nPossible solutions:\n* Reducing the number of threads (SET threads=X)\n* Disabling insertion-order preservation (SET preserve_insertion_order=false)\n* Increasing the memory limit (SET memory_limit='...GB')\n\nSee also https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads";

describe('classifyDuckdbError · out-of-memory messages', () => {
  it.each([
    'Out of Memory Error: failed to allocate data of size 16.0 MiB (57.3 MiB/61.0 MiB used)',
    'Out of Memory Error: could not allocate block of size 256.0 KiB (60.8 MiB/61.0 MiB used)',
    // The appender reports the engine's message without its class.
    'Failed to append: could not allocate block of size 256.0 KiB (60.8 MiB/61.0 MiB used)',
  ])('keeps %s a DatabaseError with no reason, cut before the SET advice', (first) => {
    const original = new Error(`${first}${TUNING_ADVICE}`);
    const mcp = classifyDuckdbError(original) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.data?.reason).toBeUndefined();
    expect(mcp.message).toBe(first);
    expect(mcp.cause).toBe(original);
  });

  it('redacts host paths in what it keeps', () => {
    const mcp = classifyDuckdbError(
      new Error(`Out of Memory Error: could not write "/srv/exports/x.tmp"${TUNING_ADVICE}`),
      ['/srv/exports'],
    ) as McpError;
    expect(mcp.message).toBe('Out of Memory Error: could not write "[path]/x.tmp"');
  });

  it('keeps the advice in a message of any other class, which quotes it rather than carries it', () => {
    const message = `IO Error: Cannot open file "/srv/exports/x.csv": Permission denied${TUNING_ADVICE}`;
    expect((classifyDuckdbError(new Error(message)) as McpError).message).toBe(message);
  });
});

// ---------------------------------------------------------------------------
// A table missing while a prepared statement runs
// ---------------------------------------------------------------------------

describe('classifyDuckdbError · a table missing while a statement runs', () => {
  /** The recovery query() gives a missing table. */
  const MISSING_TABLE_HINT =
    "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.";

  // Measured from DuckDB v2.0.0: an export's count and an import's COPY of a
  // view whose table was dropped.
  it.each([
    ['base', 'Catalog Error: Table with name base does not exist!\nDid you mean "pg_sequence"?'],
    [
      'base',
      `Catalog Error: Table with name base does not exist!\nDid you mean "pg_sequence"?\n\nLINE 1: COPY "v" TO '/tmp/mcp-canvas-x/0f3c.parquet'\n                                                    ^^^^`,
    ],
    ['my table', 'Catalog Error: Table with name my table does not exist!'],
  ])('raises the missing_table NotFound query() raises for %s', (tableName, message) => {
    const original = new Error(message);
    const mcp = classifyDuckdbError(original, ['/tmp/mcp-canvas-x']) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.NotFound);
    expect(mcp.message).toBe(
      `Canvas table "${tableName}" does not exist. The table may have expired, been dropped, or the name may be mistyped.`,
    );
    expect(mcp.data).toEqual({
      reason: 'missing_table',
      tableName,
      recovery: { hint: MISSING_TABLE_HINT },
    });
    // The name is the one value a caller sends back, so `content[]` renders it as code (#863).
    expect(mcp.literals).toEqual([tableName]);
    expect(mcp.cause).toBe(original);
  });

  it.each([
    'Catalog Error: Table with name "nos.t" does not exist because schema "nos" does not exist.',
    'Catalog Error: Scalar Function with name nofunc does not exist!',
    'IO Error: Cannot open file "/srv/Catalog Error: Table with name x does not exist!": Permission denied',
  ])('keeps %s a DatabaseError', (message) => {
    const mcp = classifyDuckdbError(new Error(message)) as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.data?.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A name already staged, as a CTAS or a view definition finds it (#891)
// ---------------------------------------------------------------------------

describe('name clashes a CTAS or a view definition raises (#891)', () => {
  /** Measured from v2.0.1-r.1 and v1.5.6-r.2; the engine joins the catalog key with a literal `\0`. */
  const CTAS_REFUSALS = [
    'Catalog Error: Table with name "df_SAME" already exists!',
    'Catalog Error: View with name "df_SAME" already exists!',
    String.raw`TransactionContext Error: Catalog write-write conflict on create with "Schema\0main\0Table\0main\0df_SAME"`,
    String.raw`TransactionContext Error: Catalog write-write conflict on create with "Schema\0main\0main\0Table\0main\0df_SAME"`,
    String.raw`TransactionContext Error: Catalog write-write conflict on alter with "Table\0main\0df_SAME\0Schema\0main\0main"`,
  ];

  it.each(CTAS_REFUSALS)('reads %s as a CTAS name already taken', (message) => {
    expect(isCtasNameTaken(new Error(message))).toBe(true);
  });

  it.each([
    'Catalog Error: Table with name df_SAME does not exist!',
    'Catalog Error: Table with name "df_SAME" already exists',
    'Invalid Input Error: Catalog Error: Table with name "df_SAME" already exists!',
    'IO Error: Cannot open file "/srv/TransactionContext Error: Catalog write-write conflict on x": Permission denied',
    'TransactionContext Error: Cannot write to database "memory" - transaction is launched in read-only mode',
  ])('reads %s as no CTAS name clash', (message) => {
    expect(isCtasNameTaken(new Error(message))).toBe(false);
  });

  it('reads a thrown non-Error as no name clash', () => {
    expect(isCtasNameTaken(CTAS_REFUSALS[0])).toBe(false);
    expect(
      isViewOverTable(
        'Catalog Error: Existing object x is of type Table, trying to replace with type View',
      ),
    ).toBe(false);
  });

  // The provider reads these texts as a name clash only where a CTAS raised them.
  it.each(CTAS_REFUSALS)(
    'leaves %s a DatabaseError with no reason in the classifier',
    (message) => {
      const mcp = classifyDuckdbError(new Error(message)) as McpError;
      expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
      expect(mcp.data?.reason).toBeUndefined();
    },
  );

  it.each([
    // v2.0.1 quotes the name, v1.5.6 does not.
    'Catalog Error: Existing object "caset" is of type Table, trying to replace with type View',
    'Catalog Error: Existing object caset is of type Table, trying to replace with type View',
  ])('reads %s as a view definition over a table', (message) => {
    expect(isViewOverTable(new Error(message))).toBe(true);
  });

  it.each([
    'Catalog Error: Existing object "caset" is of type View, trying to replace with type Table',
    String.raw`TransactionContext Error: Catalog write-write conflict on create with "Schema\0main\0View\0main\0v"`,
    'Binder Error: Existing object "caset" is of type Table, trying to replace with type View',
  ])('reads %s as no view definition over a table', (message) => {
    expect(isViewOverTable(new Error(message))).toBe(false);
  });

  it.each([
    // An import's replace step dropping a table where a view holds the name in another case.
    ['Catalog Error: Existing object "casev" is of type View, trying to drop type Table', true],
    ['Catalog Error: Existing object casev is of type View, trying to drop type Table', true],
    [
      'Catalog Error: Existing object "caset" is of type Table, trying to replace with type View',
      false,
    ],
    ['Catalog Error: Table with name casev does not exist!', false],
  ] as const)('reads %s as a table drop over a view: %s', (message, expected) => {
    expect(isDropOverView(new Error(message))).toBe(expected);
  });

  it.each([
    ['without an engine cause', undefined],
    ['with the engine refusal as cause', new Error(CTAS_REFUSALS[0])],
  ])('builds register_as_clash %s, the name a literal', (_label, cause) => {
    const mcp = registerAsClash('df__SAME', cause);
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.message).toBe(
      'Canvas table "df__SAME" already exists. Drop it before reusing the name.',
    );
    expect(mcp.data).toEqual({
      reason: 'register_as_clash',
      tableName: 'df__SAME',
      recovery: {
        hint: "A table or view with this name is already staged on the canvas. Use another name for the result, or query the staged one if it holds what you need — list what is staged with this server's dataframe-describe tool.",
      },
    });
    expect(mcp.literals).toEqual(['df__SAME']);
    expect(mcp.cause).toBe(cause);
    expect('cause' in mcp).toBe(cause !== undefined);
    // The provider's catch passes it through unchanged (#254).
    expect(classifyDuckdbError(mcp)).toBe(mcp);
  });

  it.each([
    ['without an engine cause', undefined],
    [
      'with the engine refusal as cause',
      new Error(
        'Catalog Error: Existing object "v__x" is of type Table, trying to replace with type View',
      ),
    ],
  ])('builds view_table_clash %s, the name a literal', (_label, cause) => {
    const mcp = viewTableClash('v__x', cause);
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.message).toBe(
      'Canvas already contains a base table named "v__x". Drop the table or choose a different name.',
    );
    expect(mcp.data).toEqual({
      reason: 'view_table_clash',
      name: 'v__x',
      recovery: { hint: 'Choose another name for the view, or drop the table first.' },
    });
    expect(mcp.literals).toEqual(['v__x']);
    expect(mcp.cause).toBe(cause);
    expect('cause' in mcp).toBe(cause !== undefined);
  });
});

describe('viewUnreadableError · the views it names (#863)', () => {
  it('passes every view it names as a literal, in the order it names them', () => {
    const mcp = viewUnreadableError(
      [
        { name: 'v__also', error: new Error('Binder Error: interval cannot be 0!') },
        { name: 'v__reads', error: new Error('Catalog Error: Table with name t does not exist!') },
      ],
      [],
    );
    expect(mcp.message).toBe(
      'Canvas views could not be read: "v__also" — Binder Error: interval cannot be 0!; "v__reads" — Catalog Error: Table with name t does not exist!',
    );
    expect(mcp.literals).toEqual(['v__also', 'v__reads']);
  });
});

// ---------------------------------------------------------------------------
// The recovery a SELECT that fails to parse or prepare carries (#803)
// ---------------------------------------------------------------------------

/** The `invalid_sql` reason's own hint: the binder named a column, a grouping, or a signature. */
const BINDER_HINT =
  "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.";

describe('prepareFailureRecovery · one hint per engine class (#803)', () => {
  /** Messages measured from DuckDB v1.5.6 and v2.0.0, each with the hint its class calls for. */
  const PREPARE_MESSAGES = [
    ...MEASURED.parserErrors.map((message) => [message, PARSE_HINT] as const),
    ...MEASURED.wrappedParserErrors.map((message) => [message, PARSE_HINT] as const),
    [
      'Failed to extract statements: Parser Error: syntax error at or near "rows"\n\nLINE 1: SELECT COUNT(*) rows FROM t\n                        ^',
      PARSE_HINT,
    ],
    ['Binder Error: Referenced column "nope" not found in FROM clause!', BINDER_HINT],
    [
      'Binder Error: column "x" must appear in the GROUP BY clause or must be part of an aggregate function.',
      BINDER_HINT,
    ],
    [
      "Binder Error: No function matches the given name and argument types 'sum(VARCHAR)'.",
      BINDER_HINT,
    ],
    ...[
      'Catalog Error: Scalar Function with name nofunc does not exist!',
      'Catalog Error: Table Function with name nofunc_tbl does not exist!',
      'Catalog Error: Type with name nosuchtype does not exist!',
      'Catalog Error: Collation with name nocoll does not exist!',
      'Catalog Error: Table with name "nos.t" does not exist because schema "nos" does not exist.',
    ].map(
      (message) =>
        [
          message,
          "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.",
        ] as const,
    ),
    ...[
      'Invalid Input Error: missing ): (',
      'Invalid Input Error: Failed to parse format specifier %Q: Unrecognized format for strftime/strptime: %Q',
      // A constant folded while the statement is prepared, on v1.5.6 and v2.0.1.
      'Conversion Error: extract specifier "fortnight" not recognized',
    ].map(
      (message) =>
        [
          message,
          'Correct the argument value the message names — a pattern, format string, or other constant the function cannot accept.',
        ] as const,
    ),
    [
      'IO Error: No files found that match the pattern "[path]/missing.csv"',
      "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
    ],
    ['Not implemented Error: some construct', BINDER_HINT],
  ] as const;

  it.each(PREPARE_MESSAGES)('gives %s its class hint', (message, hint) => {
    expect(prepareFailureRecovery(message)).toBe(hint);
  });

  it('names no column or function in the hint for a parse failure', () => {
    expect(prepareFailureRecovery(MEASURED.wrappedParserErrors[0])).not.toMatch(/column|function/i);
  });

  it('reads the class only at the start of the message', () => {
    for (const message of [
      'Binder Error: Referenced column "Parser Error" not found in FROM clause!',
      'Binder Error: Referenced column "Catalog Error" not found in FROM clause!',
      'Binder Error: Referenced column "IO Error" not found in FROM clause!',
    ]) {
      expect(prepareFailureRecovery(message)).toBe(BINDER_HINT);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost over engine messages quoting caller SQL
// ---------------------------------------------------------------------------

/**
 * Engine messages of about `size` characters, one per shape an anchored class read must
 * handle: a repeated wrapper with no class after it, overlapping class prefixes, a near-miss of the
 * read-only refusal, one long line ending in a break, breaks throughout, a parser message
 * quoting long caller SQL, and a near-miss and a match of each name clash a CTAS or a view
 * definition raises.
 */
function engineMessages(size: number): Error[] {
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  return [
    fill('Failed to extract statements: '),
    `Failed to extract statements: ${fill('Parser Erro')}`,
    fill('Out of '),
    `Invalid Input Error: ${fill('read-only mod')}`,
    `${fill('§1 x')}\ny`,
    fill('  \r\n'),
    `Parser Error: syntax error at or near "+"\n\nLINE 1: ${fill('SELECT 1 + ')}`,
    `Catalog Error: ${fill('Catalog Error: ')}`,
    `IO Error: ${fill('/srv/exports/')}`,
    fill('Binder Erro'),
    `Catalog Error: Table with name ${fill('a does not exist')}`,
    `Catalog Error: Table with name ${fill('x')} does not exist!`,
    `Out of Memory Error: ${fill('x')}\n\nPossible solutions:\n${fill('* SET x\n')}`,
    `Conversion Error: ${fill('Conversion Erro')}`,
    `Catalog Error: Table with name ${fill(' already exists')}`,
    `Catalog Error: View with name ${fill('x')} already exists!`,
    `TransactionContext Error: ${fill('Catalog write-write conflict on')}`,
    `Catalog Error: Existing object ${fill(' is of type Table')}`,
    `Catalog Error: Existing object ${fill('x')} is of type Table, trying to replace with type View`,
    `Catalog Error: Existing object ${fill(' is of type View')}`,
    `Catalog Error: Existing object ${fill('x')} is of type View, trying to drop type Table`,
  ].map((message) => new Error(message));
}

/** The constant-argument recovery a prepare-time `Invalid Input` or `Conversion` error takes. */
const CONSTANT_ARGUMENT_HINT =
  'Correct the argument value the message names — a pattern, format string, or other constant the function cannot accept.';

/** The prepare-time `Catalog Error` recovery. */
const CATALOG_HINT =
  "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.";

describe('engine-message classification cost', () => {
  it('classifies an engine message in time linear in its length', () => {
    expectLinearCost((size) => {
      const errors = engineMessages(size);
      // Each message classified at this size, its host paths redacted throughout.
      const classified = errors.map(
        (err) => classifyDuckdbError(err, ['/srv/exports', '/tmp/mcp-canvas-x']) as McpError,
      );
      expect(classified.map((mcp) => mcp.data?.reason)).toEqual([
        undefined,
        undefined,
        undefined,
        'sql_execution_error',
        undefined,
        undefined,
        'sql_parse_error',
        undefined,
        undefined,
        undefined,
        undefined,
        'missing_table',
        undefined,
        'sql_execution_error',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(classified[8]?.message).not.toContain('/srv/exports');
      expect(classified[12]?.message).not.toContain('Possible solutions');
      return () => {
        for (const err of errors) classifyDuckdbError(err, ['/srv/exports', '/tmp/mcp-canvas-x']);
      };
    });
  }, 0);

  it('picks a prepare-failure hint in time linear in the message length', () => {
    expectLinearCost((size) => {
      const messages = engineMessages(size).map((err) => err.message);
      // Each message's class read at this size.
      expect(messages.map((message) => prepareFailureRecovery(message))).toEqual([
        BINDER_HINT,
        BINDER_HINT,
        BINDER_HINT,
        CONSTANT_ARGUMENT_HINT,
        BINDER_HINT,
        BINDER_HINT,
        PARSE_HINT,
        CATALOG_HINT,
        "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.",
        BINDER_HINT,
        CATALOG_HINT,
        CATALOG_HINT,
        BINDER_HINT,
        CONSTANT_ARGUMENT_HINT,
        CATALOG_HINT,
        CATALOG_HINT,
        BINDER_HINT,
        CATALOG_HINT,
        CATALOG_HINT,
        CATALOG_HINT,
        CATALOG_HINT,
      ]);
      return () => {
        for (const message of messages) prepareFailureRecovery(message);
      };
    });
  }, 0);

  it('reads a name clash a CTAS, a view definition, or a drop raises in time linear in the message length', () => {
    expectLinearCost((size) => {
      const errors = engineMessages(size);
      // Which messages each read matches at this size: one each, the rest near-misses.
      const matching = (read: (err: unknown) => boolean) =>
        errors.flatMap((err, index) => (read(err) ? [index] : []));
      expect(matching(isCtasNameTaken)).toEqual([15]);
      expect(matching(isViewOverTable)).toEqual([18]);
      expect(matching(isDropOverView)).toEqual([20]);
      return () => {
        for (const err of errors) {
          isCtasNameTaken(err);
          isViewOverTable(err);
          isDropOverView(err);
        }
      };
    });
  }, 0);
});
