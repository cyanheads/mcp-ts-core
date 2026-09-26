/**
 * @fileoverview Tests for the DuckDB error classifier. Pins the user-facing
 * error code/reason for each branch so regressions in the regex matchers or
 * the framework error mapping are caught at lint time. Pure function — no
 * DuckDB native bindings required.
 * @module tests/unit/canvas/classifyDuckdbError.test
 */

import { describe, expect, it } from 'vitest';

import { classifyDuckdbError } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { JsonRpcErrorCode, McpError, notFound, validationError } from '@/types-global/errors.js';

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
  /** The operating system refusing a file DuckDB was told to write or read. */
  ioFaults: [
    'IO Error: Cannot open file "/srv/exports/out.csv": Permission denied',
    'IO Error: Failed to create directory "/tmp/mcp-canvas-AbC123/0f3c2b9e-6c1d-4a39-9d2e-6f1b7a0c5e44": Permission denied',
    'IO Error: Cannot open file "/srv/exports/out.csv": Read-only file system',
    // A caller-chosen export name must not steer the classification either.
    'IO Error: Cannot open file "/srv/exports/syntax_report.csv": Permission denied',
  ],
} as const;

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
 * INVALID_INPUT, and OUT_OF_RANGE. `@duckdb/node-api` surfaces a bare `Error`
 * with no `errorType`, so the leading class prefix is the only discriminator
 * in process — and it has to be anchored, since `Out of Range Error` and
 * `Out of Memory Error` sit on opposite sides of the split.
 */
describe('classifyDuckdbError · execution-time data errors (#451)', () => {
  const EXECUTION_MESSAGES = [
    "Conversion Error: Could not convert string 'n/a' to INT32 when casting from source column amount",
    'Invalid Input Error: Malformed JSON in the staged column payload',
    'Out of Range Error: Overflow in multiplication of INT64',
  ];

  it.each(EXECUTION_MESSAGES)(
    'classifies %s as a caller-side ValidationError with recovery',
    (message) => {
      const original = new Error(message);
      const result = classifyDuckdbError(original);
      expect(result).toBeInstanceOf(McpError);
      const mcp = result as McpError;
      expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(mcp.data?.reason).toBe('sql_execution_error');
      expect(mcp.message).toContain(message);
      expect((mcp.data as { recovery?: { hint?: string } }).recovery?.hint).toMatch(/TRY_CAST/);
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
    expect((parse.data as { recovery?: { hint?: string } }).recovery?.hint).toEqual(
      expect.any(String),
    );
    expect((parse.data as { recovery: { hint: string } }).recovery.hint.length).toBeGreaterThan(0);

    const readOnly = classifyDuckdbError(new Error(MEASURED.readOnlyTransactionWrite)) as McpError;
    expect((readOnly.data as { recovery: { hint: string } }).recovery.hint.length).toBeGreaterThan(
      0,
    );
  });
});
