/**
 * @fileoverview Unit tests for the shared Zod root-shape checks (#142) and the
 * walk from a root down an argument path (#566, #616, #599). The definition
 * builder, the server manifest, and the linter all classify a tool's `input`
 * through these, so the discriminated-vs-plain union distinction is what keeps
 * the three agreeing; the rejection hint and the argument repair resolve a
 * path's object and value through the same walk, transforms re-applied.
 * @module tests/unit/mcp-server/tools/utils/schemaShape.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  argumentAt,
  inputVariants,
  isDiscriminatedUnionSchema,
  isZodObjectSchema,
  objectSchemaAt,
  routesThroughPipe,
  routesThroughPipeAt,
  stepInto,
  type TransformCache,
} from '@/mcp-server/tools/utils/schemaShape.js';

const byId = z.object({ mode: z.literal('byId'), id: z.string() });
const byName = z.object({ mode: z.literal('byName'), name: z.string() });
const union = z.discriminatedUnion('mode', [byId, byName]);

describe('isZodObjectSchema', () => {
  it('true for a z.object()', () => {
    expect(isZodObjectSchema(z.object({}))).toBe(true);
  });

  it.each([
    ['a discriminated union', union],
    ['a non-object Zod schema', z.string()],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object with no _zod', {}],
    ['a string', 'not a schema'],
  ])('false for %s', (_label, value) => {
    expect(isZodObjectSchema(value)).toBe(false);
  });
});

describe('isDiscriminatedUnionSchema', () => {
  it('true for a z.discriminatedUnion()', () => {
    expect(isDiscriminatedUnionSchema(union)).toBe(true);
  });

  it('false for a plain z.union() — Zod tags both as `union`', () => {
    // The discriminator string is the only thing separating them, and a bare
    // union gives the model no key to choose a branch by.
    expect(isDiscriminatedUnionSchema(z.union([byId, byName]))).toBe(false);
  });

  it.each([
    ['a z.object()', z.object({})],
    ['null', null],
    ['undefined', undefined],
    ['a plain object with no _zod', {}],
  ])('false for %s', (_label, value) => {
    expect(isDiscriminatedUnionSchema(value)).toBe(false);
  });
});

describe('inputVariants', () => {
  it('returns a union’s options in declaration order', () => {
    expect(inputVariants(union)).toEqual([byId, byName]);
  });

  it('returns a single object root as its own only variant', () => {
    const single = z.object({ a: z.string() });
    expect(inputVariants(single)).toEqual([single]);
  });

  it.each([
    ['a plain z.union()', z.union([byId, byName])],
    ['a non-object Zod schema', z.string()],
    ['undefined', undefined],
  ])('returns nothing to walk for %s', (_label, value) => {
    expect(inputVariants(value)).toEqual([]);
  });
});

describe('stepInto', () => {
  it('reads an own property or array element', () => {
    expect(stepInto({ a: 1 }, 'a')).toBe(1);
    expect(stepInto(['x', 'y'], 1)).toBe('y');
  });

  it.each([
    ['an inherited property', {}, 'toString'],
    ['a missing key', { a: 1 }, 'b'],
    ['a step into a string', 'text', 0],
    ['a step into null', null, 'a'],
  ])('reads nothing for %s', (_label, value, step) => {
    expect(stepInto(value, step)).toBeUndefined();
  });
});

describe('objectSchemaAt', () => {
  const leaf = z.object({ note: z.string().optional() });
  const circle = z.object({ kind: z.literal('circle'), radius: z.number() });
  const square = z.object({ kind: z.literal('square'), side: z.number() });
  const root = z.object({
    leaf,
    optionalLeaf: leaf.optional(),
    defaultedLeaf: leaf.default({}),
    nullableLeaf: leaf.nullable(),
    lazyLeaf: z.lazy(() => leaf),
    pipedLeaf: leaf.pipe(z.object({ note: z.string().optional() })),
    rows: z.array(leaf),
    pair: z.tuple([z.string(), leaf]),
    byName: z.record(z.string(), leaf),
    byAnyKey: z.object({}).catchall(leaf),
    shape: z.discriminatedUnion('kind', [circle, square]),
    oneObject: z.union([z.string(), leaf]),
    twoObjects: z.union([leaf, z.object({ other: z.string() })]),
    text: z.string(),
  });

  it('returns the root itself for an empty path', () => {
    expect(objectSchemaAt(root, [], {})).toBe(root);
  });

  it.each([
    ['a nested object', ['leaf'], {}],
    ['an optional object', ['optionalLeaf'], {}],
    ['a defaulted object', ['defaultedLeaf'], {}],
    ['a nullable object', ['nullableLeaf'], {}],
    ['a lazy object', ['lazyLeaf'], {}],
    ['a pipe’s input object', ['pipedLeaf'], {}],
    ['an array element', ['rows', 1], { rows: [{}, {}] }],
    ['a tuple item', ['pair', 1], { pair: ['a', {}] }],
    ['a record value', ['byName', 'anyKey'], { byName: { anyKey: {} } }],
    ['an author catchall’s value', ['byAnyKey', 'anyKey'], { byAnyKey: { anyKey: {} } }],
    ['the one object option of a plain union', ['oneObject'], { oneObject: {} }],
  ])('walks into %s', (_label, path, value) => {
    const found = objectSchemaAt(root, path, value);

    expect(Object.keys(found?.shape ?? {})).toEqual(['note']);
  });

  it('follows the variant the argument’s own discriminator selects', () => {
    expect(objectSchemaAt(root, ['shape'], { shape: { kind: 'square' } })).toBe(square);
    expect(objectSchemaAt(root, ['shape'], { shape: { kind: 'circle' } })).toBe(circle);
  });

  it.each([
    ['an unrecognized discriminator', ['shape'], { shape: { kind: 'hexagon' } }],
    ['an absent discriminator', ['shape'], { shape: {} }],
    ['a union two object options satisfy', ['twoObjects'], {}],
    ['an undeclared key', ['missing'], {}],
    ['a string field', ['text'], {}],
    ['a string step into an array', ['rows', 'first'], { rows: [{}] }],
    ['a step below a leaf object’s string field', ['leaf', 'note'], { leaf: { note: 'x' } }],
  ])('resolves nothing for %s', (_label, path, value) => {
    expect(objectSchemaAt(root, path, value)).toBeUndefined();
  });

  it('reads a z.lazy() inner schema once, however deep the path recurses', () => {
    let getterCalls = 0;
    const Node: z.ZodType = z.lazy(() => {
      getterCalls++;
      return z.object({ child: Node.optional(), note: z.string().optional() });
    });
    let value: Record<string, unknown> = { note: 'x' };
    const path: PropertyKey[] = ['root'];
    for (let level = 0; level < 50; level++) {
      value = { child: value };
      path.push('child');
    }

    const found = objectSchemaAt(z.object({ root: Node }), path, { root: value });
    objectSchemaAt(z.object({ root: Node }), path, { root: value });

    expect(Object.keys(found?.shape ?? {})).toEqual(['child', 'note']);
    expect(getterCalls).toBe(1);
  });

  describe('through a transform (#599)', () => {
    const item = z.object({ name: z.string() });
    const wrapped = z.object({
      items: z.preprocess((value) => (Array.isArray(value) ? value : [value]), z.array(item)),
      parsed: z
        .string()
        .transform((text) => JSON.parse(text) as unknown)
        .pipe(item),
      broken: z.preprocess(() => {
        throw new Error('no');
      }, z.array(item)),
    });

    it('walks a z.preprocess output beside what the transform made of the value', () => {
      expect(objectSchemaAt(wrapped, ['items', 0], { items: { name: 'a' } })).toBe(item);
    });

    it('walks a .transform().pipe() output', () => {
      expect(objectSchemaAt(wrapped, ['parsed'], { parsed: '{"name":"a"}' })).toBe(item);
    });

    it('resolves nothing through a transform that throws when re-applied', () => {
      expect(objectSchemaAt(wrapped, ['broken', 0], { broken: { name: 'a' } })).toBeUndefined();
    });
  });

  it('follows the plain union option whose single-valued literal tag matches (#570)', () => {
    const a = z.object({ kind: z.literal('a'), note: z.string().optional() });
    const b = z.object({ kind: z.enum(['b']), other: z.string() });
    const tagged = z.object({ target: z.union([a, b]) });

    expect(objectSchemaAt(tagged, ['target'], { target: { kind: 'a' } })).toBe(a);
    expect(objectSchemaAt(tagged, ['target'], { target: { kind: 'b' } })).toBe(b);
    expect(objectSchemaAt(tagged, ['target'], { target: { kind: 'c' } })).toBeUndefined();
    expect(objectSchemaAt(tagged, ['target'], { target: {} })).toBeUndefined();
  });
});

describe('argumentAt (#599)', () => {
  const item = z.object({ name: z.string(), year: z.string().optional() });
  /** Wraps a lone object as a one-element list, counting its runs. */
  let runs = 0;
  const wrap = (value: unknown) => {
    runs++;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? [value] : value;
  };
  const split = (value: unknown) => (typeof value === 'string' ? value.split(',') : value);
  const root = z.object({
    plain: z.object({ inner: z.string() }),
    items: z.preprocess(wrap, z.array(item)).optional(),
    groups: z.preprocess(
      wrap,
      z.array(z.object({ tags: z.preprocess(split, z.array(z.string())) })),
    ),
    blank: z.preprocess((value) => (value === '' ? undefined : value), z.string()).optional(),
    piped: z
      .string()
      .transform((text) => text.split(','))
      .pipe(z.array(z.enum(['x', 'y']))),
    either: z.union([z.array(z.preprocess(split, z.array(z.string()))), z.number()]),
    open: z.object({}).catchall(z.number()),
    openItems: z.object({}).catchall(z.preprocess(wrap, z.array(item))),
    known: z.preprocess(
      (value) =>
        Array.isArray(value) ? value.map((name) => (name === 'one' ? 1 : undefined)) : value,
      z.array(z.number()),
    ),
    broken: z.preprocess(() => {
      throw new Error('no');
    }, z.array(item)),
  });

  it('reads the value as sent where no transform sits on the path', () => {
    const at = argumentAt(root, ['plain', 'inner'], { plain: { inner: 'x' } });

    expect(at).toEqual({
      known: true,
      received: 'x',
      sent: 'x',
      sites: [],
      transformed: false,
      value: 'x',
    });
  });

  describe('what the caller sent at the path', () => {
    it('is the value in front of a transform the path ends on, not what it made of it', () => {
      expect(argumentAt(root, ['blank'], { blank: '' })).toMatchObject({
        received: undefined,
        sent: '',
      });
    });

    it('is the value in front of a transform the path ends on below another transform', () => {
      const at = argumentAt(root, ['groups', 0, 'tags'], { groups: { tags: 'a,b' } });

      expect(at).toMatchObject({ received: ['a', 'b'], sent: 'a,b', transformed: true });
    });

    it('is the argument as sent at the same path below a transform above it', () => {
      // The output's `undefined` is the transform's: the caller sent a name there.
      expect(argumentAt(root, ['known', 0], { known: ['two'] })).toMatchObject({
        received: undefined,
        sent: 'two',
      });
      // A lone object a preprocess wraps holds no year, and neither does the output.
      expect(argumentAt(root, ['items', 0, 'year'], { items: { name: 'abc' } })).toMatchObject({
        received: undefined,
        sent: undefined,
      });
    });
  });

  it('reads on in the value where the schema declares nothing', () => {
    expect(argumentAt(root, ['plain', 'extra'], { plain: { extra: 'x' } }).value).toBe('x');
    expect(argumentAt(root, ['nowhere', 0], { nowhere: ['x'] }).value).toBe('x');
  });

  it('reads an undeclared key’s value through an author catchall', () => {
    expect(argumentAt(root, ['open', 'extra'], { open: { extra: 'x' } }).value).toBe('x');

    const lone = { name: 'abc', year: 2020 };
    const at = argumentAt(root, ['openItems', 'extra', 0, 'year'], { openItems: { extra: lone } });

    expect(at.value).toBe(2020);
    expect(at.sites).toEqual([{ depth: 2, output: [lone], transform: expect.anything() }]);
  });

  it.each([
    ['.passthrough()', z.object({ kind: z.literal('b').optional() }).passthrough()],
    ['.catchall(z.any())', z.object({ kind: z.literal('b').optional() }).catchall(z.any())],
    ['.strict()', z.object({ kind: z.literal('b').optional() }).strict()],
  ])('follows the option declaring a key beside one open by %s', (_label, open) => {
    const field = z.object({
      field: z.union([
        z.object({
          kind: z.literal('a').optional(),
          k: z.preprocess((value) => (value === '' ? undefined : value), z.string()),
        }),
        open,
      ]),
    });
    const at = argumentAt(field, ['field', 'k'], { field: { kind: 'a', k: '' } });

    // Read through the declaring option, whose preprocess made `undefined` of the blank.
    expect(at).toMatchObject({ known: true, received: undefined, transformed: true, value: '' });
  });

  it('reads on in the value where one option declares a key and another types it with a catchall', () => {
    const field = z.object({
      field: z.union([
        z.object({
          kind: z.literal('a').optional(),
          k: z.preprocess((value) => (value === '' ? undefined : value), z.string()),
        }),
        z.object({ kind: z.literal('b').optional() }).catchall(z.string()),
      ]),
    });
    const at = argumentAt(field, ['field', 'k'], { field: { kind: 'a', k: '' } });

    expect(at).toMatchObject({ known: true, received: '', transformed: false, value: '' });
  });

  it('reads a value inside a transform output, naming the transform it sits in', () => {
    const lone = { name: 'abc', year: 2020 };
    const at = argumentAt(root, ['items', 0, 'year'], { items: lone });

    expect(at.value).toBe(2020);
    expect(at.received).toBe(2020);
    expect(at.transformed).toBe(false);
    expect(at.sites).toEqual([{ depth: 1, output: [lone], transform: expect.anything() }]);
  });

  it('names every transform of a nested chain, outermost first', () => {
    const at = argumentAt(root, ['groups', 0, 'tags', 1], { groups: { tags: 'a,b' } });

    expect(at.value).toBe('b');
    expect(at.sites.map((site) => site.depth)).toEqual([1, 3]);
    expect(at.sites[1]?.output).toEqual(['a', 'b']);
  });

  it('separates the value at a path that ends on a transform from what it received', () => {
    const at = argumentAt(root, ['blank'], { blank: '' });

    expect(at).toMatchObject({ known: true, received: undefined, transformed: true, value: '' });
    expect(at.sites).toEqual([]);
  });

  it('never runs a transform a path ends on when the value there is absent', () => {
    runs = 0;
    const at = argumentAt(root, ['items'], {});

    expect(at).toMatchObject({ known: true, received: undefined, transformed: false });
    expect(runs).toBe(0);
  });

  it('walks the input side of a .transform().pipe() that rejects the value as sent', () => {
    const at = argumentAt(root, ['piped'], { piped: 5 });

    expect(at).toMatchObject({ known: true, received: 5, transformed: false, value: 5 });
  });

  it('walks a .transform().pipe() output when its input side accepts', () => {
    const at = argumentAt(root, ['piped', 1], { piped: 'x,z' });

    expect(at.value).toBe('z');
    expect(at.sites).toHaveLength(1);
  });

  it('walks the one union option the rest of the path resolves under', () => {
    const at = argumentAt(root, ['either', 0, 1], { either: ['a,b'] });

    expect(at.value).toBe('b');
    expect(at.sites.map((site) => site.depth)).toEqual([2]);
  });

  it('leaves a path unknown when re-applying its transform throws', () => {
    expect(argumentAt(root, ['broken', 0, 'name'], { broken: { name: 'a' } })).toEqual({
      known: false,
      received: undefined,
      sent: undefined,
      sites: [],
      transformed: false,
      value: undefined,
    });
  });

  it('runs a transform once per value for every path a shared cache reads', () => {
    const transforms: TransformCache = new Map();
    const lone = { name: 'abc', year: 2020 };
    runs = 0;

    argumentAt(root, ['items', 0, 'name'], { items: lone }, transforms);
    argumentAt(root, ['items', 0, 'year'], { items: lone }, transforms);
    objectSchemaAt(root, ['items', 0], { items: lone }, transforms);

    expect(runs).toBe(1);
  });

  describe('through a union at every level of a recursive schema', () => {
    /** A filter tree whose every level is a discriminated union, as a recursive query input is. */
    const Filter: z.ZodType = z.lazy(() =>
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('leaf'), value: z.string() }),
        z.object({ type: z.literal('not'), filter: Filter }),
      ]),
    );
    const tree = z.object({ where: Filter });
    /** `depth` levels of `not` above a leaf, and the path to the leaf's value. */
    const nested = (depth: number) => {
      let where: Record<string, unknown> = { type: 'leaf', value: 5 };
      for (let level = 0; level < depth; level++) where = { type: 'not', filter: where };
      const path: PropertyKey[] = [
        'where',
        ...Array.from({ length: depth }, () => 'filter'),
        'value',
      ];
      return { args: { where }, path };
    };

    it('reads the leaf value, walking each level’s selected variant', () => {
      const { args, path } = nested(3);

      expect(argumentAt(tree, path, args)).toEqual({
        known: true,
        received: 5,
        sent: 5,
        sites: [],
        transformed: false,
        value: 5,
      });
    });

    it('walks in time linear in the depth', () => {
      const deepest = 2_000;
      /** Thread-CPU ms of walking `deepest` levels' worth of paths `depth` levels deep, best of 3. */
      const walkCost = (depth: number): number => {
        const { args, path } = nested(depth);
        const walks = deepest / depth;
        const walk = () => {
          for (let i = 0; i < walks; i++) argumentAt(tree, path, args);
        };
        walk();
        let best = Number.POSITIVE_INFINITY;
        for (let sample = 0; sample < 3; sample++) {
          const start = process.threadCpuUsage();
          walk();
          const { user, system } = process.threadCpuUsage(start);
          best = Math.min(best, (user + system) / 1000);
        }
        return Math.max(best, 0.001);
      };

      const shallow = walkCost(125);
      const deep = walkCost(deepest);

      // Each side walks 2,000 levels in all: linear is ~1×, a re-walk of the
      // rest of the path at every union ~16×.
      expect(deep / shallow).toBeLessThan(4);
      // Under a few ms on Bun and Node; re-walking at every union took ~0.5 s.
      expect(deep).toBeLessThan(100);
    });
  });

  describe('through a plain union whose options both hold the path, at every level', () => {
    /** No tag tells the two options apart, so a path down `all` can enter either at every level. */
    const Clause: z.ZodType = z.lazy(() =>
      z.union([
        z.object({ all: z.array(Clause).optional(), v: z.string().optional() }),
        z.object({ all: z.array(Clause), w: z.number() }),
      ]),
    );
    const tree = z.object({ where: Clause });
    /** `depth` levels of `all` above a leaf, and the path to the leaf's `v`. */
    const nested = (depth: number) => {
      let where: Record<string, unknown> = { v: 'ab' };
      for (let level = 0; level < depth; level++) where = { all: [where] };
      const path: PropertyKey[] = [
        'where',
        ...Array.from({ length: depth }, () => ['all', 0]).flat(),
        'v',
      ];
      return { args: { where }, path };
    };
    /** The fastest thread-CPU milliseconds of three runs of `run`. */
    const cost = (run: () => void): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < 3; sample++) {
        const start = process.threadCpuUsage();
        run();
        const { user, system } = process.threadCpuUsage(start);
        best = Math.min(best, (user + system) / 1000);
      }
      return Math.max(best, 0.001);
    };

    it('reads the leaf value off the arguments, no single option resolving the path', () => {
      const { args, path } = nested(24);

      expect(argumentAt(tree, path, args)).toEqual({
        known: true,
        received: 'ab',
        sent: 'ab',
        sites: [],
        transformed: false,
        value: 'ab',
      });
      expect(objectSchemaAt(tree, path.slice(0, -1), args)).toBeUndefined();
      expect(routesThroughPipeAt(tree, path, args)).toBe(false);
    });

    it.each([
      ['argumentAt', (args: unknown, path: PropertyKey[]) => argumentAt(tree, path, args)],
      [
        'objectSchemaAt',
        (args: unknown, path: PropertyKey[]) => objectSchemaAt(tree, path.slice(0, -1), args),
      ],
      [
        'routesThroughPipeAt',
        (args: unknown, path: PropertyKey[]) => routesThroughPipeAt(tree, path, args),
      ],
    ])('walks with %s in time linear in the depth', (_label, walk) => {
      for (const depth of [8, 12, 16, 20, 24]) {
        const { args, path } = nested(depth);
        // Checked per depth first, so a walk that doubles per level fails at 16 rather than running on.
        expect(
          cost(() => walk(args, path)),
          `depth ${depth}`,
        ).toBeLessThan(25);
      }

      const deepest = 400;
      /** Thread-CPU ms of walking `deepest` levels' worth of paths `depth` levels deep, best of 3. */
      const walkCost = (depth: number): number => {
        const { args, path } = nested(depth);
        const walks = deepest / depth;
        const walkAll = () => {
          for (let i = 0; i < walks; i++) walk(args, path);
        };
        walkAll();
        return cost(walkAll);
      };

      // Each side walks 400 levels in all: linear is ~1×, a re-walk of the
      // path from the root at every step ~15×.
      expect(walkCost(deepest) / walkCost(25)).toBeLessThan(4);
    });
  });
});

