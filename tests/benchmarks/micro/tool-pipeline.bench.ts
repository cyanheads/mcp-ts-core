/**
 * @fileoverview Tool input/output parsing, Context, formatting, and enrichment at fixed payload sizes.
 * @module tests/benchmarks/micro/tool-pipeline.bench
 */
import { bench, describe, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';
import { makeServerContext } from '../../helpers/server-context.js';
import { benchmarkOptions } from '../harness/options.js';

const rowSchema = z.object({
  id: z.number().int().describe('Record ID.'),
  title: z.string().describe('Record title.'),
  score: z.number().describe('Record score.'),
});

for (const size of [1, 100, 1_000]) {
  describe(`tool pipeline / ${size} records`, () => {
    const rows = Array.from({ length: size }, (_, id) => ({
      id,
      title: `record-${id}`,
      score: id / size,
    }));
    const input = z.object({
      limit: z.number().int().min(1).max(size).describe('Maximum records.'),
    });
    const output = z.object({ rows: z.array(rowSchema).describe('Result records.') });
    const plain = tool('bench_plain', {
      description: 'Fixed records with default JSON formatting.',
      input,
      output,
      handler: ({ limit }) => ({ rows: rows.slice(0, limit) }),
    });
    const enriched = tool('bench_enriched', {
      description: 'Fixed records with Markdown formatting and enrichment.',
      input,
      output,
      enrichment: { totalCount: z.number().describe('Total records.') },
      handler: ({ limit }, ctx) => {
        ctx.enrich.total(size);
        return { rows: rows.slice(0, limit) };
      },
      format: (result) => [
        {
          type: 'text',
          text: result.rows.map((row) => `${row.id}: ${row.title} (${row.score})`).join('\n'),
        },
      ],
    });
    const services = { logger, storage: new StorageService(new InMemoryProvider()) };
    const serverContext = makeServerContext();
    for (const def of [plain, enriched]) {
      const handler = createToolHandler(def, services, {});
      let observed: Awaited<ReturnType<typeof handler>>;
      const check = () => {
        expect(observed).toMatchObject({ structuredContent: { rows } });
        expect(observed).not.toHaveProperty('isError', true);
        expect(observed).toHaveProperty('content.0.type', 'text');
        if (def === enriched) {
          expect(observed).toHaveProperty('structuredContent.totalCount', size);
          expect(observed).toHaveProperty('content.1.text', `\n\n**${size} total**`);
        } else {
          expect(observed).toHaveProperty('content.0.text', JSON.stringify({ rows }, null, 2));
        }
      };
      bench(
        def.name,
        async () => {
          observed = await handler({ limit: size }, serverContext);
        },
        {
          ...benchmarkOptions,
          setup: async () => {
            observed = await handler({ limit: size }, serverContext);
            check();
          },
          teardown: check,
        },
      );
    }
  });
}
