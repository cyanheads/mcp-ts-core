/**
 * @fileoverview Tests for the tokenCounter utility.
 * @module tests/utils/metrics/tokenCounter.test
 */
import { describe, expect, it } from 'vitest';

import {
  type ChatMessage,
  countChatTokens,
  countTokens,
} from '../../../../src/utils/metrics/tokenCounter.js';

describe('tokenCounter', () => {
  describe('countTokens', () => {
    it('should count tokens in a simple string (approximate)', async () => {
      const text = 'hello world';
      const tokenCount = await countTokens(text);
      expect(tokenCount).toBeGreaterThan(0);
      expect(tokenCount).toBeLessThanOrEqual(4);
    });

    it('should return 0 for an empty string', async () => {
      const text = '';
      const tokenCount = await countTokens(text);
      expect(tokenCount).toBe(0);
    });

    it('returns 0 for a whitespace-only string', async () => {
      expect(await countTokens('   \n\t  ')).toBe(0);
    });

    it('falls back to the default heuristic for an unrecognized model', async () => {
      // > 53 chars so the error-handler input sample exercises the truncation path.
      const text = 'lorem ipsum dolor sit amet consectetur adipiscing elit';
      const known = await countTokens(text, undefined, 'gpt-4o-mini');
      const unknown = await countTokens(text, undefined, 'some-unrecognized-model');
      expect(known).toBeGreaterThan(0);
      expect(unknown).toBe(known);
    });
  });

  describe('countChatTokens', () => {
    it('should estimate tokens for a series of chat messages', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, how are you?' },
        {
          role: 'assistant',
          content: 'I am fine, thank you!',
        },
      ];
      const tokenCount = await countChatTokens(messages);
      expect(tokenCount).toBeGreaterThan(10);
    });

    it('should handle tool calls in assistant messages', async () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location": "Boston, MA"}',
              },
            },
          ],
        },
      ];
      const tokenCount = await countChatTokens(messages);
      expect(tokenCount).toBeGreaterThan(5);
    });

    it('should handle multi-part user messages', async () => {
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,' },
            },
          ],
        },
      ];
      const tokenCount = await countChatTokens(messages);
      expect(tokenCount).toBeGreaterThan(5);
    });

    it('should include name overhead when a message defines name', async () => {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          name: 'context-provider',
          content: 'You set contextual instructions for the assistant.',
        },
      ];

      const withoutName = await countChatTokens([
        { role: 'system', content: messages[0]!.content },
      ]);
      const withName = await countChatTokens(messages);

      expect(withName).toBeGreaterThan(withoutName);
    });

    it('counts tool-role messages by their tool_call_id', async () => {
      const withId = await countChatTokens([
        { role: 'tool', tool_call_id: 'call_abc123', content: 'result payload' },
      ]);
      const withoutId = await countChatTokens([{ role: 'tool', content: 'result payload' }]);
      expect(withId).toBeGreaterThan(withoutId);
    });
  });
});
