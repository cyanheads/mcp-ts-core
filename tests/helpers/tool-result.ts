/**
 * @fileoverview Helpers for comparing tool results across the production
 * handler factory and `runToolContract`.
 * @module tests/helpers/tool-result
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { expect } from 'vitest';

/**
 * A failed production result minus the one thing the factory adds and
 * `runToolContract` never does: `structuredContent.error.data.requestId` and
 * the `request <id>` term closing the `content[]` text (#576). Asserts the
 * factory added both, so a parity comparison cannot pass by stripping nothing.
 */
export function withoutRequestId(result: CallToolResult): CallToolResult {
  const { error } = result.structuredContent as {
    error: { code: number; data?: Record<string, unknown>; message: string };
  };
  const { requestId, ...data } = error.data ?? {};
  expect(requestId).toEqual(expect.any(String));

  const [block, ...rest] = result.content as Array<{ text: string; type: 'text' }>;
  const text = block?.text ?? '';
  const withTerms = ` · request ${requestId})`;
  const alone = `\n\n(request ${requestId})`;
  expect(text.endsWith(withTerms) || text.endsWith(alone)).toBe(true);
  const stripped = text.endsWith(withTerms)
    ? `${text.slice(0, -withTerms.length)})`
    : text.slice(0, -alone.length);

  return {
    ...result,
    content: [{ type: 'text', text: stripped }, ...rest],
    structuredContent: {
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(data).length > 0 && { data }),
      },
    },
  };
}
