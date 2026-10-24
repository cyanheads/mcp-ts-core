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
 * separator-insensitively against every run of adjacent words in a key, and
 * against the ending of every word ({@link isSensitiveKey}).
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

/**
 * The one name whose plural is not sensitive: `tokens` names a token count
 * (`max_tokens`, `total_tokens`, `NUM_TOKENS`), not a set of credentials.
 */
const NAME_WITHOUT_PLURAL = 'token';

/**
 * Lists of credential tokens, matched although `tokens` alone is left as a
 * count: `accessTokens`, `refresh_tokens`, `ACCESSTOKENS`.
 */
const TOKEN_LIST_NAMES = [
  'accesstokens',
  'apitokens',
  'authtokens',
  'bearertokens',
  'idtokens',
  'oauthtokens',
  'refreshtokens',
  'sessiontokens',
] as const;

/**
 * Each sensitive field lowercased, with every character other than a letter or
 * digit removed, its plural (`secrets`) for every name but
 * {@link NAME_WITHOUT_PLURAL}, and the {@link TOKEN_LIST_NAMES}.
 */
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
  const names = fields.map(normalizeName).filter(Boolean);
  sensitiveNames = new Set([
    ...names,
    ...names.filter((name) => name !== NAME_WITHOUT_PLURAL).map((name) => `${name}s`),
    ...TOKEN_LIST_NAMES,
  ]);
  longestName = Math.max(0, ...Array.from(sensitiveNames, (name) => name.length));
  verdicts.clear();
}

setSensitiveNames(DEFAULT_SENSITIVE_FIELDS);

/**
 * Whether `word` ends with a sensitive name, or ends in `key` with a sensitive
 * name anywhere before that `key` (`awssecretaccesskey`).
 */
function isSensitiveWord(word: string): boolean {
  for (const name of sensitiveNames) {
    if (word.endsWith(name)) return true;
  }
  if (!word.endsWith('key')) return false;
  const stem = word.slice(0, -3);
  for (const name of sensitiveNames) {
    if (stem.includes(name)) return true;
  }
  return false;
}

/**
 * Whether some word of `key` is sensitive ({@link isSensitiveWord}) or some run
 * of its adjacent words, joined, is a sensitive name. A trailing `keys` reads as
 * `key` first. Each split is a fixed-width match or lookahead, so splitting is
 * linear in the key's length; an acronym split written as
 * `([A-Z]+)([A-Z][a-z])` backtracks on an all-caps key and is quadratic (4 s
 * for 80,000 characters).
 */
function hasSensitiveName(key: string): boolean {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .replace(/\d+/g, ' $& ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.endsWith('keys') ? word.slice(0, -1) : word));
  for (const [start, word] of words.entries()) {
    if (isSensitiveWord(word)) return true;
    let run = '';
    for (let end = start; end < words.length && run.length < longestName; end++) {
      run += words[end];
      if (sensitiveNames.has(run)) return true;
    }
  }
  return false;
}

/**
 * Whether `key` names a sensitive field. A key splits into words, lowercased,
 * at every character other than a letter or digit, at a lowercase letter
 * followed by a capital (`apiKey`), at the end of a run of capitals
 * (`HTTPSecret`), and around each run of digits (`apiKey2`); a word ending in
 * `keys` then reads as ending in `key`. The plural of every name but `token` is
 * a name too (`secrets`, `cookies`, `api_secrets`, `DBPASSWORDS`): `tokens`
 * names a token count (`max_tokens`, `NUM_TOKENS`), so it stays as written; a
 * fixed set of credential-token lists (`accessTokens`, `refresh_tokens`,
 * `idTokens`) is matched instead. The key is sensitive when either holds:
 *
 * - Some run of its adjacent words, joined, equals a sensitive name: `apiKey`,
 *   `API_KEY`, `APIKey`, `x-api-key`, and `api_keys` all hold the run `apikey`,
 *   `accessToken` and `upstream_private_key` hold `token` and `privatekey`, and
 *   `cvv2` holds `cvv`.
 * - Some single word ends with a sensitive name (`DBPASSWORD`, `accesstoken`,
 *   `XAPIKEY`), or ends in `key` with a sensitive name before that `key`
 *   (`AWSSECRETACCESSKEY`, `SECRETKEY`).
 *
 * A word that starts with a name, or holds one in the middle, is not a match,
 * whatever its case: `max_tokens`, `MAXTOKENS`, `tokenizer`, `PASSWORDLESS`.
 * So `PASSWORDHASH` and `PRIVATEKEYPEM` are not matched either: a name followed
 * by another word cannot be told from `PASSWORDLESS` without a dictionary. A
 * short name added through `setSensitiveFields` matches as the ending of any
 * word — `key` matches `monkey`. Runs no longer than the longest name are tried
 * and each word is checked against each name once, so the scan is linear in the
 * key's length.
 *
 * @internal The matcher behind log redaction and log sanitization. Not part of the public API.
 */
export function isSensitiveKey(key: string): boolean {
  const remembered = verdicts.get(key);
  if (remembered !== undefined) return remembered;
  const verdict = hasSensitiveName(key);
  if (key.length <= MAX_REMEMBERED_KEY_LENGTH) {
    if (verdicts.size >= MAX_REMEMBERED_KEYS) verdicts.clear();
    verdicts.set(key, verdict);
  }
  return verdict;
}
