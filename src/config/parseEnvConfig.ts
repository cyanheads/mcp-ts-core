/**
 * @fileoverview Helper for parsing server-specific config from environment
 * variables. Produces friendly, env-var-aware error messages when validation
 * fails — naming the actual variable at fault rather than the internal Zod path.
 * @module src/config/parseEnvConfig
 */

import type { z } from 'zod';

import { configurationError } from '../types-global/errors.js';
import { formatEnvIssues, toEnvIssues } from './envIssue.js';
import { emptyStringAsUndefined } from './envValue.js';

/**
 * Parses environment variables against a Zod schema using an explicit mapping
 * from schema paths to env var names. On validation failure, throws a
 * {@link configurationError} whose message names the actual environment
 * variable(s) — not the internal Zod path.
 *
 * An empty string and a whole-value `${…}` placeholder (what an MCPB or plugin
 * host forwards when a user leaves an option blank and nothing substitutes it)
 * both read as the variable being absent: an optional field stays `undefined`,
 * a defaulted field takes its default, and a required field fails as missing
 * rather than as a format error against the literal text. A value that merely
 * contains `${…}` is kept.
 *
 * @example
 * ```ts
 * import { z } from '@cyanheads/mcp-ts-core';
 * import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
 *
 * const ServerConfigSchema = z.object({
 *   apiKey: z.string().describe('External API key'),
 *   maxResults: z.coerce.number().default(100),
 *   // Use z.stringbool() for env booleans, never z.coerce.boolean() —
 *   // Boolean("false") is true, so coerce can't be turned off via the env.
 *   verboseLogging: z.stringbool().default(false),
 * });
 *
 * let _config: z.infer<typeof ServerConfigSchema> | undefined;
 * export function getServerConfig() {
 *   _config ??= parseEnvConfig(ServerConfigSchema, {
 *     apiKey: 'MY_API_KEY',
 *     maxResults: 'MY_MAX_RESULTS',
 *     verboseLogging: 'MY_VERBOSE_LOGGING',
 *   });
 *   return _config;
 * }
 * ```
 *
 * If `MY_API_KEY` is unset, the thrown error reads:
 *
 * ```
 * Server config validation failed:
 *   - MY_API_KEY (apiKey): Invalid input: expected string, received undefined
 * ```
 *
 * A failure inside a field — an array element a `.transform()` / `.pipe()`
 * produced, a property of an object parsed from one JSON variable — names the
 * variable that fed the field, with the full schema path in parentheses
 * (`MY_ENDPOINTS (endpoints.0.url)`). A root-level `.refine()` issue has no
 * field to attribute and is reported under its empty path.
 *
 * @param schema - Zod schema describing the server config shape.
 * @param envMap - Maps top-level schema keys to their env var names. Every
 *   issue under a key — the key's own value or anything nested in it — is
 *   attributed to that key's variable.
 * @param env - Source of env values. Defaults to `process.env`; override for testing.
 * @returns Parsed, validated config typed as `z.infer<T>`.
 * @throws {McpError} With `ConfigurationError` code if validation fails.
 */
export function parseEnvConfig<T extends z.ZodType>(
  schema: T,
  envMap: Record<string, string>,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): z.infer<T> {
  // Null-prototype, so a schema key like `constructor` reads as absent rather than inherited.
  const input: Record<string, unknown> = Object.create(null);
  for (const [key, envVar] of Object.entries(envMap)) {
    input[key] = emptyStringAsUndefined(env[envVar]);
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  // The first path segment is always the envMap key whose variable fed the value.
  const issues = toEnvIssues(result.error.issues, envMap);
  throw configurationError(`Server config validation failed:\n${formatEnvIssues(issues)}`, {
    issues,
  });
}
