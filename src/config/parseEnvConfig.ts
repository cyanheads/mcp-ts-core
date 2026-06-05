/**
 * @fileoverview Helper for parsing server-specific config from environment
 * variables. Produces friendly, env-var-aware error messages when validation
 * fails — naming the actual variable at fault rather than the internal Zod path.
 * @module src/config/parseEnvConfig
 */

import type { z } from 'zod';

import { configurationError } from '../types-global/errors.js';

/**
 * Parses environment variables against a Zod schema using an explicit mapping
 * from schema paths to env var names. On validation failure, throws a
 * {@link configurationError} whose message names the actual environment
 * variable(s) — not the internal Zod path.
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
 * @param schema - Zod schema describing the server config shape.
 * @param envMap - Maps top-level schema keys to their env var names.
 * @param env - Source of env values. Defaults to `process.env`; override for testing.
 * @returns Parsed, validated config typed as `z.infer<T>`.
 * @throws {McpError} With `ConfigurationError` code if validation fails.
 */
export function parseEnvConfig<T extends z.ZodType>(
  schema: T,
  envMap: Record<string, string>,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): z.infer<T> {
  const input: Record<string, unknown> = {};
  for (const [key, envVar] of Object.entries(envMap)) {
    input[key] = env[envVar];
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const lines = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    const envVar = envMap[path] ?? path;
    return `  - ${envVar} (${path}): ${issue.message}`;
  });

  throw configurationError(`Server config validation failed:\n${lines.join('\n')}`, {
    issues: result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return {
        path,
        envVar: envMap[path] ?? path,
        message: issue.message,
        code: issue.code,
      };
    }),
  });
}
