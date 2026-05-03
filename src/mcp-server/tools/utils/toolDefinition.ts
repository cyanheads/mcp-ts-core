/**
 * @fileoverview Tool definition types and `tool()` builder function.
 * Provides the canonical `ToolDefinition` interface and `ToolAnnotations` type
 * used by all tool definitions and the handler factory.
 *
 * Also re-exports `disabledTool()` and `DisabledMetadata` so consumers can
 * import the wrapper from the same `/tools` subpath as the builder.
 * @module src/mcp-server/tools/utils/toolDefinition
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape, z } from 'zod';

import type { HandlerContext, ReasonOf } from '@/core/context.js';
import type { ErrorContract } from '@/types-global/errors.js';

export { type DisabledMetadata, disabledTool } from './disabled-tool.js';

/**
 * Defines the annotations that provide hints about a tool's behavior.
 * These are not guarantees but are useful for client-side rendering and decision-making.
 * The index signature `[key: string]: unknown;` ensures compatibility with the MCP SDK.
 */
export interface ToolAnnotations {
  /**
   * A hint indicating that the tool may destroy or modify data in a way that cannot
   * be undone. Only meaningful when `readOnlyHint` is false (the default).
   * Defaults to `true` when unset.
   */
  destructiveHint?: boolean;
  /**
   * A hint indicating that repeated calls with the same arguments have no additional
   * effect beyond the first call. Only meaningful when `readOnlyHint` is false.
   * Defaults to `false` when unset.
   */
  idempotentHint?: boolean;
  /**
   * A hint indicating that the tool may interact with external, unpredictable,
   * or dynamic systems (e.g., fetching from a live API, web search).
   */
  openWorldHint?: boolean;
  /**
   * A hint indicating that the tool does not modify any state.
   * For example, a "read" operation.
   */
  readOnlyHint?: boolean;
  /**
   * An optional human-readable name for the tool, optimized for UI display.
   * If provided, it may be used by clients instead of the programmatic `name`.
   */
  title?: string;
  [key: string]: unknown;
}

/**
 * Represents the complete, self-contained definition of an MCP tool.
 *
 * `TErrors` is the const tuple of `ErrorContract` entries declared on the
 * definition (or `undefined` when none are declared). The reason union extracted
 * from `TErrors` flows into the handler's `ctx.fail` for compile-time-checked
 * error throws.
 */
export interface ToolDefinition<
  TInput extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape> = ZodObject<ZodRawShape>,
  TErrors extends readonly ErrorContract[] | undefined = undefined,