describe('routesThroughPipeAt', () => {
  const piped = z.string().transform(Number).pipe(z.number());
  const count = z.number().int().optional();
  /** `field` in every place a path can land on one schema. */
  const rootOf = (field: z.ZodType) => {
    const leaf = z.object({ note: field });
    return z.object({
      field,
      leaf,
      pipedLeaf: leaf.pipe(z.object({ note: z.unknown() })),
      rows: z.array(leaf),
      pair: z.tuple([z.string(), field]),
      byName: z.record(z.string(), field),
      byAnyKey: z.object({ text: z.string() }).catchall(field),
      shape: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('circle'), radius: field }),
        z.object({ kind: z.literal('square'), side: z.number() }),
      ]),
      oneOption: z.union([leaf, z.object({ other: z.string() })]),
    });
  };

  it.each([
    ['a field, wrappers included', ['field'], {}],
    ['a nested field', ['leaf', 'note'], {}],
    ['a field behind a pipe’s input object', ['pipedLeaf', 'note'], {}],
    ['an element’s field', ['rows', 1, 'note'], { rows: [{}, {}] }],
    ['a tuple item', ['pair', 1], { pair: ['a', 1] }],
    ['a record value', ['byName', 'anyKey'], { byName: { anyKey: 1 } }],
    ['an author catchall’s value', ['byAnyKey', 'anyKey'], { byAnyKey: { anyKey: 1 } }],
    ['the selected variant’s field', ['shape', 'radius'], { shape: { kind: 'circle' } }],
    ['the one option a path resolves through', ['oneOption', 'note'], {}],
  ])('reads the field at %s', (_label, path, value) => {
    expect(routesThroughPipeAt(rootOf(piped), path, value)).toBe(true);
    expect(routesThroughPipeAt(rootOf(count), path, value)).toBe(false);
  });

  it('reads a declared key, not the catchall, beside a catchall', () => {
    expect(routesThroughPipeAt(z.object({ text: piped }).catchall(count), ['text'], {})).toBe(true);
    expect(routesThroughPipeAt(z.object({ text: count }).catchall(piped), ['text'], {})).toBe(
      false,
    );
  });

  it.each([
    ['another option declares the key', z.union([z.object({ k: count }), z.object({ k: piped })])],
    [
      'another option catches the key',
      z.union([z.object({ k: count }), z.object({}).catchall(piped)]),
    ],
    [
      'the other side of an intersection declares it',
      z.intersection(z.object({ k: count }), z.object({ k: piped })),
    ],
  ])('asks every schema the path resolves under where %s', (_label, field) => {
    expect(routesThroughPipeAt(z.object({ field }), ['field', 'k'], { field: {} })).toBe(true);
  });

  it('leaves out an option whose literal tag refuses the value', () => {
    const tagged = z.object({
      field: z.union([
        z.object({ kind: z.literal('a'), k: count }),
        z.object({ kind: z.literal('b'), k: piped }),
      ]),
    });

    expect(routesThroughPipeAt(tagged, ['field', 'k'], { field: { kind: 'a' } })).toBe(false);
    expect(routesThroughPipeAt(tagged, ['field', 'k'], { field: { kind: 'b' } })).toBe(true);
  });

  it('reads every plain-union option when the tags refuse each object option', () => {
    const lookedUp = z.preprocess((value) => value, z.number());
    const tagged = z.object({
      target: z.union([
        z.object({ kind: z.literal(1), n: lookedUp }),
        z.object({ kind: z.literal(2), n: count }),
      ]),
    });

    expect(routesThroughPipeAt(tagged, ['target', 'n'], { target: { kind: 1 } })).toBe(true);
    expect(routesThroughPipeAt(tagged, ['target', 'n'], { target: { kind: 2 } })).toBe(false);
    // `"1"` is refused by both literal tags, yet the field may still be the piped one.
    expect(routesThroughPipeAt(tagged, ['target', 'n'], { target: { kind: '1' } })).toBe(true);
    // objectSchemaAt keeps following tags alone, so no branch is chosen for it.
    expect(objectSchemaAt(tagged, ['target'], { target: { kind: '1' } })).toBeUndefined();
  });

  it.each([
    ['an undeclared key', z.object({ field: piped }), ['missing'], {}],
    ['a .strict() object’s undeclared key', z.object({}).strict(), ['anyKey'], {}],
    ['a .passthrough() object’s undeclared key', z.object({}).passthrough(), ['anyKey'], {}],
    ['a step below a string field', z.object({ text: z.string() }), ['text', 0], { text: 'x' }],
    [
      'an unrecognized discriminator',
      rootOf(piped),
      ['shape', 'radius'],
      { shape: { kind: 'hexagon' } },
    ],
  ])('finds no transform at %s', (_label, schema, path, value) => {
    expect(routesThroughPipeAt(schema, path, value)).toBe(false);
  });

  it('walks through catchalls nested in catchalls', () => {
    const deep = (field: z.ZodType) =>
      z.object({}).catchall(z.object({}).catchall(z.object({}).catchall(field)));

    expect(routesThroughPipeAt(deep(piped), ['a', 'b', 'c'], {})).toBe(true);
    expect(routesThroughPipeAt(deep(count), ['a', 'b', 'c'], {})).toBe(false);
  });
});

