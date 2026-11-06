/**
 * @fileoverview Both client-visible surfaces of every canvas error reason,
 * driven through a real tool definition against a real DuckDB canvas. MCP
 * clients split on which surface they forward to the model — some read
 * `structuredContent.error`, others only `content[]` — so a recovery hint that
 * reaches one and not the other is invisible to half the fleet. Each case runs
 * the production envelope builder via `runToolContract` and asserts the hint on
 * both.
 * @module tests/smoke/canvas-error-surfaces.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import type { CanvasInstance } from '@/services/canvas/core/CanvasInstance.js';
import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { assertPlanReadOnly } from '@/services/canvas/core/sqlGate.js';
import {
  classifyDuckdbError,
  DuckdbProvider,
} from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { runToolContract } from '@/testing/index.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ctx: RequestContext = {
  requestId: 'smoke-canvas-error-surfaces',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-error-surfaces',
};

const CASES = [
  'multi_statement',
  'non_select_statement',
  'non_select_statement_pivot',
  'invalid_sql',
  'invalid_sql_parse',
  'invalid_sql_catalog',
  'invalid_sql_argument',
  'sql_read_only_absent_file',
  'denied_function',
  'denied_function_in_plan',
  'plan_operator_not_allowed',
  'identifier_empty',
  'identifier_shape',
  'identifier_reserved',
  'system_catalog_access',
  'missing_table_query',
  'missing_table_import',
  'sql_execution_error',
  'sql_execution_error_input',
  'sql_execution_error_range',
  'sql_parse_error',
  'sql_parse_error_extraction',
  'sql_read_only',
  'sql_read_only_outside_path',
  'sql_read_only_file_reference',
  'denied_function_setting_read',
  'view_unreadable',
  'export_out_of_memory',
] as const;

type ProbeCase = (typeof CASES)[number];

let canvas: DataCanvas;
let provider: DuckdbProvider;
let exportRoot: string;
let outsideDir: string;
let outsideFile: string;
let workspace: CanvasInstance;
let importSource: CanvasInstance;

/**
 * A stand-in for a consuming server's dataframe tool. Every case throws; the
 * tool exists so the throw travels the production path — handler → classifier →
 * error envelope — rather than being inspected in isolation.
 */
