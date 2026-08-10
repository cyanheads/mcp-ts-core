/**
 * @fileoverview Tests for the echo prompt.
 * @module tests/prompts/echo.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { echoPrompt } from '@/mcp-server/prompts/definitions/echo.prompt.js';

describe('echoPrompt', () => {
  it('generates a user message with the echoed text', async () => {
    const args = echoPrompt.args!.parse({ message: 'hello world' });
    // `generate` may be async — await covers both shapes.
    const messages = await echoPrompt.generate(args);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: { type: 'text', text: 'Echo: hello world' },
    });
  });
});
