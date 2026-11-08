/**
 * @fileoverview Register a tool's schemas with the SDK for advertising only,
 * keeping every parse of a `tools/call` inside the framework.
 *
 * The SDK reads a registered schema through `~standard` twice: `jsonSchema` to
 * build `tools/list`, and `validate()` on each call — the arguments before the
 * handler runs, then the handler's `structuredContent` after it returns. It
 * exposes no per-tool hook for either check, and both get in the way:
 *
 * - **Input (#377).** A rejected argument comes back as
 *   `{ content: [text], isError: true }` with no `structuredContent.error`.
 *   The framework handler parses the same arguments against the same schema
 *   and emits the structured error envelope instead.
 * - **Output (#846).** The framework has already parsed the result against the
 *   strict `output` (and the `enrichment` block), so the SDK's check reads a
 *   parsed value against the schema's *input* side, where a field whose parsed
 *   value is not valid input to it — `z.stringbool()`, a cross-type `.pipe()`,
 *   a codec — fails every successful call, as a text-only error the framework
 *   logged as a success. Against the widened advertised schema it catches
 *   nothing the strict parse has not already.
 *
 * The wrapper keeps the source schema's JSON Schema converters verbatim —
 * strict root keys, `x-mcp-header` designations, the widened output's `anyOf`
 * refinement — and passes every value through `validate()` untouched, so what
 * `tools/list` advertises and what a call accepts are both unchanged.
 *
 * @module src/mcp-server/tools/utils/deferredSchema
 */

import type { ZodType } from 'zod';

/**
 * The `~standard` surface the SDK consumes from a registered schema:
 * `jsonSchema[io]()` for advertising, `validate()` on `tools/call`.
 */
export interface DeferredSchema {
  '~standard': {
    jsonSchema: ZodType['~standard']['jsonSchema'];
    validate: (value: unknown) => { value: unknown };
    vendor: string;
    version: 1;
  };
}

/**
 * Wraps a schema for `server.registerTool()` — the tool's `input` as its
 * `inputSchema`, its advertised output schema as its `outputSchema`. The JSON
 * Schema projection delegates to the source schema, so what `tools/list`
 * advertises is unchanged; `validate` passes the value through untouched,
 * leaving every rejection to the framework handler's own parse.
 */
export function deferValidation(schema: ZodType): DeferredSchema {
  return {
    '~standard': {
      jsonSchema: schema['~standard'].jsonSchema,
      validate: (value) => ({ value }),
      vendor: 'mcp-ts-core',
      version: 1,
    },
  };
}