const canvasProbe = tool('canvas_probe', {
  description: 'Drives one canvas failure mode so its client-visible surfaces can be asserted.',
  annotations: { readOnlyHint: true },
  input: z.object({ probe: z.enum(CASES).describe('Which canvas failure mode to trigger') }),
  output: z.object({
    unreachable: z.boolean().describe('Never returned — every probe throws instead'),
  }),
  async handler(input) {
    switch (input.probe) {
      case 'multi_statement':
        await workspace.query('SELECT 1 AS a; SELECT 2 AS b');
        break;
      case 'non_select_statement':
        await workspace.query('DROP TABLE probe');
        break;
      // DuckDB cannot take a PIVOT without an IN list as one SELECT.
      case 'non_select_statement_pivot':
        await workspace.query('PIVOT probe ON id USING count(*)');
        break;
      case 'invalid_sql':
        await workspace.query('SELECT nonexistent_col FROM probe');
        break;
      case 'invalid_sql_parse':
        await workspace.query('SELECT * FROM probe WHERE');
        break;
      case 'invalid_sql_catalog':
        await workspace.query('SELECT id FROM probe ORDER BY id::VARCHAR COLLATE nosuchcoll');
        break;
      case 'invalid_sql_argument':
        await workspace.query("SELECT regexp_matches('a', '(') AS m");
        break;
      // A file reference under the export root is refused the same way
      // whether or not the file is there.
      case 'sql_read_only_absent_file':
        await workspace.query(`SELECT * FROM '${join(exportRoot, 'absent.csv')}'`);
        break;
      case 'denied_function':
        await workspace.query("SELECT * FROM read_json('/etc/passwd')");
        break;
      // DuckDB never plans a statement that reaches layer 5 with a write
      // operator or a file-reading function — the statement-type layer rejects
      // it first — so these two run the real gate over a plan fixture.
      case 'denied_function_in_plan':
        assertPlanReadOnly({ name: 'SEQ_SCAN', function: 'read_parquet' });
        break;
      case 'plan_operator_not_allowed':
        assertPlanReadOnly({ name: 'PROJECTION', children: [{ name: 'INSERT' }] });
        break;
      case 'identifier_empty':
        await workspace.registerTable('', [{ x: 1 }]);
        break;
      case 'identifier_shape':
        await workspace.registerTable('bad-name!', [{ x: 1 }]);
        break;
      case 'identifier_reserved':
        await workspace.registerTable('select', [{ x: 1 }]);
        break;
      case 'system_catalog_access':
        await workspace.query('SELECT * FROM information_schema.tables', {
          denySystemCatalogs: true,
        });
        break;
      case 'missing_table_query':
        await workspace.query('SELECT * FROM gone_table');
        break;
      case 'missing_table_import':
        await workspace.importFrom(importSource.canvasId, 'gone_table');
        break;
      case 'sql_execution_error':
        await workspace.query('SELECT CAST(amount AS INTEGER) AS n FROM probe_text');
        break;
      case 'sql_execution_error_input':
        await workspace.query("SELECT strptime(amount, '%Y') AS d FROM probe_text");
        break;
      case 'sql_execution_error_range':
        await workspace.query('SELECT id + 9223372036854775807 AS n FROM probe');
        break;
      // The gate intercepts parse and write failures before execution, so no
      // SQL reaches these classifier branches through query() on every engine
      // version. The classifier itself is the code under test — the engine
      // message, as DuckDB words it (#565, #752), is its input.
      case 'sql_parse_error':
        throw classifyDuckdbError(new Error('Parser Error: syntax error at or near "FROM"'));
      case 'sql_parse_error_extraction':
        throw classifyDuckdbError(
          new Error(
            'Failed to extract statements: Parser Error: syntax error at or near "DESCRIBE"\n\nLINE 1: CREATE TABLE "x" AS DESCRIBE SELECT 1\n                            ^',
          ),
        );
      case 'sql_read_only':
        throw classifyDuckdbError(
          new Error(
            'TransactionContext Error: Cannot write to database "memory" - transaction is launched in read-only mode',
          ),
        );
      // The engine refuses a path outside the export root and scratch
      // directory while preparing, before the plan walk runs.
      case 'sql_read_only_outside_path':
        await workspace.query(`SELECT * FROM '${outsideFile}'`);
        break;
      // The engine may read under the export root; the gate refuses the file.
      case 'sql_read_only_file_reference':
        await workspace.query(`DESCRIBE '${join(exportRoot, 'inside.csv')}'`);
        break;
      case 'denied_function_setting_read':
        await workspace.query(`SELECT current_setting('temp_directory') AS v`);
        break;
      // The series argument registers, and the engine rejects it as the view is read.
      case 'view_unreadable':
        await workspace.registerView('probe_unreadable', 'SELECT * FROM range(0, 10, 0)');
        await workspace.describe({ tableName: 'probe_unreadable' });
        break;
      // A JSON export holds about 13 copies of 2,048 rows as JSON text: 16 KB
      // rows need more than the 256 MB canvas holds.
      case 'export_out_of_memory':
        await workspace.export('probe_wide', { format: 'json', path: 'probe_wide.json' });
        break;
    }
    return { unreachable: true };
  },
});

const SQL_READ_ONLY_HINT =
  "Send a read-only SELECT over the staged tables — list them with this server's dataframe-describe tool. This surface reads no files and cannot create, alter, or drop anything.";

/** A parser error's recovery, as `sql_parse_error` and as a SELECT's `invalid_sql`: syntax, never a column or function. */
const PARSE_HINT =
  'Fix the SQL syntax the message names and send a single read-only SELECT. Put AS before an alias that is a SQL keyword, or double-quote it.';

