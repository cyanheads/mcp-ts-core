/**
 * @fileoverview Tree formatter utility for visualizing hierarchical data structures.
 * Supports ASCII, Unicode box-drawing, and compact tree styles with icons and metadata.
 * @module src/utils/formatting/treeFormatter
 */

import { JsonRpcErrorCode, McpError, validationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';

/**
 * Tree output style options.
 *
 * - `unicode`: Box-drawing characters (`├──`, `└──`, `│`) — best for terminal output.
 * - `ascii`:   ASCII characters (`+--`, `\--`, `|`) — safe for environments without Unicode support.
 * - `compact`: Simple indented list with no connectors — minimal decoration.
 *
 * @example
 * ```
 * // unicode
 * root
 * ├── child1
 * └── child2
 *
 * // ascii
 * root
 * +-- child1
 * \-- child2
 *
 * // compact
 * root
 *   child1
 *   child2
 * ```
 */
export type TreeStyle = 'ascii' | 'unicode' | 'compact';

/**
 * Node in a hierarchical tree structure.
 *
 * Nodes are recursive: any node can have `children`, forming an arbitrarily deep tree.
 * Circular references (a node appearing in its own descendant chain) are detected at
 * render time and replaced with a `[Circular Reference]` marker.
 */
export interface TreeNode {
  /**
   * Child nodes nested under this node.
   * A node with children is treated as a "folder" node; one without is a "leaf" node.
   * This distinction affects icon selection when `icons` is enabled.
   */
  children?: TreeNode[];

  /**
   * Arbitrary key-value metadata to display alongside the node name.
   * When `showMetadata` is enabled, entries are rendered as `key=value` pairs in
   * parentheses after the node name — e.g. `file.txt (size=1KB, type=text)`.
   */
  metadata?: Record<string, unknown>;

  /**
   * Display name for this node. Must be a non-empty string.
   */
  name: string;
}

/**
 * Configuration options for tree formatting.
 */
export interface TreeFormatterOptions {
  /**
   * Icon to use for leaf nodes (nodes without children) when `icons` is enabled.
   * Default: `'📄'`
   */
  fileIcon?: string;

  /**
   * Icon to use for branch nodes (nodes with children) when `icons` is enabled.
   * Default: `'📁'`
   */
  folderIcon?: string;

  /**
   * Whether to prefix each node name with an icon.
   * Leaf nodes use `fileIcon`; branch nodes use `folderIcon`.
   * Default: `false`
   */
  icons?: boolean;

  /**
   * String used to indent each level of the tree.
   * Combined with vertical connector characters for `unicode` and `ascii` styles
   * to keep the tree visually aligned. Must be at least one character wide.
   * Default: `'  '` (two spaces)
   */
  indent?: string;

  /**
   * Maximum depth to render (0-based). Nodes at depth greater than this value are
   * omitted entirely. `undefined` means no limit.
   * Default: `undefined`
   */
  maxDepth?: number;

  /**
   * Whether to append node metadata after each node name.
   * Metadata entries are rendered as `key=value` pairs enclosed in parentheses.
   * Default: `false`
   */
  showMetadata?: boolean;

  /**
   * Visual style used to draw branch connectors. See {@link TreeStyle} for details.
   * Default: `'unicode'`
   */
  style?: TreeStyle;
}

/**
 * Resolved tree formatter options with all defaults applied.
 * maxDepth remains optional since `undefined` means no limit.
 */
type ResolvedTreeOptions = Required<Omit<TreeFormatterOptions, 'maxDepth'>> & {
  maxDepth: number | undefined;
};

/**
 * Utility class for formatting hierarchical data as tree structures.
 *
 * Renders a {@link TreeNode} graph as a multi-line string using ASCII, Unicode
 * box-drawing, or compact indented styles. Handles arbitrary depth, optional icons,
 * inline metadata, and detects circular references at render time.
 *
 * Use the exported {@link treeFormatter} singleton rather than constructing directly.
 *
 * @example
 * ```typescript
 * import { treeFormatter } from '@/utils/formatting/treeFormatter.js';
 *
 * const tree: TreeNode = {
 *   name: 'src',
 *   children: [
 *     { name: 'index.ts' },
 *     { name: 'utils', children: [{ name: 'helper.ts' }] },
 *   ],
 * };
 *
 * console.log(treeFormatter.format(tree, { style: 'unicode' }));
 * // src
 * // ├── index.ts
 * // └── utils
 * //     └── helper.ts
 * ```
 */
export class TreeFormatter {
  /**
   * Default formatting options.
   * @private
   */
  private readonly defaultOptions: ResolvedTreeOptions = {
    style: 'unicode',
    maxDepth: undefined,
    showMetadata: false,
    icons: false,
    indent: '  ',
    folderIcon: '📁',
    fileIcon: '📄',
  };

  /**
   * Track seen nodes for circular reference detection.
   * @private
   */
  private seenNodes = new Set<TreeNode>();

  /**
   * Format a single tree into a multi-line string.
   *
   * Merges `options` with defaults, resets circular-reference tracking, then
   * recursively renders each node with branch connectors, optional icons, and
   * optional metadata. Lines are joined with `\n`.
   *
   * @param root - Root node of the tree. Must have a non-empty `name` string.
   * @param options - Formatting options. Merged with defaults; all fields are optional.
   * @param context - Optional request context for correlated log output. A new context
   *   is created automatically when omitted.
   * @returns Multi-line tree string. The root node appears on the first line with no
   *   connector prefix; child nodes are indented and prefixed with branch connectors.
   * @throws {McpError} With code `ValidationError` if `root` is missing or has no `name`.
   * @throws {McpError} With code `InternalError` if rendering fails unexpectedly.
   *
   * @example
   * ```typescript
   * const tree = {
   *   name: 'src',
   *   children: [
   *     { name: 'index.ts' },
   *     {
   *       name: 'utils',
   *       children: [
   *         { name: 'helper.ts' },
   *         { name: 'types.ts' },
   *       ],
   *     },
   *   ],
   * };
   *
   * console.log(treeFormatter.format(tree, { style: 'unicode', icons: true }));
   * // 📁 src
   * // ├── 📄 index.ts
   * // └── 📁 utils
   * //     ├── 📄 helper.ts
   * //     └── 📄 types.ts
   * ```
   */
  format(root: TreeNode, options?: TreeFormatterOptions, context?: RequestContext): string {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'TreeFormatter.format',
      });

    // Validate input
    if (!root || typeof root.name !== 'string') {
      throw validationError('Root node must have a name property', logContext);
    }

    const opts = {
      ...this.defaultOptions,
      ...options,
    };

    try {
      // Reset circular reference detection
      this.seenNodes.clear();

      logger.debug(
        'Formatting tree structure',
        withExtra(logContext, { rootName: root.name, style: opts.style }),
      );

      const lines: string[] = [];
      this.renderNode(root, '', true, true, lines, opts, 0);

      const result = lines.join('\n');

      logger.debug(
        'Tree formatted successfully',
        withExtra(logContext, { lineCount: lines.length }),
      );

      return result;
    } catch (error: unknown) {
      if (error instanceof McpError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to format tree', withExtra(logContext, { error: message }));

      throw new McpError(JsonRpcErrorCode.InternalError, `Failed to format tree: ${message}`, {
        ...logContext,
        originalError: stack,
      });
    }
  }

  /**
   * Format multiple independent trees (forest) into a single string.
   *
   * Calls {@link format} on each root in order and joins the results with a blank
   * line (`\n\n`) between them. Useful for rendering several top-level structures
   * side-by-side in one output block (e.g. `src/`, `tests/`, `docs/`).
   *
   * @param roots - Non-empty array of root nodes. Each must satisfy the same
   *   constraints as the `root` parameter of {@link format}.
   * @param options - Formatting options applied uniformly to every tree.
   * @param context - Optional request context for correlated log output. A new context
   *   is created automatically when omitted.
   * @returns Each formatted tree separated by a blank line.
   * @throws {McpError} With code `ValidationError` if `roots` is empty or not an array.
   * @throws {McpError} With code `ValidationError` / `InternalError` propagated from
   *   {@link format} if any individual tree fails to render.
   *
   * @example
   * ```typescript
   * const roots = [
   *   { name: 'src', children: [{ name: 'index.ts' }] },
   *   { name: 'tests', children: [{ name: 'index.test.ts' }] },
   * ];
   *
   * console.log(treeFormatter.formatMultiple(roots, { style: 'unicode' }));
   * // src
   * // └── index.ts
   * //
   * // tests
   * // └── index.test.ts
   * ```
   */
  formatMultiple(
    roots: TreeNode[],
    options?: TreeFormatterOptions,
    context?: RequestContext,
  ): string {
    const logContext =
      context ||
      requestContextService.createRequestContext({
        operation: 'TreeFormatter.formatMultiple',
      });

    if (!Array.isArray(roots) || roots.length === 0) {
      throw validationError('Roots must be a non-empty array', logContext);
    }

    try {
      logger.debug(
        'Formatting multiple tree structures',
        withExtra(logContext, { count: roots.length }),
      );

      const results = roots.map((root) => this.format(root, options, logContext));

      return results.join('\n\n');
    } catch (error: unknown) {
      if (error instanceof McpError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        `Failed to format multiple trees: ${message}`,
        { ...logContext, originalError: stack },
      );
    }
  }

  /**
   * Recursively render a tree node and its children into `lines`.
   *
   * Uses a post-order removal strategy for circular-reference detection: the node is
   * added to `seenNodes` before descending into children and removed afterward, so
   * the same node can appear in multiple independent branches without false positives —
   * only true ancestor-descendant cycles are flagged.
   *
   * @param node - Current node to render.
   * @param prefix - String prepended to every line produced by this call and its
   *   descendants (carries the vertical-connector continuation from parent levels).
   * @param isRoot - Whether this is the top-level node (suppresses the leading connector).
   * @param isLast - Whether this node is the last sibling (determines corner vs. tee connector).
   * @param lines - Accumulator array; rendered lines are pushed here in order.
   * @param options - Resolved formatting options.
   * @param depth - Current render depth (0 = root). Used to enforce `maxDepth`.
   * @private
   */
  private renderNode(
    node: TreeNode,
    prefix: string,
    isRoot: boolean,
    isLast: boolean,
    lines: string[],
    options: Required<Omit<TreeFormatterOptions, 'maxDepth'>> & {
      maxDepth: number | undefined;
    },
    depth: number,
  ): void {
    // Check max depth
    if (options.maxDepth !== undefined && depth > options.maxDepth) {
      return;
    }

    // Check for circular references
    if (this.seenNodes.has(node)) {
      lines.push(
        `${prefix}${this.getConnector('circular', isLast, options.style)} [Circular Reference]`,
      );
      return;
    }

    this.seenNodes.add(node);

    // Build node line
    const connector = isRoot ? '' : this.getConnector('node', isLast, options.style);

    const icon = this.getIcon(node, options);
    const name = node.name;
    const metadata = this.formatMetadata(node, options);

    const line = `${prefix}${connector}${icon}${name}${metadata}`;
    lines.push(line);

    // Render children
    const children = node.children || [];
    if (children.length > 0) {
      const childPrefix = isRoot
        ? ''
        : prefix + this.getChildPrefix(isLast, options.style, options.indent);

      children.forEach((child, index) => {
        const isLastChild = index === children.length - 1;
        this.renderNode(child, childPrefix, false, isLastChild, lines, options, depth + 1);
      });
    }

    this.seenNodes.delete(node);
  }

  /**
   * Return the branch-connector string that precedes a node's name.
   *
   * For `type === 'circular'`, always uses a minimal connector regardless of style
   * (compact: two spaces; others: corner or tee). For normal nodes, the connector
   * depends on `style` and whether this is the last sibling.
   *
   * @param type - `'node'` for a normal node; `'circular'` for a cycle marker.
   * @param isLast - Whether this node is the last among its siblings.
   * @param style - Active tree style.
   * @returns Connector string (e.g. `'└── '`, `'+-- '`, or `''`).
   * @private
   */
  private getConnector(type: 'node' | 'circular', isLast: boolean, style: TreeStyle): string {
    if (type === 'circular') {
      return style === 'compact' ? '  ' : isLast ? '└─ ' : '├─ ';
    }

    switch (style) {
      case 'unicode':
        return isLast ? '└── ' : '├── ';
      case 'ascii':
        return isLast ? '\\-- ' : '+-- ';
      case 'compact':
        return '';
      default:
        return '';
    }
  }

  /**
   * Return the prefix string to prepend to all lines produced by child nodes.
   *
   * When the parent is not the last sibling, a vertical connector (`│` for unicode,
   * `|` for ascii) is prepended and padded to match `indent`'s width, keeping the
   * tree visually connected. When the parent is last, a blank indent is used instead.
   *
   * @param isLast - Whether the parent node is the last among its siblings.
   * @param style - Active tree style.
   * @param indent - Configured indentation string (its length determines padding width).
   * @returns Prefix string to pass as `prefix` when recursing into children.
   * @private
   */
  private getChildPrefix(isLast: boolean, style: TreeStyle, indent: string): string {
    // When not the last child, replace the first character of indent with a vertical
    // connector so the tree lines stay visually connected. Pad to match indent width.
    const padding = indent.length > 1 ? ' '.repeat(indent.length - 1) : '';
    switch (style) {
      case 'unicode':
        return isLast ? indent : `│${padding}`;
      case 'ascii':
        return isLast ? indent : `|${padding}`;
      case 'compact':
        return indent;
      default:
        return indent;
    }
  }

  /**
   * Return the icon prefix string for a node, or an empty string when icons are disabled.
   *
   * A node is treated as a "folder" (uses `folderIcon`) if it has at least one child;
   * otherwise it uses `fileIcon`. The returned string includes a trailing space so
   * the icon is separated from the node name.
   *
   * @param node - Node to select an icon for.
   * @param options - Resolved formatting options.
   * @returns Icon string with trailing space (e.g. `'📁 '`), or `''` if `icons` is false.
   * @private
   */
  private getIcon(
    node: TreeNode,
    options: Required<Omit<TreeFormatterOptions, 'maxDepth'>> & {
      maxDepth: number | undefined;
    },
  ): string {
    if (!options.icons) {
      return '';
    }

    const hasChildren = node.children && node.children.length > 0;
    const icon = hasChildren ? options.folderIcon : options.fileIcon;

    return `${icon} `;
  }

  /**
   * Return the metadata suffix string for a node, or an empty string when metadata display
   * is disabled or the node has no metadata.
   *
   * Entries are formatted as `key=value` pairs joined by `', '` and wrapped in
   * parentheses: ` (size=1KB, type=text)`. All values are coerced to strings via
   * `String()`. Returns `''` if the resulting entry list is empty.
   *
   * @param node - Node whose `metadata` record to format.
   * @param options - Resolved formatting options (`showMetadata` must be `true` to emit output).
   * @returns Metadata suffix string (e.g. `' (size=1KB)'`) or `''`.
   * @private
   */
  private formatMetadata(
    node: TreeNode,
    options: Required<Omit<TreeFormatterOptions, 'maxDepth'>> & {
      maxDepth: number | undefined;
    },
  ): string {
    if (!options.showMetadata || !node.metadata) {
      return '';
    }

    const entries = Object.entries(node.metadata)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');

    return entries ? ` (${entries})` : '';
  }
}

