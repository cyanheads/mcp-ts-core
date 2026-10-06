/**
 * @fileoverview Property tests for the canvas SQL gate's text layer — the
 * deny-list scan (`assertNoDeniedFunctions`) and the opt-in system-catalog scan
 * (`assertNoSystemCatalogs`). Engine-free: the properties pin how the scans
 * read SQL text. A call stays a call whatever its case, schema qualifier, or
 * the whitespace and comments between the name and its `(`, wherever it sits
 * in the statement; the same name inside a string literal or a comment is
 * text, not a call, and never trips the scan.
 * @module tests/fuzz/sql-gate.fuzz.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertNoDeniedFunctions,
  assertNoSystemCatalogs,
  DENIED_TABLE_FUNCTIONS,
} from '@/services/canvas/core/sqlGate.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

/** Random upper/lower casing of `name`, one choice per character. */
const anyCase = (name: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: name.length, maxLength: name.length })
    .map((upper) => [...name].map((ch, i) => (upper[i] ? ch.toUpperCase() : ch)).join(''));

/** A block comment whose body never closes it early. */
const blockComment = fc.string({ maxLength: 12 }).map((body) => `/*${body.replaceAll('*/', '')}*/`);

/** What SQL allows between a function name and its `(`: whitespace and block comments. */
const separator = fc
  .array(fc.oneof(fc.constantFrom(' ', '\t', '\n', '\r\n'), blockComment), { maxLength: 3 })
  .map((parts) => parts.join(''));

/** Every way the name can be qualified; each ends in a non-word character. */
const qualifier = fc.constantFrom('', 'main.', 'system.main.', 'MAIN.');

/** Statement text before the call, each ending where a table function can start. */
const lead = fc.constantFrom(
  'SELECT * FROM ',
  'FROM ',
  'select a, b from t, ',
  'WITH s AS (SELECT * FROM ',
  "SELECT 'it''s' AS q, * FROM ",
  '-- leading note\nSELECT * FROM ',
  'SELECT * FROM t UNION ALL SELECT * FROM ',
);

/** A single-quoted literal holding `text`, quotes doubled as SQL escapes them. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** A name the deny-list covers: an enumerated function or any `pragma_*` one. */
const deniedName = fc.oneof(
  fc.constantFrom(...DENIED_TABLE_FUNCTIONS),
  fc.stringMatching(/^[a-z0-9_]{1,16}$/).map((suffix) => `pragma_${suffix}`),
);

/** The validation error the scan throws, or a test failure when it throws nothing. */
function rejectionOf(run: () => void): McpError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    return err as McpError;
  }
  throw new Error('Expected the scan to reject.');
}

describe('sqlGate text layer · deny-listed calls', () => {
  it('rejects a call whatever its case, qualifier, separator, or surrounding statement', () => {
    fc.assert(
      fc.property(
        deniedName.chain((name) => fc.tuple(fc.constant(name), anyCase(name))),
        lead,
        qualifier,
        separator,
        ([name, cased], before, qual, sep) => {
          const sql = `${before}${qual}${cased}${sep}(${literal('/data/file')})`;
          const err = rejectionOf(() => assertNoDeniedFunctions(sql));
          expect(err.data).toMatchObject({ reason: 'denied_function', function: name });
        },
      ),
      { numRuns: 300, seed: 20_261_006 },
    );
  });

  it('ignores a deny-listed call that is only text inside a literal or a comment', () => {
    fc.assert(
      fc.property(deniedName, fc.string({ maxLength: 20 }), separator, (name, noise, sep) => {
        const call = `${name}${sep}(`;
        const comment = `${noise}${call}`.replaceAll('*/', '');
        for (const sql of [
          `SELECT ${literal(`${noise}${call}`)} AS s FROM t`,
          `SELECT x FROM t -- ${comment.replaceAll('\n', ' ').replaceAll('\r', ' ')}\n`,
          `SELECT x /* ${comment} */ FROM t`,
        ]) {
          expect(() => assertNoDeniedFunctions(sql)).not.toThrow();
        }
      }),
      { numRuns: 300, seed: 20_261_007 },
    );
  });
});

describe('sqlGate text layer · system catalogs', () => {
  const catalogRef = fc.oneof(
    fc.constantFrom('information_schema', 'pg_catalog').chain((schema) =>
      fc.tuple(
        fc.constant(schema),
        anyCase(schema).map((cased) => `${cased}.tables`),
      ),
    ),
    anyCase('sqlite_master').map((cased) => ['sqlite_master', cased] as const),
    fc.stringMatching(/^[a-z0-9_]{1,16}$/).chain((suffix) =>
      fc.tuple(
        fc.constant(`duckdb_${suffix}`),
        fc.tuple(anyCase(`duckdb_${suffix}`), separator).map(([cased, sep]) => `${cased}${sep}()`),
      ),
    ),
  );

  it('rejects a catalog reference whatever its case or placement', () => {
    fc.assert(
      fc.property(catalogRef, lead, ([catalog, ref], before) => {
        const err = rejectionOf(() => assertNoSystemCatalogs(`${before}${ref}`));
        expect(err.data).toMatchObject({ reason: 'system_catalog_access', catalog });
      }),
      { numRuns: 300, seed: 20_261_008 },
    );
  });

  it('ignores a catalog name that is only text inside a literal or a comment', () => {
    fc.assert(
      fc.property(catalogRef, fc.string({ maxLength: 20 }), ([, ref], noise) => {
        const comment = `${noise}${ref}`.replaceAll('*/', '');
        for (const sql of [
          `SELECT ${literal(`${noise}${ref}`)} AS s FROM t`,
          `SELECT x /* ${comment} */ FROM t`,
        ]) {
          expect(() => assertNoSystemCatalogs(sql)).not.toThrow();
        }
      }),
      { numRuns: 300, seed: 20_261_009 },
    );
  });
});