describe('routesThroughPipe', () => {
  const lookup = (value: string | number) => (typeof value === 'string' ? undefined : value);
  const Looped: z.ZodType = z.lazy(() => z.union([z.number(), Looped]));

  it.each([
    ['a transform', z.string().transform(Number)],
    ['a pipe', z.number().pipe(z.number().int())],
    ['a preprocess', z.preprocess((value) => value, z.number())],
    [
      'a wrapped transform-then-pipe',
      z.union([z.string(), z.number()]).transform(lookup).pipe(z.number()).optional(),
    ],
    ['a union with a piped option', z.union([z.number(), z.string().transform(Number)])],
    ['a lazy transform', z.lazy(() => z.string().transform(Number))],
  ])('is true for %s', (_label, schema) => {
    expect(routesThroughPipe(schema)).toBe(true);
  });

  it.each([
    ['a number', z.number()],
    ['a wrapped number', z.number().optional().default(1).nullable()],
    ['a coerced number', z.coerce.number()],
    ['a union of plain options', z.union([z.number(), z.boolean()])],
    ['a list whose elements transform', z.array(z.string().transform(Number))],
    ['a union that recurses through itself', Looped],
    ['no schema at all', undefined],
  ])('is false for %s', (_label, schema) => {
    expect(routesThroughPipe(schema)).toBe(false);
  });
});
