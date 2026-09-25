/**
 * @fileoverview Tests for prompt definition interface and builder.
 * @module tests/mcp-server/prompts/utils/promptDefinition.test
 */

import { describe, expect, it } from 'vitest';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';

describe('prompt() builder', () => {
  it('creates a prompt definition with name extracted', () => {
    const generate = () => [
      { role: 'user' as const, content: { type: 'text' as const, text: 'Hi' } },
    ];
    const def = prompt('my_prompt', {
      description: 'Test prompt',
      title: 'Titled Prompt',
      generate,
    });

    expect(def).toEqual({
      name: 'my_prompt',
      description: 'Test prompt',
      title: 'Titled Prompt',
      generate,
    });
  });
});
