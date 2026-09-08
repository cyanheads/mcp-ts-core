/**
 * @fileoverview Advertise a tool's input schema to the SDK while keeping
 * argument rejection inside the framework (issue #377).
 *
 * SDK 2.0.0 rejects invalid `tools/call` arguments before the handler runs,
 * returning `{ content: [text], isError: true }` without `structuredContent.error`.
 * It exposes no per-tool validation hook, but uses `~standard` for both schema
 * advertising and validation.
 *
 * Preserve Zod's JSON Schema converters verbatim, including strict root keys
 * and `x-mcp-header` designations. Pass validation through to the framework
 * handler, which parses against the same schema and emits the structured error
 * envelope. The advertised schema and accepted arguments remain unchanged.
 *
 * @module src/mcp-server/tools/utils/deferredInputSchema
 */

import type { ToolInputSchema } from './toolDefinition.js';

/**
 * The `~standard` surface the SDK consumes from a registered input schema:
 * `jsonSchema[io]()` for advertising, `validate()` for `tools/call`.
 */
export interface DeferredInputSchema {
  '~standard': {
    jsonSchema: ToolInputSchema['~standard']['jsonSchema'];
    validate: (value: unknown) => { value: unknown };
    vendor: string;
    version: 1;
  };
}

/**
 * Wraps a tool's input schema for `server.registerTool()`. The JSON Schema
 * projection delegates to the source schema, so what `tools/list` advertises is
 * unchanged; `validate` passes arguments through untouched, leaving rejection
 * to the framework handler that parses them against the same schema.
 */
export function deferInputValidation(input: ToolInputSchema): DeferredInputSchema {
  return {
    '~standard': {
      jsonSchema: input['~standard'].jsonSchema,
      validate: (value) => ({ value }),
      vendor: 'mcp-ts-core',
      version: 1,
    },
  };
}
