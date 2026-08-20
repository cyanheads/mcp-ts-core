/**
 * @fileoverview Tests for `x-mcp-header` input designation (#360) — the
 * `headerParam()` helper, the emitted-JSON-Schema scan that mirrors the SDK's
 * own constraint checks, and the definition-time rejection `tool()` runs.
 * @module tests/unit/mcp-server/tools/utils/header-param.test
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJSONSchema } from 'zod/v4/core';

import {
  assertHeaderDesignations,
  formatDesignationPath,
  headerParam,
  scanHeaderDesignations,
  X_MCP_HEADER_KEY,
} from '@/mcp-server/tools/utils/headerParam.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';

/** Emits a schema the way the SDK does when it builds `inputSchema`. */
function emit(schema: z.ZodType): Record<string, unknown> {
  return toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
}

/** Reads an emitted property node by its `properties` path. */
function property(emitted: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  let node = emitted;
  for (const key of keys) {
    const properties = node.properties as Record<string, Record<string, unknown>>;
    node = properties[key] as Record<string, unknown>;
  }
  return node;
}

/** A minimal well-formed tool around the supplied input schema. */
function define(name: string, input: z.ZodType) {
  return tool(name, {
    description: 'Test tool.',
    input: input as never,
    output: z.object({ ok: z.boolean().describe('Whether it worked.') }),
    handler: () => ({ ok: true }),
  });
}

// ---------------------------------------------------------------------------
// headerParam() — emission
// ---------------------------------------------------------------------------

