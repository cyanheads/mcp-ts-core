/**
 * @fileoverview Tests for tool definition interface and `tool()` builder.
 * @module tests/mcp-server/tools/utils/toolDefinition.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AnyToolDefinition,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createMockContext } from '@/testing/index.js';

describe('ToolDefinition', () => {
  it('should be satisfiable with a minimal valid shape', () => {
    const definition: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      input: z.object({ msg: z.string().describe('Message') }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    };

    expect(definition.name).toBe('test_tool');
    expect(typeof definition.handler).toBe('function');
  });

  it('should accept all optional fields', () => {
    const inputSchema = z.object({ q: z.string().describe('Query') });
    const outputSchema = z.object({ result: z.string().describe('Result') });

    const definition: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
      name: 'full_tool',
      description: 'A fully specified tool',
      input: inputSchema,
      output: outputSchema,
      auth: ['tool:full:read'],
      task: false,
      title: 'Full Tool',
      annotations: { readOnlyHint: true },
      _meta: { version: '1.0' },
      handler: (input) => ({ result: input.q }),
      format: (result) => [{ type: 'text', text: result.result }],
    };

    expect(definition.auth).toEqual(['tool:full:read']);
    expect(definition.task).toBe(false);
    expect(definition.title).toBe('Full Tool');
    expect(definition.annotations?.readOnlyHint).toBe(true);
    expect(definition._meta?.version).toBe('1.0');
    expect(definition.format).toBeDefined();
  });
});

describe('ToolAnnotations', () => {
  it('should accept all hint fields', () => {
    const annotations: ToolAnnotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: 'My Tool',
    };

    expect(annotations.readOnlyHint).toBe(true);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.idempotentHint).toBe(true);
    expect(annotations.openWorldHint).toBe(false);
    expect(annotations.title).toBe('My Tool');
  });

  it('should allow arbitrary extra keys via index signature', () => {
    const annotations: ToolAnnotations = {
      readOnlyHint: true,
      customHint: 42,
    };

    expect(annotations.customHint).toBe(42);
  });
});

describe('AnyToolDefinition', () => {
  it('should accept heterogeneous tool definitions in an array', () => {
    const toolA = tool('tool_a', {
      description: 'Tool A',
      input: z.object({ x: z.number().describe('X value') }),
      output: z.object({ doubled: z.number() }),
      handler: (input) => ({ doubled: input.x * 2 }),
    });

    const toolB = tool('tool_b', {
      description: 'Tool B',
      input: z.object({ name: z.string().describe('Name') }),
      output: z.object({ greeting: z.string() }),
      handler: (input) => ({ greeting: `Hello ${input.name}` }),
    });

    const tools: AnyToolDefinition[] = [toolA, toolB];
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('tool_a');
    expect(tools[1]!.name).toBe('tool_b');
  });

  it('keeps enrichment tools assignable through the type erasure', () => {
    // A concrete enrichment field's narrow `render` param must not break
    // assignability to the type-erased AnyToolDefinition, exactly as `format`
    // and `handler` already guarantee via method-syntax bivariance.
    const withTrailer = tool('with_trailer', {
      description: 'Enrichment tool with a per-field trailer renderer.',
      input: z.object({ q: z.string().describe('Query') }),
      output: z.object({ ids: z.array(z.string()).describe('Result IDs') }),
      enrichment: {
        appliedFilters: z
          .object({ author: z.string().optional().describe('Author filter') })
          .describe('Filters applied'),
      },
      enrichmentTrailer: {
        appliedFilters: { render: (f) => `Author: ${f.author ?? 'none'}` },
      },
      handler: () => ({ ids: [] }),
    });

    // The `enrichment` block alone (no trailer literal) must stay assignable too.
    const withoutTrailer = tool('without_trailer', {
      description: 'Enrichment tool without a trailer literal.',
      input: z.object({ q: z.string().describe('Query') }),
      output: z.object({ ids: z.array(z.string()).describe('Result IDs') }),
      enrichment: { total: z.number().describe('Total matches') },
      handler: () => ({ ids: [] }),
    });

    const tools: AnyToolDefinition[] = [withTrailer, withoutTrailer];
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('with_trailer');
  });
});

describe('tool() builder', () => {
  it('creates a definition with name extracted from first argument', () => {
    const def = tool('my_tool', {
      description: 'Test tool',
      input: z.object({ value: z.string().describe('A value') }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    expect(def.name).toBe('my_tool');
    expect(def.description).toBe('Test tool');
    expect(typeof def.handler).toBe('function');
  });

  it('preserves input schema for validation', () => {
    const def = tool('schema_tool', {
      description: 'Schema test',
      input: z.object({
        query: z.string().min(1).describe('Search query'),
        limit: z.number().default(10).describe('Result limit'),
      }),
      output: z.object({ query: z.string(), limit: z.number() }),
      handler: (input) => ({ query: input.query, limit: input.limit }),
    });

    const parsed = def.input.parse({ query: 'test' });
    expect(parsed.query).toBe('test');
    expect(parsed.limit).toBe(10);

    const bad = def.input.safeParse({ query: '' });
    expect(bad.success).toBe(false);
  });

  it('preserves output schema', () => {
    const def = tool('output_tool', {
      description: 'Output test',
      input: z.object({ n: z.number().describe('Number') }),
      output: z.object({ doubled: z.number().describe('Doubled value') }),
      handler: (input) => ({ doubled: input.n * 2 }),
    });

    expect(def.output).toBeDefined();
    const result = def.output!.parse({ doubled: 10 });
    expect(result.doubled).toBe(10);
  });

  it('handler receives validated input and returns expected output', async () => {
    const def = tool('echo_tool', {
      description: 'Echo',
      input: z.object({ message: z.string().describe('Message') }),
      output: z.object({ echo: z.string().describe('Echoed message') }),
      handler: async (input) => ({ echo: `Echo: ${input.message}` }),
    });

    const ctx = createMockContext();
    const input = def.input.parse({ message: 'hello' });
    const result = await def.handler(input, ctx);
    expect(result.echo).toBe('Echo: hello');
  });

  it('handler can be synchronous', () => {
    const def = tool('sync_tool', {
      description: 'Sync tool',
      input: z.object({ x: z.number().describe('Input') }),
      output: z.object({ result: z.number() }),
      handler: (input) => ({ result: input.x + 1 }),
    });

    const ctx = createMockContext();
    const result = def.handler(def.input.parse({ x: 5 }), ctx);
    expect(result).toEqual({ result: 6 });
  });

  it('preserves auth scopes', () => {
    const def = tool('auth_tool', {
      description: 'Auth test',
      input: z.object({ id: z.string().describe('ID') }),
      output: z.object({ ok: z.boolean() }),
      auth: ['tool:auth:read', 'tool:auth:write'],
      handler: () => ({ ok: true }),
    });

    expect(def.auth).toEqual(['tool:auth:read', 'tool:auth:write']);
  });

  it('preserves annotations', () => {
    const def = tool('annotated_tool', {
      description: 'Annotated',
      input: z.object({ id: z.string().describe('ID') }),
      output: z.object({ ok: z.boolean() }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: () => ({ ok: true }),
    });

    expect(def.annotations?.readOnlyHint).toBe(true);
    expect(def.annotations?.idempotentHint).toBe(true);
    expect(def.annotations?.openWorldHint).toBe(false);
  });

  it('preserves task flag', () => {
    const def = tool('task_tool', {
      description: 'Task tool',
      task: true,
      input: z.object({ count: z.number().describe('Count') }),
      output: z.object({ done: z.boolean() }),
      handler: async () => ({ done: true }),
    });

    expect(def.task).toBe(true);
  });

  it('preserves format function', () => {
    const def = tool('formatted_tool', {
      description: 'Formatted',
      input: z.object({ msg: z.string().describe('Message') }),
      output: z.object({ text: z.string().describe('Text') }),
      handler: (input) => ({ text: input.msg }),
      format: (result) => [{ type: 'text', text: result.text }],
    });

    expect(def.format).toBeDefined();
    const blocks = def.format!({ text: 'hello' });
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('preserves _meta', () => {
    const def = tool('meta_tool', {
      description: 'Meta test',
      input: z.object({ x: z.string().describe('X') }),
      output: z.object({ ok: z.boolean() }),
      _meta: { appToolConfig: { inputComponent: 'textarea' } },
      handler: () => ({ ok: true }),
    });

    expect(def._meta?.appToolConfig).toEqual({ inputComponent: 'textarea' });
  });

  it('preserves title', () => {
    const def = tool('titled_tool', {
      description: 'Titled',
      title: 'My Titled Tool',
      input: z.object({ x: z.string().describe('X') }),
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    });

    expect(def.title).toBe('My Titled Tool');
  });
});
