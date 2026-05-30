/**
 * @fileoverview Tests for the resource lint rules (`lintResourceDefinition`).
 * Exercises uriTemplate validation, name/description/handler requirements,
 * params/output schema checks, template↔params alignment, auth scopes, and
 * declarative error-contract wiring.
 * @module tests/unit/linter/resource-rules.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { lintResourceDefinition } from '@/linter/rules/resource-rules.js';

const handler = async () => ({});

/** Collects the `rule` field of every diagnostic for terse membership assertions. */
function rules(def: unknown): string[] {
  return lintResourceDefinition(def).map((d) => d.rule);
}

describe('lintResourceDefinition', () => {
  it('returns no diagnostics for a well-formed resource', () => {
    const diagnostics = lintResourceDefinition({
      uriTemplate: 'widget://{id}/data',
      name: 'widget_data',
      description: 'Fetch widget data by id.',
      params: z.object({ id: z.string().describe('Widget identifier') }),
      handler,
    });
    expect(diagnostics).toEqual([]);
  });

  describe('uriTemplate', () => {
    it('errors when uriTemplate is missing and reports the <unnamed> fallback', () => {
      const diagnostics = lintResourceDefinition({ description: 'x', handler });
      const uriReq = diagnostics.find((d) => d.rule === 'uri-template-required');
      expect(uriReq).toMatchObject({ severity: 'error', definitionName: '<unnamed>' });
    });

    it('errors on unbalanced (extra closing) braces', () => {
      expect(
        rules({ uriTemplate: 'widget://}{id}', name: 'w', description: 'x', handler }),
      ).toContain('uri-template-valid');
    });

    it('errors on an unclosed brace', () => {
      expect(
        rules({ uriTemplate: 'widget://{id', name: 'w', description: 'x', handler }),
      ).toContain('uri-template-valid');
    });

    it('errors on an empty variable name', () => {
      expect(rules({ uriTemplate: 'widget://{}', name: 'w', description: 'x', handler })).toContain(
        'uri-template-valid',
      );
    });
  });

  describe('name', () => {
    it('warns when name is omitted but a uriTemplate is present', () => {
      const diagnostics = rules({
        uriTemplate: 'widget://{id}',
        description: 'x',
        handler,
        params: z.object({ id: z.string().describe('id') }),
      });
      expect(diagnostics).toContain('resource-name-not-uri');
    });

    it('errors when an explicit name is not a non-empty string', () => {
      expect(rules({ uriTemplate: 'widget://x', name: 42, description: 'x', handler })).toContain(
        'name-required',
      );
    });
  });

  describe('description & handler', () => {
    it('warns when description is missing', () => {
      expect(rules({ uriTemplate: 'widget://x', name: 'w', handler })).toContain(
        'description-required',
      );
    });

    it('warns when description is an empty string', () => {
      expect(rules({ uriTemplate: 'widget://x', name: 'w', description: '', handler })).toContain(
        'description-required',
      );
    });

    it('errors when handler is not a function', () => {
      expect(rules({ uriTemplate: 'widget://x', name: 'w', description: 'x' })).toContain(
        'handler-required',
      );
    });
  });

  describe('params schema', () => {
    it('errors when params is not a z.object()', () => {
      expect(
        rules({
          uriTemplate: 'widget://x',
          name: 'w',
          description: 'x',
          handler,
          params: z.string(),
        }),
      ).toContain('schema-is-object');
    });

    it('warns when a params field lacks .describe()', () => {
      expect(
        rules({
          uriTemplate: 'widget://{id}',
          name: 'w',
          description: 'x',
          handler,
          params: z.object({ id: z.string() }),
        }),
      ).toContain('describe-on-fields');
    });

    it('errors when params contains a non-serializable type', () => {
      expect(
        rules({
          uriTemplate: 'widget://{when}',
          name: 'w',
          description: 'x',
          handler,
          params: z.object({ when: z.date().describe('when') }),
        }),
      ).toContain('schema-serializable');
    });

    it('errors when a uriTemplate variable has no matching params key', () => {
      expect(
        rules({
          uriTemplate: 'widget://{id}/{missing}',
          name: 'w',
          description: 'x',
          handler,
          params: z.object({ id: z.string().describe('id') }),
        }),
      ).toContain('template-params-align');
    });

    it('does not run alignment for a static uriTemplate with no variables', () => {
      expect(
        rules({
          uriTemplate: 'widget://all',
          name: 'w',
          description: 'x',
          handler,
          params: z.object({ id: z.string().describe('id') }),
        }),
      ).not.toContain('template-params-align');
    });
  });

  describe('auth, output & error contract wiring', () => {
    it('surfaces auth-scope diagnostics when auth is not an array', () => {
      expect(
        rules({ uriTemplate: 'widget://x', name: 'w', description: 'x', handler, auth: 'admin' }),
      ).toContain('auth-type');
    });

    it('errors when output is present but not a z.object()', () => {
      expect(
        rules({
          uriTemplate: 'widget://x',
          name: 'w',
          description: 'x',
          handler,
          output: z.string(),
        }),
      ).toContain('schema-is-object');
    });

    it('errors when output contains a non-serializable type', () => {
      expect(
        rules({
          uriTemplate: 'widget://x',
          name: 'w',
          description: 'x',
          handler,
          output: z.object({ when: z.date().describe('when') }),
        }),
      ).toContain('schema-serializable');
    });

    it('validates a declared error contract (non-array is rejected)', () => {
      expect(
        rules({ uriTemplate: 'widget://x', name: 'w', description: 'x', handler, errors: 'nope' }),
      ).toContain('error-contract-type');
    });
  });
});