describe('headerParam', () => {
  it('lands the annotation on the emitted property and changes nothing else', () => {
    const plain = emit(z.object({ region: z.string().describe('Deployment region.') }));
    const designated = emit(
      z.object({ region: headerParam(z.string(), 'Region').describe('Deployment region.') }),
    );

    expect(property(designated, 'region')).toEqual({
      ...property(plain, 'region'),
      [X_MCP_HEADER_KEY]: 'Region',
    });
    // Requiredness and every sibling keyword are untouched.
    expect(designated.required).toEqual(plain.required);
    expect(designated.type).toBe(plain.type);
  });

  it('composes in either order without dropping the description', () => {
    const after = emit(z.object({ r: headerParam(z.string(), 'Region').describe('Region.') }));
    const before = emit(z.object({ r: headerParam(z.string().describe('Region.'), 'Region') }));

    expect(property(after, 'r')).toEqual(property(before, 'r'));
    expect(property(after, 'r')).toMatchObject({
      description: 'Region.',
      type: 'string',
      [X_MCP_HEADER_KEY]: 'Region',
    });
  });

  it('preserves the field type so validation still runs', () => {
    const schema = z.object({ tenant: headerParam(z.int().min(1), 'Tenant-Id').describe('T.') });

    expect(schema.safeParse({ tenant: 7 }).success).toBe(true);
    expect(schema.safeParse({ tenant: 0 }).success).toBe(false);
    expect(schema.safeParse({ tenant: 'seven' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanHeaderDesignations() — accepted placements
// ---------------------------------------------------------------------------

describe('scanHeaderDesignations — valid', () => {
  it('reports no designations for an undesignated schema', () => {
    const scan = scanHeaderDesignations(z.object({ q: z.string().describe('Q.') }));
    expect(scan).toEqual({ designations: [], valid: true });
  });

  it('collects a top-level designation with its emitted type', () => {
    const scan = scanHeaderDesignations(
      z.object({ region: headerParam(z.string(), 'Region').describe('R.') }),
    );

    expect(scan).toMatchObject({ valid: true });
    expect(scan?.valid && scan.designations).toEqual([
      { headerName: 'Region', path: [{ key: 'region', kind: 'property' }], type: 'string' },
    ]);
  });

  it('reaches a designation nested three objects deep', () => {
    const scan = scanHeaderDesignations(
      z.object({
        a: z
          .object({
            b: z
              .object({ region: headerParam(z.string(), 'Region').describe('R.') })
              .describe('B.'),
          })
          .describe('A.'),
      }),
    );

    expect(scan?.valid && formatDesignationPath(scan.designations[0]!.path, 'input')).toBe(
      'input.a.b.region',
    );
  });

  it('accepts every primitive type the SDK permits, number included', () => {
    const scan = scanHeaderDesignations(
      z.object({
        b: headerParam(z.boolean(), 'B').describe('B.'),
        i: headerParam(z.int(), 'I').describe('I.'),
        // The spec text excludes `number`; the SDK release this targets accepts
        // it, and matching the runtime is the point of this scan.
        n: headerParam(z.number(), 'N').describe('N.'),
        s: headerParam(z.string(), 'S').describe('S.'),
      }),
    );

    expect(scan?.valid && scan.designations.map((d) => d.type).sort()).toEqual([
      'boolean',
      'integer',
      'number',
      'string',
    ]);
  });

  it('treats distinct names differing only beyond case as unique', () => {
    const scan = scanHeaderDesignations(
      z.object({
        a: headerParam(z.string(), 'Region').describe('A.'),
        b: headerParam(z.string(), 'Region-Id').describe('B.'),
      }),
    );

    expect(scan).toMatchObject({ valid: true });
  });

  it('returns undefined when the schema cannot be converted to JSON Schema', () => {
    // `schema-serializable` owns this finding; the SDK swallows the same
    // conversion error around its own scan rather than reporting it twice.
    expect(scanHeaderDesignations(z.object({ when: z.date() }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scanHeaderDesignations() — rejected placements
// ---------------------------------------------------------------------------

describe('scanHeaderDesignations — invalid', () => {
  const reachability = (schema: z.ZodType, expectedPath: string) => {
    const scan = scanHeaderDesignations(schema);
    expect(scan).toMatchObject({ valid: false });
    expect(scan?.valid === false && formatDesignationPath(scan.path, 'input')).toBe(expectedPath);
    expect(scan?.valid === false && scan.reason).toContain('statically reachable');
  };

  it('rejects a designation on an array element', () => {
    reachability(
      z.object({
        list: z
          .array(z.object({ region: headerParam(z.string(), 'Region').describe('R.') }))
          .describe('L.'),
      }),
      'input.list[].region',
    );
  });

  it('rejects a designation on a z.record() value', () => {
    reachability(
      z.object({ map: z.record(z.string(), headerParam(z.string(), 'Region')).describe('M.') }),
      'input.map.<key>',
    );
  });

  it('rejects a designation inside an object nested under an array element', () => {
    reachability(
      z.object({
        rows: z
          .array(
            z
              .object({ meta: z.object({ r: headerParam(z.string(), 'R').describe('R.') }) })
              .describe('Row.'),
          )
          .describe('Rows.'),
      }),
      'input.rows[].meta.r',
    );
  });

  it('rejects a designation in a nested union branch', () => {
    reachability(
      z.object({
        choice: z
          .union([
            z.object({ r: headerParam(z.string(), 'R').describe('R.') }).describe('One.'),
            z.object({ o: z.string().describe('O.') }).describe('Two.'),
          ])
          .describe('C.'),
      }),
      'input.choice|0.r',
    );
  });

  it('rejects a designation on a discriminated-union input root, naming the branch', () => {
    reachability(
      z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('byId').describe('By ID.'),
          region: headerParam(z.string(), 'Region').describe('R.'),
        }),
        z.object({
          mode: z.literal('byName').describe('By name.'),
          name: z.string().describe('N.'),
        }),
      ]),
      'input|0.region',
    );
  });

  it('rejects a designation that only reaches the schema through a $ref', () => {
    // A schema reused under a `.meta({ id })` is hoisted into `$defs` and
    // referenced — the annotation then lives outside the `properties` chain.
    const shared = headerParam(z.string(), 'Region').meta({ id: 'RegionString' }).describe('R.');
    reachability(z.object({ a: shared, b: shared }), 'input.<$defs:RegionString>');
  });

  it('rejects an empty header name', () => {
    const scan = scanHeaderDesignations(
      z.object({ r: headerParam(z.string(), '').describe('R.') }),
    );
    expect(scan?.valid === false && scan.reason).toContain('non-empty string');
  });

  it('rejects a header name that is not an RFC 9110 token', () => {
    for (const name of ['Bad Name', 'Bad:Name', 'Bad\nName', 'Bad,Name']) {
      const scan = scanHeaderDesignations(
        z.object({ r: headerParam(z.string(), name).describe('R.') }),
      );
      expect(scan?.valid === false && scan.reason).toContain('RFC 9110 token');
    }
  });

  it('rejects a non-primitive designated property', () => {
    const scan = scanHeaderDesignations(
      z.object({ r: headerParam(z.object({ x: z.string().describe('X.') }), 'R').describe('R.') }),
    );
    expect(scan?.valid === false && scan.reason).toContain('primitive-typed');
    expect(scan?.valid === false && scan.reason).toContain('type object');
  });

  it('rejects a case-insensitive duplicate and names the prior declaration', () => {
    const scan = scanHeaderDesignations(
      z.object({
        a: headerParam(z.string(), 'Region').describe('A.'),
        b: headerParam(z.string(), 'REGION').describe('B.'),
      }),
    );

    expect(scan?.valid === false && formatDesignationPath(scan.path, 'input')).toBe('input.b');
    expect(scan?.valid === false && scan.reason).toContain("'Region' is already declared");
  });
});

// ---------------------------------------------------------------------------
// Definition-time rejection
// ---------------------------------------------------------------------------

describe('assertHeaderDesignations', () => {
  it('accepts a schema with no designations', () => {
    expect(() =>
      assertHeaderDesignations('t', z.object({ q: z.string().describe('Q.') })),
    ).not.toThrow();
  });

  it('names the tool, the field path, and the reason', () => {
    expect(() =>
      assertHeaderDesignations(
        'my_tool',
        z.object({
          list: z
            .array(z.object({ r: headerParam(z.string(), 'R').describe('R.') }))
            .describe('L.'),
        }),
      ),
    ).toThrow(/Tool 'my_tool'.*input\.list\[\]\.r.*statically reachable/s);
  });

  it('explains why a discriminated-union root can carry no designation at all', () => {
    expect(() =>
      assertHeaderDesignations(
        'union_tool',
        z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('a').describe('A.'),
            r: headerParam(z.string(), 'R').describe('R.'),
          }),
          z.object({ mode: z.literal('b').describe('B.'), o: z.string().describe('O.') }),
        ]),
      ),
    ).toThrow(/discriminated-union input root/);
  });
});

describe('tool() rejects an invalid designation at definition time', () => {
  it('accepts a nested, reachable designation', () => {
    expect(() =>
      define(
        'valid_tool',
        z.object({
          nested: z
            .object({ region: headerParam(z.string(), 'Region').describe('R.') })
            .describe('N.'),
        }),
      ),
    ).not.toThrow();
  });

  it('throws on an array element', () => {
    expect(() =>
      define(
        'array_tool',
        z.object({
          list: z
            .array(z.object({ r: headerParam(z.string(), 'R').describe('R.') }))
            .describe('L.'),
        }),
      ),
    ).toThrow(/x-mcp-header/);
  });

  it('throws on a z.record() value', () => {
    expect(() =>
      define(
        'record_tool',
        z.object({ map: z.record(z.string(), headerParam(z.string(), 'R')).describe('M.') }),
      ),
    ).toThrow(/x-mcp-header/);
  });

  it('throws on any field of a discriminated-union input root', () => {
    expect(() =>
      define(
        'union_tool',
        z.discriminatedUnion('mode', [
          z.object({
            mode: z.literal('a').describe('A.'),
            r: headerParam(z.string(), 'R').describe('R.'),
          }),
          z.object({ mode: z.literal('b').describe('B.'), o: z.string().describe('O.') }),
        ]),
      ),
    ).toThrow(/x-mcp-header/);
  });

  it('throws on a duplicate header name', () => {
    expect(() =>
      define(
        'dup_tool',
        z.object({
          a: headerParam(z.string(), 'Region').describe('A.'),
          b: headerParam(z.string(), 'region').describe('B.'),
        }),
      ),
    ).toThrow(/case-insensitively unique/);
  });

  it('leaves the stored input schema untouched for an undesignated tool', () => {
    const raw = z.object({ q: z.string().describe('Q.'), n: z.number().optional().describe('N.') });
    const definition = define('plain_tool', raw);

    expect(emit(definition.input)).toEqual(emit(raw.strict()));
  });
});
