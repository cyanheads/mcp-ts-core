/**
 * @fileoverview Tests for prompt definition interface and builder.
 * @module tests/mcp-server/prompts/utils/promptDefinition.test
 */

import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';

describe('PromptDefinition', () => {
  it('should be satisfiable without an arguments schema', () => {
    const definition: PromptDefinition = {
      name: 'test_prompt',
      description: 'A test prompt',
      generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
    };

    expect(definition.name).toBe('test_prompt');
    expect(typeof definition.generate).toBe('function');
  });

  it('should be satisfiable with an arguments schema', () => {
    const argsSchema = z.object({ topic: z.string().describe('The topic') });

    const definition: PromptDefinition<typeof argsSchema> = {
      name: 'review_prompt',
      description: 'A review prompt',
      args: argsSchema,
      generate: (args) => [
        { role: 'user', content: { type: 'text', text: `Review: ${args.topic}` } },
      ],
    };

    expect(definition.args).toBe(argsSchema);
    expect(definition.name).toBe('review_prompt');
  });
});

describe('prompt() builder', () => {
  it('creates a prompt definition with name extracted', () => {
    const def = prompt('my_prompt', {
      description: 'Test prompt',
      generate: () => [{ role: 'user', content: { type: 'text', text: 'Hi' } }],
    });

    expect(def.name).toBe('my_prompt');
    expect(def.description).toBe('Test prompt');
    expect(typeof def.generate).toBe('function');
  });

  it('creates a prompt definition with args schema', () => {
    const def = prompt('review', {
      description: 'Code review',
      args: z.object({ code: z.string().describe('Code to review') }),
      generate: (args) => [
        { role: 'user', content: { type: 'text', text: `Review: ${args.code}` } },
      ],
    });

    expect(def.name).toBe('review');
    expect(def.args).toBeDefined();
    const parsed = def.args!.parse({ code: 'const x = 1;' });
    expect(parsed.code).toBe('const x = 1;');
  });

  it('generate produces correct messages without args', async () => {
    const def = prompt('greeting', {
      description: 'A greeting prompt',
      generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello!' } }],
    });

    const messages = await def.generate({} as Record<string, never>);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toEqual({ type: 'text', text: 'Hello!' });
  });

  it('generate produces messages from args', async () => {
    const def = prompt('review', {
      description: 'Code review',
      args: z.object({
        code: z.string().describe('Code'),
        language: z.string().optional().describe('Language'),
      }),
      generate: (args) => [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review this ${args.language ?? 'unknown'} code:\n${args.code}`,
          },
        },
      ],
    });

    const messages = await def.generate({ code: 'fn main() {}', language: 'rust' });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toContain('rust');
    expect((messages[0]!.content as { text: string }).text).toContain('fn main()');
  });

  it('generate can produce multi-turn messages', async () => {
    const def = prompt('conversation', {
      description: 'Multi-turn',
      args: z.object({ topic: z.string().describe('Topic') }),
      generate: (args) => [
        { role: 'user', content: { type: 'text', text: `Tell me about ${args.topic}` } },
        {
          role: 'assistant',
          content: { type: 'text', text: `Sure, let me explain ${args.topic}.` },
        },
        { role: 'user', content: { type: 'text', text: 'Go deeper.' } },
      ],
    });

    const messages = await def.generate({ topic: 'MCP' });
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[2]!.role).toBe('user');
  });

  it('supports async generate', async () => {
    const def = prompt('async_prompt', {
      description: 'Async prompt',
      args: z.object({ query: z.string().describe('Query') }),
      generate: async (args) => {
        await Promise.resolve();
        return [{ role: 'user' as const, content: { type: 'text' as const, text: args.query } }];
      },
    });

    const messages = await def.generate({ query: 'hello' });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('hello');
  });

  it('accepts optional title field', () => {
    const def = prompt('titled_prompt', {
      description: 'A prompt with a display title.',
      title: 'Titled Prompt',
      generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
    });

    expect(def.title).toBe('Titled Prompt');
    expect(def.name).toBe('titled_prompt');
  });

  it('title is optional — omitting it leaves the field undefined', () => {
    const def = prompt('no_title_prompt', {
      description: 'A prompt without a title.',
      generate: () => [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
    });

    expect(def.title).toBeUndefined();
  });

  it('accepts completable()-wrapped args without TypeScript error', () => {
    const argsSchema = z.object({
      language: completable(z.string().describe('Programming language'), async (partial) =>
        ['typescript', 'python', 'rust'].filter((l) => l.startsWith(partial)),
      ),
    });

    const def = prompt('completable_prompt', {
      description: 'Prompt with completable arg.',
      args: argsSchema,
      generate: (args) => [
        { role: 'user', content: { type: 'text', text: `Language: ${args.language}` } },
      ],
    });

    expect(def.args).toBeDefined();
    // The completable wrapper is non-enumerable so the arg still parses normally
    const parsed = def.args!.parse({ language: 'typescript' });
    expect(parsed.language).toBe('typescript');
  });
});
