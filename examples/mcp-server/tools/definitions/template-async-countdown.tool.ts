/**
 * @fileoverview Template task tool demonstrating the MCP Tasks API using
 * the `tool()` builder with `task: true`.
 *
 * Showcases key task patterns:
 * - Progress percentage and status message updates via `ctx.progress`
 * - Cancellation detection via `ctx.signal`
 * - Simulated failure for testing error paths
 *
 * @experimental Tasks API is experimental and may change without notice.
 * @module examples/mcp-server/tools/definitions/template-async-countdown.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

const InputSchema = z
  .object({
    seconds: z.number().int().min(1).max(60).describe('Number of seconds to count down (1-60)'),
    message: z.string().optional().describe('Optional message to include in the final result'),
    simulateFailure: z
      .boolean()
      .optional()
      .default(false)
      .describe('Force a failure at 50% progress.'),
  })
  .describe('Parameters for the async countdown task.');

const OutputSchema = z
  .object({
    success: z.boolean().describe('Whether the countdown completed successfully'),
    message: z.string().describe('Completion or cancellation message'),
    startedAt: z.string().describe('ISO timestamp when countdown started'),
    completedAt: z.string().describe('ISO timestamp when countdown ended'),
    duration: z.number().describe('Actual duration in milliseconds'),
    progress: z.number().describe('Final progress percentage (0-100)'),
    wasCancelled: z.boolean().describe('Whether the task was cancelled'),
  })
  .describe('Result of the completed async countdown task.');

type Output = z.infer<typeof OutputSchema>;

export const asyncCountdownTool = tool('template_async_countdown', {
  title: 'Async Countdown',
  description:
    'Run a countdown timer for the requested number of seconds, reporting progress as it ticks. Cancellable mid-run. On task-capable clients the call returns immediately and progress streams over the task channel; otherwise it runs synchronously and returns when the countdown finishes.',
  task: true,
  input: InputSchema,
  output: OutputSchema,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
  },

  async handler(input, ctx) {
    const startedAt = new Date();
    const { seconds, message, simulateFailure } = input;

    await ctx.progress!.setTotal(seconds);

    for (let remaining = seconds; remaining > 0; remaining--) {
      if (ctx.signal.aborted) {
        const cancelledAt = new Date();
        return {
          success: false,
          message: 'Countdown cancelled by client.',
          startedAt: startedAt.toISOString(),
          completedAt: cancelledAt.toISOString(),
          duration: cancelledAt.getTime() - startedAt.getTime(),
          progress: Math.round(((seconds - remaining) / seconds) * 100),
          wasCancelled: true,
        } satisfies Output;
      }

      const progress = Math.round(((seconds - remaining) / seconds) * 100);
      if (simulateFailure && progress >= 50) {
        throw new Error('Simulated failure at 50% progress (simulateFailure=true)');
      }

      const phase = progress < 25 ? 'Starting' : progress < 75 ? 'In progress' : 'Finishing';
      await ctx.progress!.update(`[${progress}%] ${phase}: ${remaining}s remaining`);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      await ctx.progress!.increment();
    }

    const completedAt = new Date();
    return {
      success: true,
      message: message ?? `Countdown of ${seconds} seconds complete!`,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      duration: completedAt.getTime() - startedAt.getTime(),
      progress: 100,
      wasCancelled: false,
    } satisfies Output;
  },

  format: (result) => {
    const icon = result.success ? '✓' : '✗';
    const lines = [
      `${icon} ${result.message}`,
      '',
      `**success:** ${result.success}`,
      `**wasCancelled:** ${result.wasCancelled}`,
      `**progress:** ${result.progress}%`,
      `**duration:** ${result.duration}ms`,
      `**startedAt:** ${result.startedAt}`,
      `**completedAt:** ${result.completedAt}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
