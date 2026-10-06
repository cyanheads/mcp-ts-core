/**
 * @fileoverview Pins the outcome of a fixed matrix of `tools/call` arguments:
 * accepted, with the arguments the handler received, or rejected, with the
 * envelope a client reads. Run once with the pre-validation stages on, as every
 * server ships, and once with all three switched off.
 * @module tests/contract/validation.test
 */
import { describe, it } from 'vitest';

import type { InputHandlingOptions } from '@/mcp-server/tools/utils/inputPrevalidation.js';
import { CASES, PURPOSE, takeHandlerInput } from './fixtures.js';
import { expectPin, openLegacySession, type PinName, type WireResponse } from './harness.js';

interface ToolResult {
  content?: unknown[];
  isError?: boolean;
  structuredContent?: { error?: { data?: Record<string, unknown> } };
}

/**
 * One call's outcome. Zod `issues` keep their path and code: the rest is Zod's
 * wording, which the `content[]` text and the hint already carry verbatim.
 */
function outcome(response: WireResponse) {
  if (response.error) return { protocolError: response.error };
  const result = response.result as ToolResult;
  if (!result.isError) return { accepted: { handlerSaw: takeHandlerInput() ?? null, ...result } };

  const error = result.structuredContent?.error;
  const { issues, ...data } = error?.data ?? {};
  return {
    rejected: {
      ...result,
      structuredContent: {
        error: {
          ...error,
          data: {
            ...data,
            ...(Array.isArray(issues) && {
              issues: issues.map(({ code, path }: { code: string; path: unknown[] }) => ({
                code,
                path,
              })),
            }),
          },
        },
      },
    },
  };
}

const MODES: Array<[label: string, pin: PinName, input: InputHandlingOptions | undefined]> = [
  ['every stage on', 'validation.defaults.json5', undefined],
  [
    'every stage off',
    'validation.switches-off.json5',
    { ignoreKeys: false, caseStyleAliases: false, coerce: false },
  ],
];

describe('argument validation matrix', () => {
  it.each(MODES)('pins each outcome with %s', async (_label, pin, input) => {
    const session = await openLegacySession(PURPOSE, input ? { input } : {});
    const outcomes: Record<string, unknown> = {};
    try {
      for (const [name, label, args] of CASES) {
        takeHandlerInput();
        const response = await session.request('tools/call', {
          name,
          ...(args !== undefined && { arguments: args }),
        });
        outcomes[`${name}: ${label}`] = outcome(response);
      }
    } finally {
      await session.close();
    }

    await expectPin(pin, outcomes);
  });
});
