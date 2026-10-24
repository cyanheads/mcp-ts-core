/**
 * @fileoverview Barrel export for formatting utilities.
 * @module utils/formatting
 */

export {
  type DiffFormat,
  DiffFormatter,
  type DiffFormatterOptions,
  diffFormatter,
} from './diffFormatter.js';
export {
  escapeHtml,
  type HtmlInterpolation,
  html,
  SafeHtml,
  unsafeRaw,
} from './html.js';
export { MarkdownBuilder, markdown } from './markdownBuilder.js';
export { escapeMarkdownInline, markdownImage, markdownLink } from './markdownInline.js';
export { failureEntrySchema, partialResult, partialResultSchema } from './partialResult.js';
export {
  type Alignment,
  TableFormatter,
  type TableFormatterOptions,
  type TableStyle,
  tableFormatter,
} from './tableFormatter.js';
export {
  TreeFormatter,
  type TreeFormatterOptions,
  type TreeNode,
  type TreeStyle,
  treeFormatter,
} from './treeFormatter.js';
