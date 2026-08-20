/**
 * @fileoverview Tests for TreeFormatter utility
 * @module tests/utils/formatting/treeFormatter.test
 */
import { describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { TreeFormatter, type TreeNode, treeFormatter } from '@/utils/formatting/treeFormatter.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

describe('TreeFormatter', () => {
  const simpleTree: TreeNode = {
    name: 'root',
    children: [
      { name: 'child1' },
      { name: 'child2' },
      {
        name: 'parent',
        children: [{ name: 'grandchild1' }, { name: 'grandchild2' }],
      },
    ],
  };

  describe('Singleton instance', () => {
    it('should export a singleton instance', () => {
      expect(treeFormatter).toBeInstanceOf(TreeFormatter);
      expect(treeFormatter.format).toBeInstanceOf(Function);
      expect(treeFormatter.formatMultiple).toBeInstanceOf(Function);
    });
  });

  describe('format() method', () => {
    it('should format a simple tree with unicode style (default)', () => {
      const result = treeFormatter.format(simpleTree);

      expect(result).toContain('root');
      expect(result).toContain('child1');
      expect(result).toContain('child2');
      expect(result).toContain('parent');
      expect(result).toContain('grandchild1');
      expect(result).toContain('grandchild2');
      expect(result).toContain('├──'); // Unicode tree chars
      expect(result).toContain('└──');
    });

    it('should format tree with ascii style', () => {
      const result = treeFormatter.format(simpleTree, { style: 'ascii' });

      expect(result).toContain('root');
      expect(result).toContain('+--'); // ASCII tree chars for non-last children
      expect(result).toContain('\\--'); // ASCII tree chars for last child
      expect(result).not.toContain('├'); // No unicode
    });

    it('should format tree with compact style', () => {
      const result = treeFormatter.format(simpleTree, { style: 'compact' });

      expect(result).toContain('root');
      expect(result).toContain('child1');
      expect(result).not.toContain('├'); // No connectors
      expect(result).not.toContain('+'); // No connectors
    });

    it('should handle single node (no children)', () => {
      const singleNode: TreeNode = { name: 'alone' };
      const result = treeFormatter.format(singleNode);

      expect(result).toBe('alone');
    });

    it('should handle tree with icons enabled', () => {
      const result = treeFormatter.format(simpleTree, { icons: true });

      expect(result).toContain('📁'); // Folder icon for nodes with children
      expect(result).toContain('📄'); // File icon for leaf nodes
    });

    it('should handle tree with custom icons', () => {
      const result = treeFormatter.format(simpleTree, {
        icons: true,
        folderIcon: '🗂️',
        fileIcon: '📝',
      });

      expect(result).toContain('🗂️');
      expect(result).toContain('📝');
      expect(result).not.toContain('📁');
      expect(result).not.toContain('📄');
    });

    it('should display metadata when showMetadata is true', () => {
      const treeWithMeta: TreeNode = {
        name: 'root',
        metadata: { size: '1MB', count: 5 },
        children: [{ name: 'file', metadata: { size: '500KB' } }],
      };

      const result = treeFormatter.format(treeWithMeta, {
        showMetadata: true,
      });

      expect(result).toContain('size=1MB');
      expect(result).toContain('count=5');
      expect(result).toContain('size=500KB');
    });

    it('should respect maxDepth option', () => {
      const deepTree: TreeNode = {
        name: 'level0',
        children: [
          {
            name: 'level1',
            children: [
              {
                name: 'level2',
                children: [{ name: 'level3' }],
              },
            ],
          },
        ],
      };

      const result = treeFormatter.format(deepTree, { maxDepth: 1 });

      expect(result).toContain('level0');
      expect(result).toContain('level1');
      expect(result).not.toContain('level2'); // Exceeds maxDepth
      expect(result).not.toContain('level3'); // Exceeds maxDepth
    });

    it('should show only root with maxDepth: 0', () => {
      const tree: TreeNode = {
        name: 'root',
        children: [{ name: 'child1' }, { name: 'child2' }],
      };

      const result = treeFormatter.format(tree, { maxDepth: 0 });

      expect(result).toBe('root');
      expect(result).not.toContain('child1');
      expect(result).not.toContain('child2');
    });

    it('should respect custom indent option', () => {
      const result = treeFormatter.format(simpleTree, {
        indent: '    ', // 4 spaces
        style: 'compact',
      });

      expect(result).toBeTruthy();
      // With more indentation, output should be wider
      const lines = result.split('\n');
      expect(lines.some((line) => line.startsWith('    '))).toBe(true);
    });

    it('should handle single-character indent', () => {
      const tree: TreeNode = {
        name: 'root',
        children: [{ name: 'a', children: [{ name: 'b' }] }, { name: 'c' }],
      };

      const result = treeFormatter.format(tree, { indent: ' ', style: 'unicode' });
      expect(result).toContain('root');
      expect(result).toContain('a');
      expect(result).toContain('b');
      expect(result).toContain('c');
    });
  });

  describe('formatMultiple() method', () => {
    it('should format multiple root nodes', () => {
      const roots: TreeNode[] = [
        { name: 'tree1', children: [{ name: 'child1' }] },
        { name: 'tree2', children: [{ name: 'child2' }] },
        { name: 'tree3' },
      ];

      const result = treeFormatter.formatMultiple(roots);

      expect(result).toContain('tree1');
      expect(result).toContain('tree2');
      expect(result).toContain('tree3');
      expect(result).toContain('child1');
      expect(result).toContain('child2');

      // Should have blank lines between trees
      expect(result.split('\n\n').length).toBeGreaterThanOrEqual(2);
    });

    it('should apply options to all trees', () => {
      const roots: TreeNode[] = [
        { name: 'tree1' },
        { name: 'tree2', children: [{ name: 'child' }] },
      ];

      const result = treeFormatter.formatMultiple(roots, { icons: true });

      expect(result).toContain('📄'); // Icons should appear
    });
  });

  describe('Circular reference detection', () => {
    it('should detect and handle circular references', () => {
      const parent: TreeNode = { name: 'parent', children: [] };
      const child: TreeNode = { name: 'child', children: [parent] };
      parent.children = [child];

      const result = treeFormatter.format(parent);

      expect(result).toContain('[Circular Reference]');
      expect(result).toContain('parent');
      expect(result).toContain('child');
    });

    it('should handle self-referencing nodes', () => {
      const self: TreeNode = { name: 'self', children: [] };
      self.children = [self];

      const result = treeFormatter.format(self);

      expect(result).toContain('[Circular Reference]');
    });

    it('should detect circular references with ascii style', () => {
      const parent: TreeNode = { name: 'parent', children: [] };
      const child: TreeNode = { name: 'child', children: [parent] };
      parent.children = [child];

      const result = treeFormatter.format(parent, { style: 'ascii' });

      expect(result).toContain('[Circular Reference]');
      expect(result).toContain('parent');
      expect(result).toContain('child');
    });

    it('should detect circular references with compact style', () => {
      const parent: TreeNode = { name: 'parent', children: [] };
      const child: TreeNode = { name: 'child', children: [parent] };
      parent.children = [child];

      const result = treeFormatter.format(parent, { style: 'compact' });

      expect(result).toContain('[Circular Reference]');
      expect(result).toContain('parent');
      expect(result).toContain('child');
    });

    it('uses a tee connector when a circular reference is not the last child', () => {
      const root: TreeNode = { name: 'root', children: [] };
      root.children = [root, { name: 'after-cycle' }];

      const result = treeFormatter.format(root, { style: 'unicode' });

      expect(result).toContain('├─  [Circular Reference]');
      expect(result).toContain('after-cycle');
    });
  });

  describe('Error handling', () => {
    it('should throw McpError for invalid root node', () => {
      expect(() => {
        // @ts-expect-error Testing invalid input
        treeFormatter.format(null);
      }).toThrow(McpError);

      try {
        // @ts-expect-error Testing invalid input
        treeFormatter.format(null);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('name');
      }
    });

    it('should throw McpError for node without name', () => {
      expect(() => {
        // @ts-expect-error Testing invalid input
        treeFormatter.format({});
      }).toThrow(McpError);
    });

    it('should throw McpError for empty roots array in formatMultiple', () => {
      expect(() => {
        treeFormatter.formatMultiple([]);
      }).toThrow(McpError);

      try {
        treeFormatter.formatMultiple([]);
      } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(mcpError.message).toContain('non-empty array');
      }
    });

    it('should throw McpError for non-array roots in formatMultiple', () => {
      expect(() => {
        // @ts-expect-error Testing invalid input
        treeFormatter.formatMultiple('not an array');
      }).toThrow(McpError);
    });

    it.each([
      [new Error('children unavailable'), 'children unavailable'],
      ['children rejected', 'children rejected'],
    ])('normalizes a tree-rendering failure %#', (failure, message) => {
      const root = { name: 'root' } as TreeNode;
      Object.defineProperty(root, 'children', {
        get() {
          throw failure;
        },
      });

      expect(() => treeFormatter.format(root)).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InternalError,
          message: `Failed to format tree: ${message}`,
        }),
      );
    });

    it('passes through framework errors raised during rendering', () => {
      const failure = new McpError(JsonRpcErrorCode.ValidationError, 'invalid children');
      const root = { name: 'root' } as TreeNode;
      Object.defineProperty(root, 'children', {
        get() {
          throw failure;
        },
      });

      expect(() => treeFormatter.format(root)).toThrow(failure);
    });

    it.each([
      [new Error('forest unavailable'), 'forest unavailable'],
      ['forest rejected', 'forest rejected'],
    ])('normalizes a non-framework forest failure %#', (failure, message) => {
      const formatter = new TreeFormatter();
      vi.spyOn(formatter, 'format').mockImplementation(() => {
        throw failure;
      });

      expect(() => formatter.formatMultiple([{ name: 'root' }])).toThrow(
        expect.objectContaining({
          code: JsonRpcErrorCode.InternalError,
          message: `Failed to format multiple trees: ${message}`,
        }),
      );
    });

    it('passes through framework errors raised while formatting a forest', () => {
      const formatter = new TreeFormatter();
      const failure = new McpError(JsonRpcErrorCode.ValidationError, 'invalid tree');
      vi.spyOn(formatter, 'format').mockImplementation(() => {
        throw failure;
      });

      expect(() => formatter.formatMultiple([{ name: 'root' }])).toThrow(failure);
    });
  });

  describe('Context logging', () => {
    it('should log successful tree formatting with context', () => {
      const debugSpy = vi.spyOn(logger, 'debug');
      const context = requestContextService.createRequestContext({
        operation: 'test-tree',
      });

      treeFormatter.format({ name: 'root' }, {}, context);

      expect(debugSpy).toHaveBeenCalledWith(
        'Tree formatted successfully',
        expect.objectContaining({
          operation: 'test-tree',
        }),
      );

      debugSpy.mockRestore();
    });

    it('should create auto-generated context when none provided', () => {
      const debugSpy = vi.spyOn(logger, 'debug');

      treeFormatter.format({ name: 'root' });

      expect(debugSpy).toHaveBeenCalledWith(
        'Tree formatted successfully',
        expect.objectContaining({
          operation: 'TreeFormatter.format',
        }),
      );

      debugSpy.mockRestore();
    });

    it('should log multiple tree formatting', () => {
      const debugSpy = vi.spyOn(logger, 'debug');

      treeFormatter.formatMultiple([{ name: 'tree1' }, { name: 'tree2' }]);

      expect(debugSpy).toHaveBeenCalledWith(
        'Formatting multiple tree structures',
        expect.objectContaining({
          extra: expect.objectContaining({ count: 2 }),
        }),
      );

      debugSpy.mockRestore();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty children array', () => {
      const tree: TreeNode = { name: 'root', children: [] };
      const result = treeFormatter.format(tree);

      expect(result).toBe('root');
    });

    it('should handle very deep trees', () => {
      // Create a tree with depth of 10
      let current: TreeNode = { name: 'level10' };
      for (let i = 9; i >= 0; i--) {
        current = { name: `level${i}`, children: [current] };
      }

      const result = treeFormatter.format(current);
      expect(result).toContain('level0');
      expect(result).toContain('level10');
    });

    it('should handle nodes with special characters in names', () => {
      const tree: TreeNode = {
        name: 'root/path',
        children: [{ name: 'file name.txt' }, { name: 'special@#$%' }, { name: 'unicode: 你好' }],
      };

      const result = treeFormatter.format(tree);
      expect(result).toContain('root/path');
      expect(result).toContain('file name.txt');
      expect(result).toContain('special@#$%');
      expect(result).toContain('unicode: 你好');
    });

    it('should handle metadata with various types', () => {
      const tree: TreeNode = {
        name: 'root',
        metadata: {
          string: 'value',
          number: 42,
          boolean: true,
          null: null,
        },
      };

      const result = treeFormatter.format(tree, { showMetadata: true });
      expect(result).toContain('string=value');
      expect(result).toContain('number=42');
      expect(result).toContain('boolean=true');
      expect(result).toContain('null=null');
    });

    it('should handle showMetadata when node has no metadata property', () => {
      const tree: TreeNode = {
        name: 'root',
        children: [{ name: 'child' }],
      };

      const result = treeFormatter.format(tree, { showMetadata: true });
      expect(result).toContain('root');
      expect(result).toContain('child');
      // No metadata brackets should appear
      expect(result).not.toContain('(');
    });

    it('should handle showMetadata with empty metadata object', () => {
      const tree: TreeNode = {
        name: 'root',
        metadata: {},
      };

      const result = treeFormatter.format(tree, { showMetadata: true });
      expect(result).toBe('root');
      // Empty metadata should not add parentheses
      expect(result).not.toContain('(');
    });

    it('should handle tree with only one branch', () => {
      const linearTree: TreeNode = {
        name: 'a',
        children: [
          {
            name: 'b',
            children: [
              {
                name: 'c',
                children: [{ name: 'd' }],
              },
            ],
          },
        ],
      };

      const result = treeFormatter.format(linearTree);
      expect(result).toContain('a');
      expect(result).toContain('b');
      expect(result).toContain('c');
      expect(result).toContain('d');
    });
  });

  describe('Style variations', () => {
    it('should produce different outputs for each style', () => {
      const unicode = treeFormatter.format(simpleTree, { style: 'unicode' });
      const ascii = treeFormatter.format(simpleTree, { style: 'ascii' });
      const compact = treeFormatter.format(simpleTree, { style: 'compact' });

      // All should contain the same nodes
      [unicode, ascii, compact].forEach((result) => {
        expect(result).toContain('root');
        expect(result).toContain('child1');
        expect(result).toContain('parent');
      });

      // Each should be unique
      expect(unicode).not.toBe(ascii);
      expect(unicode).not.toBe(compact);
      expect(ascii).not.toBe(compact);

      // Style-specific checks
      expect(unicode).toContain('├');
      expect(ascii).toContain('+');
      expect(compact).not.toContain('├');
      expect(compact).not.toContain('+');
    });

    it('keeps ASCII vertical connectors for a non-last branch', () => {
      const result = treeFormatter.format(
        {
          name: 'root',
          children: [{ name: 'branch', children: [{ name: 'nested' }] }, { name: 'sibling' }],
        },
        { style: 'ascii', indent: '---' },
      );

      expect(result).toContain('|  \\-- nested');
    });

    it('degrades an unknown style to indentation without connectors', () => {
      const result = treeFormatter.format(
        {
          name: 'root',
          children: [{ name: 'branch', children: [{ name: 'nested' }] }, { name: 'sibling' }],
        },
        { style: 'future' as never, indent: '..' },
      );

      expect(result).toBe('root\nbranch\n..nested\nsibling');
    });
  });
});
