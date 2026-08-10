/**
 * @fileoverview Internal log-level alias table. Shared by `ConfigSchema` and the
 * Worker entry point so a runtime that pre-screens `LOG_LEVEL` before it reaches
 * the schema accepts the same spellings the schema does. Not part of the public
 * `/config` surface — import it directly.
 * @module src/config/logLevelAlias
 */

/**
 * Common log-level spellings mapped to their RFC5424/MCP names, so an operator
 * writing `warn` or `trace` gets the level they meant.
 */
const LOG_LEVEL_ALIASES: Record<string, string> = {
  err: 'error',
  fatal: 'emerg',
  information: 'info',
  silent: 'emerg',
  trace: 'debug',
  warn: 'warning',
};

/**
 * Lowercases a log-level string and resolves its alias.
 *
 * @param value - A raw log-level string, in any casing.
 * @returns The canonical spelling, which may still be an unsupported level.
 */
export function normalizeLogLevelAlias(value: string): string {
  const lower = value.toLowerCase();
  return LOG_LEVEL_ALIASES[lower] ?? lower;
}
