/**
 * @fileoverview Tests for the echo message tool.
 * @module tests/examples/tools/template-echo-message.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  echoTool,
  TEST_ERROR_TRIGGER_MESSAGE,
} from '../../../examples/mcp-server/tools/definitions/template-echo-message.tool.js';

describe('echoTool', () => {
  it('echoes a message in standard mode', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'hello' });
    const result = await echoTool.handler(input, ctx);
    expect(result).toEqual({
      originalMessage: 'hello',
      formattedMessage: 'hello',
      repeatedMessage: 'hello',
      mode: 'standard',
      repeatCount: 1,
    });
  });

  it('output conforms to the declared output schema', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'hello', includeTimestamp: true });
    const result = await echoTool.handler(input, ctx);
    expect(result).toEqual(expect.schemaMatching(echoTool.output));
  });

  it('applies uppercase mode', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'hello', mode: 'uppercase' });
    const result = await echoTool.handler(input, ctx);
    expect(result.formattedMessage).toBe('HELLO');
    expect(result.repeatedMessage).toBe('HELLO');
  });

  it('applies lowercase mode', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'Hello World', mode: 'lowercase' });
    const result = await echoTool.handler(input, ctx);
    expect(result.formattedMessage).toBe('hello world');
  });

  it('repeats the message', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'hi', repeat: 3 });
    const result = await echoTool.handler(input, ctx);
    expect(result.repeatedMessage).toBe('hi hi hi');
    expect(result.repeatCount).toBe(3);
  });

  it('includes timestamp when requested', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'hello', includeTimestamp: true });
    const result = await echoTool.handler(input, ctx);
    expect(result.timestamp).toBeDefined();
    expect(() => new Date(result.timestamp!).toISOString()).not.toThrow();
  });

  it('throws McpError on error trigger', () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: TEST_ERROR_TRIGGER_MESSAGE });
    expect(() => echoTool.handler(input, ctx)).toThrow('Deliberate failure triggered.');
  });

  it('validates input schema rejects empty message', () => {
    const result = echoTool.input.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  it('formats response correctly', () => {
    const result = {
      originalMessage: 'hello',
      formattedMessage: 'hello',
      repeatedMessage: 'hello',
      mode: 'standard' as const,
      repeatCount: 1,
    };
    const blocks = echoTool.format!(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('originalMessage');
    expect(text).toContain('formattedMessage');
    expect(text).toContain('repeatCount');
    expect(text).toContain('hello');
  });
});
