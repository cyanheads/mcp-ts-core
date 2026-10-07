/**
 * @fileoverview The field names treated as secrets, and the one key matcher
 * every log sink redacts with: the log-data walk behind the process log,
 * `interactions.log`, and the OTLP export; the `ctx.log` client mirror; and
 * `sanitizeForLogging`. A leaf module, so the logger (which cannot import
 * `sanitization` without a cycle) and `Sanitization` share one list and one matcher.
 * @module src/utils/security/sensitiveFields
 */

/**
 * Field names redacted from logs by default — matched case- and
 * separator-insensitively against every run of adjacent words in a key
 * ({@link isSensitiveKey}).
 */
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

/** Verdicts {@link isSensitiveKey} remembers before starting over. */
const MAX_REMEMBERED_KEYS = 4_096;
/** A key longer than this is matched on every call, so the memo's memory stays bounded. */
const MAX_REMEMBERED_KEY_LENGTH = 256;

/** Each sensitive field lowercased, with every character other than a letter or digit removed. */
let sensitiveNames: ReadonlySet<string> = new Set();
/** The longest of {@link sensitiveNames}: a longer run of words cannot equal one. */
let longestName = 0;
/** {@link isSensitiveKey} verdicts by key; cleared whenever the names change. */
const verdicts = new Map<string, boolean>();

/** Lowercases a field name and strips every character other than a letter or digit. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Replaces the names {@link isSensitiveKey} matches. `Sanitization.setSensitiveFields`
 * passes its merged list, so an added name reaches every log sink at once.
 *
 * @internal Called by `Sanitization`. Not part of the public API.
 */
export function setSensitiveNames(fields: readonly string[]): void {
  sensitiveNames = new Set(fields.map(normalizeName).filter(Boolean));
  longestName = Math.max(0, ...Array.from(sensitiveNames, (name) => name.length));
  verdicts.clear();
}

setSensitiveNames(DEFAULT_SENSITIVE_FIELDS);

/**
 * Whether some run of `key`'s adjacent words, joined, is a sensitive name. Each
 * split is a fixed-width match or lookahead, so splitting is linear in the key's
 * length; an acronym split written as `([A-Z]+)([A-Z][a-z])` backtracks on an
 * all-caps key and is quadratic (4 s for 80,000 characters).
 */
function hasSensitiveRun(key: string): boolean {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .replace(/\d+/g, ' $& ')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (let start = 0; start < words.length; start++) {
    let run = '';
    for (let end = start; end < words.length && run.length < longestName; end++) {
      run += words[end];
      if (sensitiveNames.has(run)) return true;
    }
  }
  return false;
}

/**
 * Whether `key` names a sensitive field: some run of its adjacent words,
 * joined, equals a sensitive name. A key splits into words, lowercased, at
 * every character other than a letter or digit, at a lowercase letter followed
 * by a capital (`apiKey`), at the end of a run of capitals (`HTTPSecret`), and
 * around each run of digits (`apiKey2`) — so `apiKey`, `API_KEY`, `APIKey`, and
 * `x-api-key` all hold the run `apikey`, `accessToken` and
 * `upstream_private_key` hold `token` and `privatekey`, and `cvv2` holds `cvv`.
 * A word that only contains a name is not a match, whatever its case:
 * `max_tokens`, `MAX_TOKENS`, `tokenizer`, `PASSWORDLESS`. Runs no longer than
 * the longest name are tried, so the scan is linear in the key's length.
 *
 * @internal The matcher behind log redaction and log sanitization. Not part of the public API.
 */
export function isSensitiveKey(key: string): boolean {
  const remembered = verdicts.get(key);
  if (remembered !== undefined) return remembered;
  const verdict = hasSensitiveRun(key);
  if (key.length <= MAX_REMEMBERED_KEY_LENGTH) {
    if (verdicts.size >= MAX_REMEMBERED_KEYS) verdicts.clear();
    verdicts.set(key, verdict);
  }
  return verdict;
}