> {
  /** Protocol-level metadata (e.g., MCP Apps extension). */
  _meta?: Record<string, unknown>;
  /** UI/behavior hints for clients. */
  annotations?: ToolAnnotations;
  /** Required auth scopes. Checked by handler factory before calling handler. */
  auth?: string[];
  /** LLM-facing description. */
  description: string;
  /**
   * Declarative contract describing the failure modes this tool can surface.
   *
   * Each entry pairs a `JsonRpcErrorCode` with a stable `reason` string and a
   * `when` description.
   *
   * **Type-driven.** When declared, the handler receives `ctx.fail(reason, …)`
   * typed against the union of `reason` strings — TypeScript enforces that you
   * can only `fail()` with a declared reason, and the runtime auto-populates
   * `data.reason` on the thrown `McpError`.
   *
   * Optional. Without it, handlers still throw `McpError` directly and the
   * framework's auto-classifier produces correct codes at runtime — the
   * contract just adds compile-time enforcement.
   *
   * The startup linter validates each entry's `code` is a real `JsonRpcErrorCode`
   * and that `reason` strings are unique within the contract.
   */
  errors?: TErrors;
  /**
   * Optional formatter mapping output to MCP `content[]`. Different MCP clients
   * forward different surfaces to the model: some (e.g., Claude Code) read
   * `structuredContent` from `output`, others (e.g., Claude Desktop) read
   * `content[]` from `format()`. **Both must be content-complete** — `format()`
   * is the markdown-rendered twin of `structuredContent`, not a separate payload.
   *
   * **Make `format()` content-complete.** A thin one-liner (e.g., a count or
   * title) leaves `content[]`-only clients blind to data that `structuredContent`
   * clients can see. The `format-parity` lint rule enforces this at startup.
   *
   * If omitted, the handler factory JSON-stringifies the output as a fallback.
   */
  format?: (result: z.infer<TOutput>) => ContentBlock[];
  /**
   * The core handler function. Receives validated input and unified Context.
   * Throw on failure — no try/catch needed.
   *
   * When `errors[]` is declared, `ctx` carries a typed `fail(reason, message?, data?)`
   * helper keyed by the declared reason union — `ctx.fail('typo')` is a TS error.
   * Without `errors[]`, `ctx` is plain `Context` and you throw `McpError` directly.
   *
   * Declared as a method (not an arrow property) so TypeScript checks the
   * signature bivariantly — concrete tools with narrow `ctx.fail` types remain
   * assignable to the type-erased `AnyToolDefinition` array.
   */
  handler(
    input: z.infer<TInput>,
    ctx: HandlerContext<ReasonOf<TErrors>>,
  ): Promise<z.infer<TOutput>> | z.infer<TOutput>;
  /** Zod schema for input validation. All fields need `.describe()`. */
  input: TInput;
  /** Programmatic unique name (snake_case). */
  name: string;
  /** Zod schema for output validation. All fields need `.describe()`. */
  output: TOutput;
  /**
   * View-source URL override for the landing page. Bypasses the
   * `landing.repoRoot`-based auto-derivation, which assumes the file lives at
   * `<repoRoot>/blob/main/src/mcp-server/tools/definitions/<kebab-name>.tool.ts`.
   * Set this when the file path diverges from that convention (e.g.,
   * domain-namespaced subdirectories or a filename that doesn't mirror `name`).
   */
  sourceUrl?: string;
  /** When true, the framework manages task lifecycle automatically. */
  task?: boolean;
  /** Human-readable title for UI display. */
  title?: string;
}

/** Type-erased union for mixed arrays passed to createApp(). */
export type AnyToolDefinition = ToolDefinition<
  ZodObject<ZodRawShape>,
  ZodObject<ZodRawShape>,
  readonly ErrorContract[] | undefined
>;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Creates a tool definition with full type inference from Zod schemas.
 *
 * The `const` modifier on `TErrors` preserves literal types in the `errors[]`
 * array without requiring `as const` at the call site, so the reason union
 * flows into `ctx.fail` automatically.
 *
 * @example Without an error contract — throw `McpError` directly:
 * ```ts
 * const myTool = tool('my_tool', {
 *   description: 'Does something useful.',
 *   input: z.object({ query: z.string().describe('Search query') }),
 *   output: z.object({
 *     items: z.array(z.object({
 *       id: z.string().describe('Item ID'),
 *       name: z.string().describe('Item name'),
 *     })).describe('Matching items'),
 *   }),
 *   async handler(input, ctx) {
 *     if (!input.query) throw notFound('Empty query');
 *     return { items: await search(input.query) };
 *   },
 * });
 * ```
 *
 * @example With a typed error contract — `ctx.fail(reason, …)`:
 * ```ts
 * const myTool = tool('my_tool', {
 *   errors: [
 *     { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
 *       when: 'No items match the query',
 *       recovery: 'Broaden the query or check the spelling and try again.' },
 *     { reason: 'rate_limited', code: JsonRpcErrorCode.RateLimited,
 *       when: 'Upstream rate limit hit', retryable: true,
 *       recovery: 'Wait a few seconds before retrying or reduce request frequency.' },
 *   ],
 *   input: z.object({ query: z.string().describe('Search query') }),
 *   output: z.object({ items: z.array(z.string()).describe('Matched items') }),
 *   async handler(input, ctx) {
 *     const items = await search(input.query);
 *     if (items.length === 0) throw ctx.fail('no_match', `No matches for "${input.query}"`);
 *     // ctx.fail('typo')  ← TypeScript error: 'typo' isn't in the contract
 *     return { items };
 *   },
 * });
 * ```
 */
export function tool<
  TInput extends ZodObject<ZodRawShape>,
  TOutput extends ZodObject<ZodRawShape>,
  const TErrors extends readonly ErrorContract[] | undefined = undefined,
>(
  name: string,
  options: Omit<ToolDefinition<TInput, TOutput, TErrors>, 'name'>,
): ToolDefinition<TInput, TOutput, TErrors> {
  return { name, ...options };
}
