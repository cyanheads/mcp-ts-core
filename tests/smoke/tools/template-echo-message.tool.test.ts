/**
 * @fileoverview Tests for the echo message tool.
 * @module tests/smoke/tools/template-echo-message.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { describe, expect, it } from 'vitest';
import {
  echoTool,
  TEST_ERROR_TRIGGER_MESSAGE,
} from '../../../examples/mcp-server/tools/definitions/template-echo-message.tool.js';

/** A context typed against the tool's `errors[]` contract, as the handler expects. */
const echoContext = () => createMockContext({ errors: echoTool.errors });

describe('echoTool', () => {
  it('echoes a message in standard mode', async () => {
    const input = echoTool.input.parse({ message: 'hello' });
    const result = await echoTool.handler(input, echoContext());
    expect(result).toEqual({
      originalMessage: 'hello',
      formattedMessage: 'hello',
      repeatedMessage: 'hello',
      mode: 'standard',
      repeatCount: 1,
    });
  });

  it('applies uppercase mode', async () => {
    const input = echoTool.input.parse({ message: 'hello', mode: 'uppercase' });
    const result = await echoTool.handler(input, echoContext());
    expect(result.formattedMessage).toBe('HELLO');
    expect(result.repeatedMessage).toBe('HELLO');
  });

  it('applies lowercase mode', async () => {
    const input = echoTool.input.parse({ message: 'Hello World', mode: 'lowercase' });
    const result = await echoTool.handler(input, echoContext());
    expect(result.formattedMessage).toBe('hello world');
  });

  it('repeats the message', async () => {
    const input = echoTool.input.parse({ message: 'hi', repeat: 3 });
    const result = await echoTool.handler(input, echoContext());
    expect(result.repeatedMessage).toBe('hi hi hi');
    expect(result.repeatCount).toBe(3);
  });

  it('includes timestamp when requested', async () => {
    const input = echoTool.input.parse({ message: 'hello', includeTimestamp: true });
    const result = await echoTool.handler(input, echoContext());
    expect(result.timestamp).toBeDefined();
    expect(result).toEqual(expect.schemaMatching(echoTool.output));
  });

  it('fails with the reserved_message contract on the error trigger', async () => {
    const input = echoTool.input.parse({ message: TEST_ERROR_TRIGGER_MESSAGE });
    const ctx = echoContext();
    await expect((async () => echoTool.handler(input, ctx))()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'reserved_message', recovery: { hint: expect.any(String) } },
    });
  });

  it('accepts the declared text alias for message', async () => {
    const result = await runToolContract(echoTool, { text: 'hi' } as never);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      originalMessage: 'hi',
      repeatedMessage: 'hi',
    });
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

  it('renders a long repeated message in full', async () => {
    const message = 'x'.repeat(300);
    const input = echoTool.input.parse({ message, repeat: 2 });
    const result = await echoTool.handler(input, echoContext());
    const text = (echoTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain(result.repeatedMessage);
  });
});

toolContractSuite(echoTool, {
  success: [
    {
      name: 'echoes a formatted, repeated message',
      input: { message: 'contract', mode: 'uppercase', repeat: 2 },
      expected: { repeatedMessage: 'CONTRACT CONTRACT', repeatCount: 2 },
    },
  ],
  errors: [
    {
      name: 'rejects the reserved trigger',
      input: { message: TEST_ERROR_TRIGGER_MESSAGE },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'reserved_message',
    },
  ],
});