/**
 * Singleton instance of TreeFormatter.
 * Use this instance to format hierarchical data as tree structures.
 *
 * @example
 * ```typescript
 * import { treeFormatter } from '@/utils/formatting/treeFormatter.js';
 *
 * // Simple directory tree
 * const tree = {
 *   name: 'project',
 *   children: [
 *     {
 *       name: 'src',
 *       children: [
 *         { name: 'index.ts' },
 *         { name: 'types.ts' }
 *       ]
 *     },
 *     { name: 'package.json' },
 *     { name: 'README.md' }
 *   ]
 * };
 *
 * // Unicode tree with icons
 * console.log(treeFormatter.format(tree, {
 *   style: 'unicode',
 *   icons: true
 * }));
 * // 📁 project
 * // ├── 📁 src
 * // │   ├── 📄 index.ts
 * // │   └── 📄 types.ts
 * // ├── 📄 package.json
 * // └── 📄 README.md
 *
 * // With metadata
 * const treeWithMeta = {
 *   name: 'files',
 *   metadata: { count: 3 },
 *   children: [
 *     { name: 'file1.txt', metadata: { size: '1KB' } },
 *     { name: 'file2.txt', metadata: { size: '2KB' } }
 *   ]
 * };
 *
 * console.log(treeFormatter.format(treeWithMeta, { showMetadata: true }));
 * // files (count=3)
 * // ├── file1.txt (size=1KB)
 * // └── file2.txt (size=2KB)
 * ```
 */
export const treeFormatter = new TreeFormatter();
