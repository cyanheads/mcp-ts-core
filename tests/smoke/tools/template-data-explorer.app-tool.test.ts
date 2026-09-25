/**
 * @fileoverview Tests for the data explorer app tool.
 * @module tests/smoke/tools/template-data-explorer.app-tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  dataExplorerAppTool,
  UI_RESOURCE_URI,
} from '../../../examples/mcp-server/tools/definitions/template-data-explorer.app-tool.js';

describe('dataExplorerAppTool', () => {
  it('links the UI resource through both _meta keys', () => {
    expect(dataExplorerAppTool._meta).toMatchObject({
      ui: { resourceUri: UI_RESOURCE_URI },
      'ui/resourceUri': UI_RESOURCE_URI,
    });
  });

  it('generates the requested number of rows', async () => {
    const ctx = createMockContext();
    const input = dataExplorerAppTool.input.parse({ rowCount: 10 });
    const result = await dataExplorerAppTool.handler(input, ctx);
    expect(result.rows).toHaveLength(10);
    expect(result.summary.totalRows).toBe(10);
  });

  it('uses default row count', async () => {
    const ctx = createMockContext();
    const input = dataExplorerAppTool.input.parse({});
    const result = await dataExplorerAppTool.handler(input, ctx);
    expect(result.rows).toHaveLength(20);
  });

  it('output conforms to the declared output schema', async () => {
    const ctx = createMockContext();
    const input = dataExplorerAppTool.input.parse({ rowCount: 5 });
    const result = await dataExplorerAppTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(dataExplorerAppTool.output));
    for (const row of result.rows) {
      expect(row.units).toBeGreaterThan(0);
      expect(row.revenueInUsd).toBeGreaterThan(0);
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('computes summary correctly', async () => {
    const ctx = createMockContext();
    const input = dataExplorerAppTool.input.parse({ rowCount: 5 });
    const result = await dataExplorerAppTool.handler(input, ctx);
    const expectedUnits = result.rows.reduce((sum, r) => sum + r.units, 0);
    const expectedRevenue = result.rows.reduce((sum, r) => sum + r.revenueInUsd, 0);
    expect(result.summary.totalUnits).toBe(expectedUnits);
    expect(result.summary.totalRevenueInUsd).toBe(expectedRevenue);
  });

  it('formats as JSON block + content-complete text table', () => {
    const result = {
      rows: [
        {
          id: 1,
          region: 'North America',
          product: 'Widget Pro',
          units: 1200,
          revenueInUsd: 50000,
          date: '2026-01-15',
        },
      ],
      generatedAt: '2026-01-15T00:00:00.000Z',
      summary: { totalRows: 1, totalRevenueInUsd: 50000, totalUnits: 1200 },
    };
    const blocks = dataExplorerAppTool.format!(result);
    expect(blocks).toHaveLength(2);
    expect(JSON.parse((blocks[0] as { text: string }).text)).toEqual(result);

    const table = (blocks[1] as { text: string }).text;
    expect(table).toContain('Widget Pro');
    expect(table).toContain('$50,000');
    expect(table).toContain('1,200 units');
    expect(table).toContain('Generated: 2026-01-15T00:00:00.000Z');
  });
});
