/**
 * @fileoverview Tests for the code review sampling tool.
 * @module tests/examples/tools/template-code-review-sampling.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { codeReviewSamplingTool } from '../../../examples/mcp-server/tools/definitions/template-code-review-sampling.tool.js';

describe('codeReviewSamplingTool', () => {
  it('throws ServiceUnavailable when sampling is unavailable', async () => {
    const ctx = createMockContext();
    const input = codeReviewSamplingTool.input.parse({ code: 'const x = 1;' });
    const err = await Promise.resolve(codeReviewSamplingTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('performs code review via sampling', async () => {
    const ctx = createMockContext({
      sample: vi.fn().mockResolvedValue({
        role: 'assistant',
        content: { type: 'text', text: 'Looks good. No issues found.' },
        model: 'test-model',
        stopReason: 'endTurn',
      }),
    });
    const input = codeReviewSamplingTool.input.parse({
      code: 'function add(a, b) { return a + b; }',
      language: 'javascript',
      focus: 'general',
    });
    const result = await codeReviewSamplingTool.handler(input, ctx);
    expect(result.review).toBe('Looks good. No issues found.');
    expect(result.code).toBe('function add(a, b) { return a + b; }');
    expect(result.focus).toBe('general');
    expect(ctx.sample).toHaveBeenCalledOnce();
  });

  it('uses focus-specific instructions', async () => {
    const sampleFn = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: { type: 'text', text: 'Security review' },
      model: 'test-model',
      stopReason: 'endTurn',
    });
    const ctx = createMockContext({ sample: sampleFn });
    const input = codeReviewSamplingTool.input.parse({
      code: 'eval(userInput)',
      focus: 'security',
    });
    await codeReviewSamplingTool.handler(input, ctx);
    const callArgs = sampleFn.mock.calls[0]!;
    const prompt = (callArgs[0]![0]!.content as { text: string }).text;
    expect(prompt).toContain('security');
  });

  it('formats response with focus header', () => {
    const result = {
      code: 'x = 1',
      focus: 'security',
      review: 'No vulnerabilities found.',
    };
    const blocks = codeReviewSamplingTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Code Review (focus: security)');
    expect(text).toContain('No vulnerabilities found.');
    expect(text).toContain('x = 1');
  });
});
