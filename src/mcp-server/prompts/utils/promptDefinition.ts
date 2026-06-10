/**
 * @fileoverview Prompt definition type and `prompt()` builder function.
 * Prompts are pure message templates — no Context, no auth, no side effects.
 *
 * MCP Prompts Specification:
 * @see {@link https://modelcontextprotocol.io/specification/2025-06-18/basic/prompts | MCP Prompts}
 * @module src/mcp-server/prompts/utils/promptDefinition
 */

import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape, z } from 'zod';

/**
 * Represents the complete, self-contained definition of an MCP prompt.
 */
export interface PromptDefinition<TArgs extends ZodObject<ZodRawShape> | undefined = undefined> {
  /**
   * Optional Zod schema for prompt arguments. All fields need `.describe()`.
   * Individual fields may be wrapped with `completable()` from
   * `@cyanheads/mcp-ts-core` to enable argument autocompletion — the SDK
   * auto-installs `completion/complete` handling when any registered prompt
   * arg is completable.
   * If undefined, the prompt accepts no arguments.
   */
  args?: TArgs;
  /** LLM-facing description. */
  description: string;
  /**
   * Generates the prompt messages from validated arguments.
   */
  generate: (
    args: TArgs extends ZodObject<ZodRawShape> ? z.infer<TArgs> : Record<string, never>,
  ) => PromptMessage[] | Promise<PromptMessage[]>;
  /** Programmatic unique name (snake_case). */
  name: string;
  /**
   * View-source URL override for the landing page. Bypasses the
   * `landing.repoRoot`-based auto-derivation, which assumes the file lives at
   * `<repoRoot>/blob/main/src/mcp-server/prompts/definitions/<kebab-name>.prompt.ts`.
   * Set this when the file path diverges from that convention (e.g.,
   * domain-namespaced subdirectories or a filename that doesn't mirror `name`).
   */
  sourceUrl?: string;
  /** Human-readable display title surfaced in `prompts/list`. */
  title?: string;
}

/** Widened type that accepts any `PromptDefinition` regardless of args schema. */
export type AnyPromptDefinition = PromptDefinition<ZodObject<ZodRawShape> | undefined>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Creates a prompt definition.
 *
 * @example
 * ```ts
 * const codeReview = prompt('code_review', {
 *   description: 'Review code for security and best practices.',
 *   args: z.object({
 *     code: z.string().describe('Code to review'),
 *     language: z.string().optional().describe('Programming language'),
 *   }),
 *   generate: (args) => [
 *     { role: 'user', content: { type: 'text', text: `Review: ${args.code}` } },
 *   ],
 * });
 * ```
 */
export function prompt<TArgs extends ZodObject<ZodRawShape> | undefined = undefined>(
  name: string,
  options: Omit<PromptDefinition<TArgs>, 'name'>,
): PromptDefinition<TArgs> {
  return { name, ...options };
}
