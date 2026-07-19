/**
 * @fileoverview Source-level public API type contract tests.
 * These assertions protect consumer-facing builder inference before the
 * slower built-package integration test runs against `dist/`.
 * @module tests/unit/public-api/type-contract.test
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APP_RESOURCE_MIME_TYPE,
  appResource,
  appTool,
  type ContentBlock,
  type CreateAppOptions,
  createFail,
  type PromptDefinition,
  prompt,
  type ResourceDefinition,
  resource,
  type ToolDefinition,
  tool,
  z,
} from '@/core/index.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

describe('public API type contract', () => {
  const input = z.object({
    message: z.string().describe('Message to echo'),
    count: z.number().optional().describe('Optional repeat count'),
  });
  const output = z.object({
    echoed: z.string().describe('Echoed message'),
    repeated: z.number().describe('Repeat count'),
  });
  const errors = [
    {
      reason: 'empty_message',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The message is empty.',
      recovery: 'Send a non-empty message and retry the call.',
    },
  ] as const;

  it('keeps tool() input, output, format, and ctx.fail inference intact', async () => {
    const echoTool = tool('typed_echo', {
      description: 'Echoes a message.',
      input,
      output,
      errors,
      handler: (value, ctx) => {
        expectTypeOf(value.message).toEqualTypeOf<string>();
        expectTypeOf(value.count).toEqualTypeOf<number | undefined>();
        expectTypeOf(ctx.fail).parameter(0).toEqualTypeOf<'empty_message'>();
        return { echoed: value.message, repeated: value.count ?? 1 };
      },
      format: (result) => {
        expectTypeOf(result.echoed).toEqualTypeOf<string>();
        expectTypeOf(result.repeated).toEqualTypeOf<number>();
        return [{ type: 'text', text: `${result.echoed} (${result.repeated})` }];
      },
    });

    const assignable: ToolDefinition<typeof input, typeof output, typeof errors> = echoTool;
    const fail = createFail(errors);
    const caught = fail('empty_message');

    expect(assignable.name).toBe('typed_echo');
    expect(caught.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(caught.data).toMatchObject({ reason: 'empty_message' });
    expect(await echoTool.handler({ message: 'ok' }, {} as never)).toEqual({
      echoed: 'ok',
      repeated: 1,
    });
  });

  it('keeps resource() params and output inference intact', async () => {
    const params = z.object({ id: z.string().describe('Resource ID') });
    const resourceOutput = z.object({ id: z.string().describe('Resource ID') });
    const typedResource = resource('typed://{id}', {
      description: 'Reads a typed resource.',
      params,
      output: resourceOutput,
      handler: (value) => {
        expectTypeOf(value.id).toEqualTypeOf<string>();
        return { id: value.id };
      },
    });

    const assignable: ResourceDefinition<typeof params, typeof resourceOutput> = typedResource;
    expect(assignable.uriTemplate).toBe('typed://{id}');
    expect(await typedResource.handler({ id: 'r1' }, {} as never)).toEqual({ id: 'r1' });
  });

  it('keeps prompt() argument inference intact', async () => {
    const args = z.object({
      topic: z.string().describe('Review topic'),
      tone: z.enum(['brief', 'detailed']).optional().describe('Response tone'),
    });
    const typedPrompt = prompt('typed_prompt', {
      description: 'Builds a typed prompt.',
      args,
      generate: (value) => {
        expectTypeOf(value.topic).toEqualTypeOf<string>();
        expectTypeOf(value.tone).toEqualTypeOf<'brief' | 'detailed' | undefined>();
        return [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: `${value.topic}:${value.tone ?? 'brief'}` },
          },
        ];
      },
    });

    const assignable: PromptDefinition<typeof args> = typedPrompt;
    expect(assignable.name).toBe('typed_prompt');
    expect(await Promise.resolve(typedPrompt.generate({ topic: 'exports' }))).toEqual([
      { role: 'user', content: { type: 'text', text: 'exports:brief' } },
    ]);
  });

  it('keeps app builders assignable through CreateAppOptions', () => {
    const typedAppResource = appResource('ui://typed/app.html', {
      name: 'typed_app_ui',
      description: 'Typed app UI.',
      params: z.object({}).describe('No parameters.'),
      handler: () => '<html></html>',
    });
    const typedAppTool = appTool('typed_app_open', {
      description: 'Opens a typed app.',
      resourceUri: 'ui://typed/app.html',
      input: z.object({}).describe('No input.'),
      output: z.object({ ok: z.boolean().describe('Whether the app opened') }),
      handler: () => ({ ok: true }),
    });

    const options = {
      tools: [typedAppTool],
      resources: [typedAppResource],
      prompts: [],
      setup(core) {
        expectTypeOf(core.storage).not.toBeAny();
      },
    } satisfies CreateAppOptions;

    expect(typedAppResource.mimeType).toBe(APP_RESOURCE_MIME_TYPE);
    const typedUi = typedAppTool._meta?.ui as Record<string, unknown>;
    expect(typedUi.resourceUri).toBe('ui://typed/app.html');
    expect(options.tools).toHaveLength(1);
    expect(options.resources).toHaveLength(1);
  });

  it('re-exports MCP content block types from the root entry point', () => {
    const block: ContentBlock = { type: 'text', text: 'ok' };
    expect(block).toEqual({ type: 'text', text: 'ok' });
  });
});
