/**
 * @fileoverview Tests for the code review prompt.
 * @module tests/smoke/prompts/code-review.prompt.test
 */
import { isCompletable } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { codeReviewPrompt } from '../../../examples/mcp-server/prompts/definitions/code-review.prompt.js';

async function promptText(rawArgs: Record<string, unknown>): Promise<string> {
  const messages = await codeReviewPrompt.generate(codeReviewPrompt.args!.parse(rawArgs));
  expect(messages).toHaveLength(1);
  return (messages[0]!.content as { text: string }).text;
}

describe('codeReviewPrompt', () => {
  it('makes language completable where the SDK looks for it', () => {
    // The SDK unwraps .optional() before checking, so the inner schema carries the completer.
    expect(isCompletable(codeReviewPrompt.args!.shape.language.unwrap())).toBe(true);
  });

  it('generates a user message with default focus', async () => {
    const messages = await codeReviewPrompt.generate(codeReviewPrompt.args!.parse({}));
    expect(messages[0]!.role).toBe('user');
    expect(await promptText({})).toContain('general');
  });

  it('includes language specialization', async () => {
    expect(await promptText({ language: 'rust' })).toContain('specializing in rust');
  });

  it('applies security focus', async () => {
    const text = await promptText({ focus: 'security' });
    expect(text).toContain('focus on security');
    expect(text).toContain('vulnerabilities');
  });

  it('includes example instructions when requested', async () => {
    expect(await promptText({ includeExamples: 'true' })).toContain(
      'concrete example of how to improve',
    );
  });

  it('excludes example instructions by default', async () => {
    expect(await promptText({})).not.toContain('concrete example of how to improve');
  });

  it('appends supplied code as a fenced block', async () => {
    const text = await promptText({ code: 'const x = 1;' });
    expect(text).toContain('Code to review:\n\n```\nconst x = 1;\n```');
  });

  it('lengthens the fence past backtick runs inside the code', async () => {
    const code = 'Example:\n```ts\nfoo();\n```';
    const text = await promptText({ code });
    expect(text).toContain(`\`\`\`\`\n${code}\n\`\`\`\``);
  });

  it('omits the code section when no code is supplied', async () => {
    expect(await promptText({})).not.toContain('Code to review:');
  });
});
