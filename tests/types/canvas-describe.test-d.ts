/**
 * @fileoverview Typecheck coverage for the columns `describe()` reports (#500).
 * A `DescribedColumn` adds an optional `engineType` to `ColumnSchema`, so a
 * `TableInfo` built without it still compiles under `exactOptionalPropertyTypes`,
 * described columns still pass back to `registerTable` as a schema, and
 * `ColumnSchema` itself is unchanged.
 * @module tests/types/canvas-describe.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';

import type {
  ColumnSchema,
  DescribedColumn,
  RegisterTableOptions,
  TableInfo,
} from '@/services/canvas/index.js';

describe('describe() column types (issue #500)', () => {
  it('reports TableInfo columns as DescribedColumn', () => {
    expectTypeOf<TableInfo['columns']>().toEqualTypeOf<DescribedColumn[]>();
    expectTypeOf<DescribedColumn['engineType']>().toEqualTypeOf<string | undefined>();
  });

  it('still compiles a TableInfo whose columns omit engineType', () => {
    const info: TableInfo = {
      name: 't',
      kind: 'table',
      rowCount: 0,
      columns: [{ name: 'id', type: 'INTEGER', nullable: true }],
    };
    expectTypeOf(info.columns[0]?.engineType).toEqualTypeOf<string | undefined>();
  });

  it('passes described columns back to registerTable as a schema', () => {
    expectTypeOf<DescribedColumn[]>().toMatchTypeOf<NonNullable<RegisterTableOptions['schema']>>();
  });

  it('leaves the registerTable column schema without engineType', () => {
    // @ts-expect-error `engineType` is reported by describe(), not accepted by registerTable.
    const column: ColumnSchema = { name: 'id', type: 'INTEGER', engineType: 'INTEGER' };
    expectTypeOf(column).toEqualTypeOf<ColumnSchema>();
  });
});
