/**
 * @fileoverview Normalizes raw environment values before schema validation,
 * so "nothing was provided" reads the same whether the variable is unset,
 * empty, or an install-time placeholder nobody substituted.
 * @module src/config/envValue
 */

/**
 * A whole-value `${…}` reference — `${user_config.api_key}`, `${API_KEY}` —
 * that an install-time host (an MCPB manifest, a plugin manifest) forwarded
 * verbatim because nothing substituted it.
 */
const UNSUBSTITUTED_PLACEHOLDER = /^\$\{[^}]+\}$/;

/**
 * Returns `undefined` for a value that carries no configuration: an empty or
 * whitespace-only string, or an unsubstituted whole-value placeholder. An
 * optional field then stays unset, a defaulted field takes its default, and a
 * required field fails as missing rather than as a format error against the
 * literal text. Anything else — including a longer string that merely
 * contains `${…}` — passes through unchanged.
 */
export const emptyStringAsUndefined = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  return trimmed === '' || UNSUBSTITUTED_PLACEHOLDER.test(trimmed) ? undefined : val;
};

/** Applies {@link emptyStringAsUndefined} to every entry of an env map. */
export const normalizeEnv = (
  env: Record<string, string | undefined>,
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = emptyStringAsUndefined(value) as string | undefined;
  }
  return out;
};
