/**
 * @fileoverview MCP App tool that generates sample sales data with an interactive explorer UI.
 *
 * Demonstrates the MCP Apps extension (SEP-1865) with a practical use case: the tool
 * returns structured tabular data, and the linked UI resource renders it as a sortable,
 * filterable table with row selection.
 *
 * Hosts without MCP Apps support receive a formatted text table as fallback.
 *
 * @module examples/mcp-server/tools/definitions/template-data-explorer.app-tool
 */

import { RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { tool, z } from '@cyanheads/mcp-ts-core';

/** The UI Resource URI that hosts will fetch and render as a sandboxed iframe. */
const UI_RESOURCE_URI = 'ui://template-data-explorer/app.html';

const InputSchema = z.object({
  rowCount: z
    .number()
    .int()
    .min(5)
    .max(100)
    .default(20)
    .describe('Number of sample rows to generate (5-100).'),
});

const SaleRowSchema = z
  .object({
    id: z.number().int().describe('Unique row identifier.'),
    region: z.string().describe('Sales region name.'),
    product: z.string().describe('Product name.'),
    units: z.number().int().describe('Units sold.'),
    revenue: z.number().describe('Revenue in USD.'),
    date: z.string().describe('Sale date (YYYY-MM-DD).'),
  })
  .describe('A single generated sales record.');

const OutputSchema = z.object({
  rows: z.array(SaleRowSchema).describe('Generated sales data rows.'),
  generatedAt: z.iso.datetime().describe('ISO 8601 timestamp when data was generated.'),
  summary: z
    .object({
      totalRows: z.number().int().describe('Total number of rows.'),
      totalRevenue: z.number().describe('Sum of all revenue.'),
      totalUnits: z.number().int().describe('Sum of all units sold.'),
    })
    .describe('Aggregate summary of the dataset.'),
});

type DataExplorerOutput = z.infer<typeof OutputSchema>;

const REGIONS = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East'];
const PRODUCTS = ['Widget Pro', 'Gadget X', 'Module Z', 'Sensor Alpha', 'Platform Core'];

function generateSalesData(rowCount: number): DataExplorerOutput {
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const units = Math.floor(Math.random() * 500) + 10;
    const pricePerUnit = Math.floor(Math.random() * 200) + 20;
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    return {
      id: i + 1,
      region: REGIONS[Math.floor(Math.random() * REGIONS.length)] as string,
      product: PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)] as string,
      units,
      revenue: units * pricePerUnit,
      date: `${new Date().getFullYear()}-${month}-${day}`,
    };
  });

  const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const totalUnits = rows.reduce((sum, r) => sum + r.units, 0);

  return {
    rows,
    generatedAt: new Date().toISOString(),
    summary: { totalRows: rows.length, totalRevenue, totalUnits },
  };
}

export const dataExplorerAppTool = tool('template_data_explorer', {
  title: 'Data Explorer',
  description:
    'Generate sample sales data and render an interactive table. Users can sort columns, filter rows, and select entries from the UI. Falls back to a plain text table where interactive UI is not available.',
  input: InputSchema,
  output: OutputSchema,
  auth: ['tool:data-explorer:read'],
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },
  _meta: {
    ui: { resourceUri: UI_RESOURCE_URI },
    [RESOURCE_URI_META_KEY]: UI_RESOURCE_URI,
  },

  handler(input, ctx) {
    ctx.log.debug('Generating sample sales data.', { rowCount: input.rowCount });
    return generateSalesData(input.rowCount);
  },

  format(result) {
    // First block: JSON for MCP Apps UI (loadData parses the first text block)
    const jsonBlock = JSON.stringify(result);

    // Second block: human-readable table for non-app hosts / LLM context
    const header = 'ID  | Region           | Product        | Units | Revenue    | Date';
    const sep = '----|------------------|----------------|-------|------------|----------';
    const rows = result.rows.map(
      (r) =>
        `${String(r.id).padStart(3)} | ${r.region.padEnd(16)} | ${r.product.padEnd(14)} | ${String(r.units).padStart(5)} | $${r.revenue.toLocaleString('en-US').padStart(9)} | ${r.date}`,
    );
    const summary = `\nTotal: ${result.summary.totalRows} rows | ${result.summary.totalUnits.toLocaleString()} units | $${result.summary.totalRevenue.toLocaleString('en-US')} revenue`;

    return [
      { type: 'text', text: jsonBlock },
      { type: 'text', text: [header, sep, ...rows, summary].join('\n') },
    ];
  },
});
