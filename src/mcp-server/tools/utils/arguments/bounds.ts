/**
 * @fileoverview The caps an argument rejection's message and hint are held to
 * whatever the caller sends (#648): how many issue lines they render and how
 * many characters of each it reads. Each line is cut by `cutLine`
 * (`observabilityCap`), which every other `ZodError`'s one-line summary applies
 * to its path (#710). The bounded projection of the `data` its result and its
 * log record carry is `boundedProjection`, shared with every other classified
 * `ZodError`.
 * @module src/mcp-server/tools/utils/arguments/bounds
 */

import { REJECTION_ENTRIES } from '@/utils/internal/boundedProjection.js';
import { OBSERVABILITY_MAX_STRING_LENGTH } from '@/utils/internal/observabilityCap.js';
import type { LocatedIssue } from './issues.js';

/**
 * How much of an issue's rendering a rejection reads (#648): one character
 * past the longest line `cutLine` (`observabilityCap`) returns, so a line it cuts reads the
 * same as the whole rendering, and a line short enough to keep is whole.
 */
export const RENDERED_LENGTH = OBSERVABILITY_MAX_STRING_LENGTH + 2;

/** `text` as far as a rejection reads it: its first {@link RENDERED_LENGTH} characters. */
export function readable(text: string): string {
  return text.length > RENDERED_LENGTH ? text.slice(0, RENDERED_LENGTH) : text;
}

/** `(+N more)` for the issue lines past the first {@link REJECTION_ENTRIES}, or `undefined`. */
export function moreLines(lines: readonly LocatedIssue[]): string | undefined {
  const left = lines.length - REJECTION_ENTRIES;
  return left > 0 ? `(+${left} more)` : undefined;
}
