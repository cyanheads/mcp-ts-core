/**
 * @fileoverview The one sensitive-field list behind log redaction and log
 * sanitization, and the one key matcher every log sink redacts with.
 * @module tests/unit/utils/security/sensitiveFields.test
 */

import { describe, expect, it } from 'vitest';

import { sanitization } from '@/utils/security/sanitization.js';
import {
  DEFAULT_SENSITIVE_FIELDS,
  isSensitiveKey,
  toPinoRedactPaths,
} from '@/utils/security/sensitiveFields.js';
import { sampleCpuMs } from '../../../helpers/cpu-time.js';

describe('sensitiveFields', () => {
  it('expands each field to top-level, one-deep, and two-deep pino paths', () => {
    expect(toPinoRedactPaths(['token', 'apiKey'])).toEqual([
      'token',
      '*.token',
      '*.*.token',
      'apiKey',
      '*.apiKey',
      '*.*.apiKey',
    ]);
  });

  it('seeds Sanitization with the shared default list', () => {
    expect(sanitization.getSensitiveFields()).toEqual([...DEFAULT_SENSITIVE_FIELDS]);
    expect(sanitization.getSensitivePinoFields()).toEqual(
      toPinoRedactPaths(DEFAULT_SENSITIVE_FIELDS),
    );
  });

  it('covers the credential-bearing names redaction depends on', () => {
    for (const field of ['password', 'token', 'secret', 'apiKey', 'authorization', 'cookie']) {
      expect(DEFAULT_SENSITIVE_FIELDS).toContain(field);
    }
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'apiKey',
    'apikey',
    'API_KEY',
    'Api-Key',
    'accessToken',
    'refresh_token',
    'Authorization',
    'set-cookie',
    'client_secret',
    'ClientSecret',
    // #696 — a name spanning two words, with another word beside it.
    'x-api-key',
    'X-Api-Key',
    'X_API_KEY',
    'xApiKey',
    'upstream_private_key',
    'privateKeyPem',
    'clientSecretHash',
    'pass_word',
    // An acronym run ends where a capitalized word starts.
    'APIKey',
    'XApiKey',
    'HTTPSecret',
    'OAuthToken',
    'isSSNValid',
    'AWS_SECRET_ACCESS_KEY',
    'x-amz-security-token',
    // A run of digits is a word of its own.
    'apiKey2',
    'cvv2',
    'password1',
    'token2',
    'jwt2',
    'secret2',
    'privateKey2',
    'SSN_LAST4',
    'api_key_2',
    'X-API-KEY-2',
    // #702 — a name run into the word before it: a word ending with a name, or ending in `key`
    // with a name before that `key`.
    'DBPASSWORD',
    'XAPIKEY',
    'OPENAIAPIKEY',
    'GITHUBTOKEN',
    'JWTSECRET',
    'SESSIONCOOKIE',
    'USERSSN',
    'AWSSECRETACCESSKEY',
    'SECRETKEY',
    'X_DBPASSWORD',
    'DBPASSWORD_2',
    'accesstoken',
    'userpassword',
    // A trailing `keys` reads as `key`, in a run and in a single word alike.
    'api_keys',
    'apiKeys',
    'APIKEYS',
    'X-API-KEYS',
    'private_keys',
    'XAPIKEYS',
    'SECRETKEYS',
    // The plural of every name but `token`, as a run and as a word ending.
    'secrets',
    'api_secrets',
    'DBPASSWORDS',
    'passwords',
    'credentials',
    'cookies',
    'clientSecrets',
    'CLIENT_SECRETS',
    'privateKeys',
    'authorizations',
    'jwts',
    'USER_SSNS',
    'cvvs',
    // A list of credential tokens, though `tokens` alone is a count.
    'accessTokens',
    'refresh_tokens',
    'ACCESSTOKENS',
    'X_REFRESHTOKENS',
    'idTokens',
    'bearer_tokens',
    'sessionTokens',
    'oauthTokens',
    'apiTokens',
    'authTokens',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'max_tokens',
    'maxTokens',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'input_tokens',
    'tokenizer',
    'passwordless',
    'secretariat',
    'publicKey',
    'keyId',
    'apiVersion',
    '',
    // An all-caps word is one word, never a run of letters.
    'MAX_TOKENS',
    'PROMPT_TOKENS',
    'NUM_TOKENS',
    'TOKENIZER',
    'PASSWORDLESS',
    'SECRETARIAT',
    'SECRETARY_NAME',
    'CLASS_NAME',
    'ADDRESS_NAME',
    'BUSINESS_NAME',
    'PROCESS_NAME',
    'ACCESS_NUMBER',
    // Digits split a word without joining a name.
    'sha256',
    'utf8',
    'base64',
    'oauth2',
    'http2',
    's3Bucket',
    'v2Tokens',
    'tokens2',
    // A word that starts with a name, or ends with something other than a name or a `key`.
    'PASSWORDLESS',
    'TOKENIZER',
    'SECRETARY',
    'MAXTOKENS',
    'NUMTOKENS',
    'CLASSNAME',
    'BUSINESSNAME',
    'ADDRESSNUMBER',
    'KEYBOARD',
    'MONKEY',
    'TURKEY',
    'MONKEYS',
    'AUTHOR',
    'TOKENEXPIRY',
    'APIKEYID',
    'keys',
    'publicKeys',
    // A name followed by another word cannot be told from `PASSWORDLESS` without a dictionary.
    'PASSWORDHASH',
    'PRIVATEKEYPEM',
    // `tokens` names a token count, so the plural of `token` is the one plural left as written.
    'tokens',
    'TOKENS',
    'TOTALTOKENS',
    'secretariats',
  ])('leaves %s unredacted', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('matches a name added through setSensitiveFields across words, after answering for it once', () => {
    // Asked first, so a remembered verdict would survive the list change if the memo were not reset.
    expect(isSensitiveKey('upstream_session_id')).toBe(false);

    sanitization.setSensitiveFields(['sessionId']);

    expect(isSensitiveKey('upstream_session_id')).toBe(true);
    expect(isSensitiveKey('X-Session-Id')).toBe(true);
    expect(isSensitiveKey('sessionIdle')).toBe(false);
  });

  it('scans a key in time linear in its length', () => {
    /**
     * Fastest thread-CPU milliseconds of several samples over distinct keys of `length` characters, one
     * per worst case of the word split: one all-caps word, one-letter words, a hump or acronym end at
     * every character, and alternating letters and digits. Keys this long are never memoized.
     */
    const cost = (length: number): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let sample = 0; sample < 5; sample++) {
        const keys = ['A', 'a_', 'aB', 'ABc', 'a1', 'akey'].map(
          (unit) => `${unit.repeat(length / unit.length)}${sample}`,
        );
        best = Math.min(
          best,
          sampleCpuMs(() => {
            for (const key of keys) isSensitiveKey(key);
          }),
        );
      }
      return best;
    };

    cost(5_000);
    const at5k = cost(5_000);
    const at20k = cost(20_000);
    const at80k = cost(80_000);

    // 16× the characters: linear is ~16×, a scan over every run of words would be ~256×.
    expect(at80k / at5k).toBeLessThan(48);
    expect(at20k / at5k).toBeLessThan(12);
  });

  // Runs last: the name it adds stays on the list for the rest of the file.
  it('matches a short added name as the ending of any word', () => {
    expect(isSensitiveKey('monkey')).toBe(false);

    sanitization.setSensitiveFields(['key']);

    expect(isSensitiveKey('monkey')).toBe(true);
    expect(isSensitiveKey('TURKEY')).toBe(true);
    expect(isSensitiveKey('keyboard')).toBe(false);
  });
});
