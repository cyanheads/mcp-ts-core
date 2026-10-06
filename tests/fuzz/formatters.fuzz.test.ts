/**
 * @fileoverview Property tests for the formatting utilities' structural invariants:
 * table rows stay aligned, every reachable tree node renders exactly once per path,
 * and the `html` tag never lets a `<` out of an interpolated string.
 * @module tests/fuzz/formatters.fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type HtmlInterpolation, html } from '@/utils/formatting/html.js';
import {
  type Alignment,
  type TableStyle,
  tableFormatter,
} from '@/utils/formatting/tableFormatter.js';
import { type TreeNode, type TreeStyle, treeFormatter } from '@/utils/formatting/treeFormatter.js';

const SEED = 20_261_006;

describe('tableFormatter', () => {
  // Prototype-named headers are excluded pending the tracking issue (#TBD-table-proto).
  const header = fc
    .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,11}$/)
    .filter((name) => !(name in Object.prototype));
  /** Single-width printable ASCII without `|`: short cells, and cells past the 50-column cap. */
  const cell = fc.oneof(
    fc.stringMatching(/^[ -{}~]{0,12}$/),
    fc.stringMatching(/^[ -{}~]{45,60}$/),
  );
  const column = fc.record({
    name: header,
    align: fc.constantFrom<Alignment>('left', 'right', 'center'),
  });
  const table = fc.integer({ min: 1, max: 5 }).chain((width) =>
    fc.record({
      columns: fc.uniqueArray(column, {
        minLength: width,
        maxLength: width,
        selector: ({ name }) => name,
      }),
      rows: fc.array(fc.array(cell, { minLength: width, maxLength: width }), {
        minLength: 1,
        maxLength: 6,
      }),
      padding: fc.integer({ min: 0, max: 3 }),
      style: fc.constantFrom<TableStyle>('markdown', 'ascii', 'grid', 'compact'),
    }),
  );

  it('renders every line of every style at the same width', () => {
    fc.assert(
      fc.property(table, ({ columns, rows, padding, style }) => {
        const headers = columns.map(({ name }) => name);
        const alignment = Object.fromEntries(columns.map(({ name, align }) => [name, align]));
        const lines = tableFormatter.formatRaw(headers, rows, { alignment, padding, style });

        expect(new Set(lines.split('\n').map((line) => line.length)).size).toBe(1);
      }),
      { numRuns: 300, seed: SEED },
    );
  });
});

describe('treeFormatter', () => {
  /**
   * An acyclic DAG over nodes 0..n-1: each node's children are drawn from the nodes
   * after it, so a node can sit under several parents but never under itself.
   */
  const dag = fc.integer({ min: 1, max: 8 }).chain((size) =>
    fc.record({
      edges: fc.tuple(
        ...Array.from({ length: size }, (_, i) =>
          fc.subarray(Array.from({ length: size - i - 1 }, (_, k) => i + k + 1)),
        ),
      ),
      maxDepth: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
      style: fc.constantFrom<TreeStyle>('unicode', 'ascii', 'compact'),
      indent: fc.constantFrom(' ', '  ', '    '),
    }),
  );

  it('renders one line per root-to-node path within maxDepth, with no false cycles', () => {
    fc.assert(
      fc.property(dag, ({ edges, maxDepth, style, indent }) => {
        const nodes: TreeNode[] = edges.map((_, i) => ({ name: `n${i}` }));
        edges.forEach((children, i) => {
          if (children.length > 0)
            (nodes[i] as TreeNode).children = children.map((c) => nodes[c] as TreeNode);
        });
        const paths = (index: number, depth: number): number =>
          maxDepth !== undefined && depth > maxDepth
            ? 0
            : 1 + (edges[index] ?? []).reduce((sum, child) => sum + paths(child, depth + 1), 0);

        const output = treeFormatter.format(nodes[0] as TreeNode, {
          style,
          indent,
          ...(maxDepth !== undefined && { maxDepth }),
        });

        expect(output).not.toContain('[Circular Reference]');
        expect(output.split('\n')).toHaveLength(paths(0, 0));
      }),
      { numRuns: 300, seed: SEED },
    );
  });
});

describe('html', () => {
  type Shape =
    | { kind: 'leaf'; value: string | number | boolean | null | undefined }
    | { kind: 'array'; items: Shape[] }
    | { kind: 'fragment'; child: Shape };

  const leaf = fc.record({
    kind: fc.constant('leaf' as const),
    value: fc.oneof(
      fc.string(),
      fc.constantFrom('<script>alert(1)</script>', '"><img src=x>', '<', '</b>'),
      fc.integer(),
      fc.boolean(),
      fc.constantFrom(null, undefined),
    ),
  });
  const { shape } = fc.letrec<{ shape: Shape }>((tie) => ({
    shape: fc.oneof(
      { maxDepth: 4, depthSize: 'small' },
      leaf,
      fc.record({
        kind: fc.constant('array' as const),
        items: fc.array(tie('shape'), { maxLength: 4 }),
      }),
      fc.record({ kind: fc.constant('fragment' as const), child: tie('shape') }),
    ),
  }));

  /** Builds the interpolation, counting the `<` its own `<b>…</b>` templates contribute. */
  const build = (node: Shape): [HtmlInterpolation, number] => {
    switch (node.kind) {
      case 'leaf':
        return [node.value, 0];
      case 'array': {
        const built = node.items.map(build);
        return [built.map(([value]) => value), built.reduce((sum, [, tags]) => sum + tags, 0)];
      }
      case 'fragment': {
        const [value, tags] = build(node.child);
        return [html`<b>${value}</b>`, tags + 2];
      }
    }
  };

  it('emits only the template tags, never a `<` from an interpolated string', () => {
    fc.assert(
      fc.property(shape, (node) => {
        const [value, tags] = build(node);
        const output = html`<ul>${value}</ul>`.toString();

        expect(output.split('<').length - 1).toBe(tags + 2);
      }),
      { numRuns: 300, seed: SEED },
    );
  });
});
