/**
 * @fileoverview The field names treated as secrets by log redaction and log
 * sanitization. A leaf module so the logger (which cannot import
 * `sanitization` without a cycle) and `Sanitization` share one list.
 * @module src/utils/security/sensitiveFields
 */

/** Field names redacted from logs by default (matched case-insensitively). */
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = [
  'password',
  'token',
  'secret',
  'apiKey',
  'credential',
  'jwt',
  'ssn',
  'cvv',
  'authorization',
  'cookie',
  'clientsecret',
  'client_secret',
  'private_key',
  'privatekey',
];

/**
 * Expands field names into pino `redact.paths` patterns at three depths:
 * `token`, `*.token`, and `*.*.token`.
 */
export function toPinoRedactPaths(fields: readonly string[]): string[] {
  return fields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);
}