/** Expected `data.reason` and `data.recovery.hint` for each probe. */
const EXPECTED: Record<ProbeCase, { hint: string; reason: string }> = {
  multi_statement: {
    reason: 'multi_statement',
    hint: 'Send exactly one SELECT statement; split multi-statement SQL into separate calls.',
  },
  non_select_statement: {
    reason: 'non_select_statement',
    hint: 'Rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
  },
  non_select_statement_pivot: {
    reason: 'non_select_statement',
    hint: 'A PIVOT runs as one SELECT only when it lists its values, as ON column IN (value, ...): list them, or rewrite as a single SELECT — this surface is read-only and cannot create, alter, or drop tables.',
  },
  invalid_sql: {
    reason: 'invalid_sql',
    hint: "Correct the column or function the message names; list the staged columns with this server's dataframe-describe tool.",
  },
  invalid_sql_parse: { reason: 'invalid_sql', hint: PARSE_HINT },
  invalid_sql_catalog: {
    reason: 'invalid_sql',
    hint: "Correct the function, type, collation, or schema name the message reports missing — list the staged tables with this server's dataframe-describe tool.",
  },
  invalid_sql_argument: {
    reason: 'invalid_sql',
    hint: 'Correct the argument value the message names — a pattern, format string, or other constant the function cannot accept.',
  },
  sql_read_only_absent_file: { reason: 'sql_read_only', hint: SQL_READ_ONLY_HINT },
  denied_function: {
    reason: 'denied_function',
    hint: 'Remove the function the message names — only the staged tables are queryable.',
  },
  denied_function_setting_read: {
    reason: 'denied_function',
    hint: 'Remove the function the message names — only the staged tables are queryable.',
  },
  denied_function_in_plan: {
    reason: 'denied_function_in_plan',
    hint: 'Remove the file-reading or external-data function — only the staged tables are queryable.',
  },
  plan_operator_not_allowed: {
    reason: 'plan_operator_not_allowed',
    hint: 'Rewrite using read-only SELECT constructs — joins, aggregates, window functions, and CTEs are supported.',
  },
  identifier_empty: {
    reason: 'identifier_empty',
    hint: 'Use a name of letters, digits, and underscores starting with a letter or underscore, 63 characters or fewer.',
  },
  identifier_shape: {
    reason: 'identifier_shape',
    hint: 'Use a name of letters, digits, and underscores starting with a letter or underscore, 63 characters or fewer.',
  },
  identifier_reserved: {
    reason: 'identifier_reserved',
    hint: 'Choose a name that is not a SQL keyword — for example, prefix it with the dataset name.',
  },
  system_catalog_access: {
    reason: 'system_catalog_access',
    hint: "Query only the staged dataframe tables; use this server's dataframe-describe tool to list them.",
  },
  missing_table_query: {
    reason: 'missing_table',
    hint: "Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool.",
  },
  missing_table_import: {
    reason: 'missing_table',
    hint: "Re-check the source table name, or list the tables staged on the source canvas with this server's dataframe-describe tool.",
  },
  sql_execution_error: {
    reason: 'sql_execution_error',
    hint: 'Wrap the cast in TRY_CAST, or filter out the rows the message names before converting them.',
  },
  sql_execution_error_input: {
    reason: 'sql_execution_error',
    hint: 'Filter out the rows whose values the function cannot read, or use the function’s TRY variant where it has one, such as TRY_CAST or TRY_STRPTIME.',
  },
  sql_execution_error_range: {
    reason: 'sql_execution_error',
    hint: 'Cast to a wider type such as HUGEINT or DOUBLE before the arithmetic that overflows, or filter out the rows whose values are out of range.',
  },
  sql_parse_error: { reason: 'sql_parse_error', hint: PARSE_HINT },
  sql_parse_error_extraction: { reason: 'sql_parse_error', hint: PARSE_HINT },
  sql_read_only: {
    reason: 'sql_read_only',
    hint: SQL_READ_ONLY_HINT,
  },
  sql_read_only_outside_path: {
    reason: 'sql_read_only',
    hint: SQL_READ_ONLY_HINT,
  },
  sql_read_only_file_reference: {
    reason: 'sql_read_only',
    hint: SQL_READ_ONLY_HINT,
  },
  view_unreadable: {
    reason: 'view_unreadable',
    hint: 'Drop each view the message names, or define it again over the tables as now staged.',
  },
  export_out_of_memory: {
    reason: 'export_out_of_memory',
    hint: 'A JSON export needs roughly 26 MB of canvas memory per KB of row width, since it holds about 13 copies of 2,048 rows as JSON text at once. Export as CSV or Parquet, which need far less, or export a selection that leaves out the widest columns.',
  },
};

