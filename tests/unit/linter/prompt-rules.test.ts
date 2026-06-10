/**
 * @fileoverview Tests for the prompt lint rules (`lintPromptDefinition`).
 * Exercises name/description/generate requirements, args schema checks,
 * and that completable()-wrapped args pass all rules without carve-outs.
 * @module tests/unit/linter/prompt-rules.test
 */

import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lintPromptDefinition } from '@/linter/rules/prompt-rules.js';

const generate = () => [
  { role: 'user' as const, content: { type: 'text' as const, text: 'Hello' } },
];

/** Collects the `rule` field of every diagnostic for terse membership assertions. */
function rules(def: unknown): string[] {
  return lintPromptDefinition(def).map((d) => d.rule);
}

describe('lintPromptDefinition', () => {
  it('returns no diagnostics for a well-formed prompt', () => {
    const diagnostics = lintPromptDefinition({
      name: 'code_review',
      description: 'Review code for issues.',
      generate,
    });
    expect(diagnostics).toEqual([]);
  });

  it('returns no diagnostics for a well-formed prompt with args', () => {
    const diagnostics = lintPromptDefinition({
      name: 'code_review',
      description: 'Review code for issues.',
      args: z.object({ code: z.string().describe('Code to review') }),
      generate,
    });
    expect(diagnostics).toEqual([]);
  });

  describe('name', () => {
    it('errors when name is missing', () => {
      const diagnostics = lintPromptDefinition({ description: 'x', generate });
      const nameReq = diagnostics.find((d) => d.rule === 'name-required');
      expect(nameReq).toBeDefined();
    });

    it('errors when name is not a string', () => {
      expect(rules({ name: 42, description: 'x', generate })).toContain('name-required');
    });
  });

  describe('description', () => {
    it('warns when description is missing', () => {
      expect(rules({ name: 'p', generate })).toContain('description-required');
    });

    it('warns when description is empty', () => {
      expect(rules({ name: 'p', description: '', generate })).toContain('description-required');
    });
  });

  describe('generate', () => {
    it('errors when generate is missing', () => {
      expect(rules({ name: 'p', description: 'x' })).toContain('generate-required');
    });

    it('errors when generate is not a function', () => {
      expect(rules({ name: 'p', description: 'x', generate: 'oops' })).toContain(
        'generate-required',
      );
    });
  });

  describe('args schema', () => {
    it('errors when args is not a z.object()', () => {
      expect(rules({ name: 'p', description: 'x', generate, args: z.string() })).toContain(
        'schema-is-object',
      );
    });

    it('warns when an args field lacks .describe()', () => {
      expect(
        rules({
          name: 'p',
          description: 'x',
          generate,
          args: z.object({ language: z.string() }),
        }),
      ).toContain('describe-on-fields');
    });

    it('errors when args contains a non-serializable type', () => {
      expect(
        rules({
          name: 'p',
          description: 'x',
          generate,
          args: z.object({ when: z.date().describe('when') }),
        }),
      ).toContain('schema-serializable');
    });
  });

  describe('completable() compatibility', () => {
    it('produces no diagnostics for a completable()-wrapped, described arg', () => {
      const diagnostics = lintPromptDefinition({
        name: 'completable_prompt',
        description: 'Prompt with completable arg.',
        args: z.object({
          language: completable(z.string().describe('Programming language'), async (partial) =>
            ['typescript', 'python'].filter((l) => l.startsWith(partial)),
          ),
        }),
        generate,
      });
      expect(diagnostics).toEqual([]);
    });

    it('still warns when a completable()-wrapped field lacks .describe()', () => {
      // completable wraps the schema non-enumerably — the describe-on-fields
      // rule reads .description on the underlying schema, which is absent here.
      const diagnostics = lintPromptDefinition({
        name: 'missing_describe_completable',
        description: 'Should warn.',
        args: z.object({
          language: completable(z.string(), async (partial) =>
            ['typescript', 'python'].filter((l) => l.startsWith(partial)),
          ),
        }),
        generate,
      });
      expect(rules({ ...diagnostics })).not.toContain('schema-is-object');
      // The underlying z.string() has no .describe(), so describe-on-fields must fire
      const describeWarn = diagnostics.find((d) => d.rule === 'describe-on-fields');
      expect(describeWarn).toBeDefined();
    });

    it('validates from src/core/index.ts re-export — completable is accessible', async () => {
      // Smoke: completable from the framework entry works the same way
      const { completable: completableFromCore } = await import('@/core/index.js');
      const schema = completableFromCore(z.string().describe('lang'), async () => ['ts']);
      const { isCompletable: isCompletableFromCore } = await import('@/core/index.js');
      expect(isCompletableFromCore(schema)).toBe(true);
    });
  });
});