/** Framework API a caller holding only MCP tools cannot invoke. */
const FRAMEWORK_INTERNALS =
  /registerTable|registerView|registerAs|importFrom|denySystemCatalogs|\b(?:describe|drop|clear|query|acquire)\(\)/;

/** The error envelope both client surfaces are built from. */
function envelope(result: CallToolResult): {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string } };
  message: string;
} {
  return (result.structuredContent as { error: ReturnType<typeof envelope> }).error;
}

/** The rendered `content[]` text a format()-only client reads. */
function renderedText(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

describe('canvas · error surfaces (#299, #451)', () => {
  beforeAll(async () => {
    exportRoot = await mkdtemp(join(tmpdir(), 'canvas-error-surfaces-'));
    await writeFile(join(exportRoot, 'inside.csv'), 'label,n\nINSIDE,1\n');
    outsideDir = await mkdtemp(join(tmpdir(), 'canvas-error-surfaces-outside-'));
    outsideFile = join(outsideDir, 'outside.csv');
    await writeFile(outsideFile, 'label,n\nOUTSIDE,1\n');
    provider = new DuckdbProvider({
      memoryLimitMb: 256,
      exportRootPath: exportRoot,
      defaultRowLimit: 1000,
      schemaSniffRows: 100,
    });
    const registry = new CanvasRegistry(provider, {
      ttlMs: 60_000,
      absoluteCapMs: 600_000,
      maxCanvasesPerTenant: 100,
      sweeperIntervalMs: 0,
    });
    canvas = new DataCanvas(provider, registry);
    workspace = await canvas.acquire(undefined, ctx);
    importSource = await canvas.acquire(undefined, ctx);
    await workspace.registerTable('probe', [{ id: 1 }, { id: 2 }]);
    await workspace.registerTable('probe_text', [{ amount: '12' }, { amount: 'n/a' }]);
    await workspace.query(`SELECT i, repeat('x', 16384) AS pad FROM range(2048) r(i)`, {
      registerAs: 'probe_wide',
      preview: 0,
    });
  });

  afterAll(async () => {
    if (canvas) await canvas.shutdown(ctx);
    await rm(exportRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it.each(CASES)('%s carries its recovery hint on both client surfaces', async (probe) => {
    const expected = EXPECTED[probe];
    const result = await runToolContract(canvasProbe, { probe });

    expect(result.isError).toBe(true);
    const error = envelope(result);
    expect(error.data?.reason).toBe(expected.reason);
    expect(error.data?.recovery?.hint).toBe(expected.hint);
    expect(renderedText(result)).toContain(`Recovery: ${expected.hint}`);
  });

  it('keeps the parser message in binderMessage for a SELECT that fails to parse (#803)', async () => {
    const error = envelope(await runToolContract(canvasProbe, { probe: 'invalid_sql_parse' }));
    expect(error.message).toMatch(/^Canvas query failed to prepare: .*Parser Error: /);
    expect((error.data as { binderMessage?: string }).binderMessage).toMatch(/Parser Error: /);
    expect(error.data?.recovery?.hint).not.toMatch(/column|function/i);
  });

  it('names no framework method or provider option in any message or hint', async () => {
    const offenders: string[] = [];
    for (const probe of CASES) {
      const error = envelope(await runToolContract(canvasProbe, { probe }));
      const text = `${error.message} ${error.data?.recovery?.hint ?? ''}`;
      if (FRAMEWORK_INTERNALS.test(text)) offenders.push(`${probe}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });
});
