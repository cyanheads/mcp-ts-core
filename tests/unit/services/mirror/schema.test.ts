/**
 * @fileoverview Tests for mirror schema generation — DDL shape, FTS opt-in,
 * spec validation, and that the generated SQL executes against a real handle.
 * @module tests/unit/services/mirror/schema
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteHandle } from '@/services/mirror/sqlite/handle.js';
import {
  buildSchemaDdl,
  buildSchemaSql,
  DEFAULT_FTS_TOKENIZER,
  type SchemaSpec,
  validateSchemaSpec,
} from '@/services/mirror/sqlite/schema.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

const baseSpec: SchemaSpec = {
  table: 'papers',
  primaryKey: 'id',
  columns: { id: 'TEXT', title: 'TEXT', abstract: 'TEXT', updated: 'TEXT' },
  fts: ['title', 'abstract'],
  indexes: [{ columns: ['updated'] }],
};

/** What `buildSchemaSql(baseSpec)` returns: the exported function's output, seeds included. */
const BASE_SPEC_SQL = `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  abstract TEXT,
  updated TEXT
);

CREATE INDEX IF NOT EXISTS papers_updated_idx ON papers(updated);

CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
  title,
  abstract,
  content='papers',
  content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS papers_ai AFTER INSERT ON papers BEGIN
  INSERT INTO papers_fts(rowid, title, abstract) VALUES (new.rowid, new.title, new.abstract);
END;

CREATE TRIGGER IF NOT EXISTS papers_ad AFTER DELETE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, abstract) VALUES ('delete', old.rowid, old.title, old.abstract);
END;

CREATE TRIGGER IF NOT EXISTS papers_au AFTER UPDATE ON papers BEGIN
  INSERT INTO papers_fts(papers_fts, rowid, title, abstract) VALUES ('delete', old.rowid, old.title, old.abstract);
  INSERT INTO papers_fts(rowid, title, abstract) VALUES (new.rowid, new.title, new.abstract);
END;

CREATE TABLE IF NOT EXISTS mirror_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  cursor TEXT,
  checkpoint TEXT,
  started_at TEXT,
  completed_at TEXT,
  total INTEGER,
  error TEXT,
  mode TEXT
);

INSERT OR IGNORE INTO mirror_sync_state(id, status) VALUES (1, 'pending');

CREATE TABLE IF NOT EXISTS mirror_sync_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER
);

INSERT OR IGNORE INTO mirror_sync_lease(id, generation) VALUES (1, 0);`;

const STATE_SEED = "INSERT OR IGNORE INTO mirror_sync_state(id, status) VALUES (1, 'pending');";
const LEASE_SEED = 'INSERT OR IGNORE INTO mirror_sync_lease(id, generation) VALUES (1, 0);';

describe('buildSchemaSql', () => {
  it('returns every DDL statement and both seed rows, in order', () => {
    expect(buildSchemaSql(baseSpec)).toBe(BASE_SPEC_SQL);
  });

  it('declares the primary key on the named column', () => {
    const sql = buildSchemaSql(baseSpec);
    expect(sql).toContain('id TEXT PRIMARY KEY NOT NULL');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS papers');
  });

  it('emits the FTS virtual table, triggers, and tokenizer when fts columns are given', () => {
    const sql = buildSchemaSql(baseSpec);
    expect(sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5');
    expect(sql).toContain(`tokenize="${DEFAULT_FTS_TOKENIZER}"`);
    expect(sql).toContain('papers_ai AFTER INSERT');
    expect(sql).toContain('papers_ad AFTER DELETE');
    expect(sql).toContain('papers_au AFTER UPDATE');
    // External-content delete uses the command-row form.
    expect(sql).toContain('INSERT INTO papers_fts(papers_fts, rowid');
  });

  it('honors a custom tokenizer', () => {
    const sql = buildSchemaSql({ ...baseSpec, ftsTokenizer: "unicode61 tokenchars '-_'" });
    expect(sql).toContain(`tokenize="unicode61 tokenchars '-_'"`);
  });

  it('skips FTS entirely when no fts columns are declared', () => {
    const sql = buildSchemaSql({ table: 't', primaryKey: 'id', columns: { id: 'TEXT' } });
    expect(sql).not.toContain('fts5');
    expect(sql).not.toContain('AFTER INSERT');
  });

  it('creates declared secondary indexes', () => {
    const sql = buildSchemaSql(baseSpec);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS papers_updated_idx ON papers(updated)');
  });

  it('always emits sync_state and schema_version tables', () => {
    const sql = buildSchemaSql(baseSpec);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mirror_sync_state');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS schema_version');
    expect(sql).toContain(
      "INSERT OR IGNORE INTO mirror_sync_state(id, status) VALUES (1, 'pending')",
    );
  });

  it('always emits the single-row sync lease table and its unheld seed row', () => {
    const sql = buildSchemaSql(baseSpec);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mirror_sync_lease');
    expect(sql).toContain('INSERT OR IGNORE INTO mirror_sync_lease(id, generation) VALUES (1, 0)');
  });
});

describe('buildSchemaDdl', () => {
  it('is buildSchemaSql without its two seed rows', () => {
    expect(BASE_SPEC_SQL).toContain(STATE_SEED);
    expect(BASE_SPEC_SQL).toContain(LEASE_SEED);
    expect(buildSchemaDdl(baseSpec)).toBe(
      BASE_SPEC_SQL.replace(`\n\n${STATE_SEED}`, '').replace(`\n\n${LEASE_SEED}`, ''),
    );
  });

  it('validates the spec as buildSchemaSql does', () => {
    expect(() => buildSchemaDdl({ ...baseSpec, primaryKey: 'missing' })).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ConfigurationError }),
    );
  });
});

describe('validateSchemaSpec', () => {
  it('rejects an invalid table identifier', () => {
    expect(() => validateSchemaSpec({ ...baseSpec, table: 'bad table' })).toThrow(/identifier/);
  });

  it('rejects a primaryKey not among columns', () => {
    expect(() => validateSchemaSpec({ ...baseSpec, primaryKey: 'missing' })).toThrow(/primaryKey/);
  });

  it('rejects an fts column that is not declared', () => {
    expect(() => validateSchemaSpec({ ...baseSpec, fts: ['nope'] })).toThrow(/FTS column/);
  });

  it('rejects an index column that is not declared', () => {
    expect(() => validateSchemaSpec({ ...baseSpec, indexes: [{ columns: ['ghost'] }] })).toThrow(
      /index column/,
    );
  });

  // `columns` is a plain object, so these names reach it through Object.prototype.
  it.each(
    ['toString', 'constructor', '__proto__'].flatMap(
      (name): Array<[string, string, SchemaSpec, RegExp]> => [
        ['primaryKey', name, { ...baseSpec, primaryKey: name }, /primaryKey/],
        ['an FTS column', name, { ...baseSpec, fts: ['title', name] }, /FTS column/],
        ['an index column', name, { ...baseSpec, indexes: [{ columns: [name] }] }, /index column/],
      ],
    ),
  )(
    'rejects %s named %s, which columns only inherits, with ConfigurationError',
    (_role, _name, spec, message) => {
      expect(() => validateSchemaSpec(spec)).toThrowError(
        expect.objectContaining({
          code: JsonRpcErrorCode.ConfigurationError,
          message: expect.stringMatching(message),
        }),
      );
    },
  );

  it('rejects a tokenizer containing a double quote', () => {
    expect(() => validateSchemaSpec({ ...baseSpec, ftsTokenizer: 'bad"tok' })).toThrow(
      /double-quote/,
    );
  });

  it('rejects an empty column set', () => {
    expect(() => validateSchemaSpec({ table: 't', primaryKey: 'id', columns: {} })).toThrow(
      /at least one column/,
    );
  });
});

describe('generated DDL executes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-schema-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs against a real SQLite handle without error', async () => {
    const handle = await openSqliteHandle(join(dir, 'schema.db'));
    expect(() => handle.exec(buildSchemaSql(baseSpec))).not.toThrow();
    // FTS round-trip proves the virtual table + triggers are wired.
    handle
      .prepare(`INSERT INTO papers(id, title, abstract, updated) VALUES (?, ?, ?, ?)`)
      .run('1', 'Quantum entanglement', 'A study of entangled photons', '2024-01-01');
    const hit = handle
      .prepare<{ id: string }>(
        `SELECT id FROM papers WHERE rowid IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)`,
      )
      .get('entanglement');
    expect(hit?.id).toBe('1');
    expect(
      handle.prepare('SELECT owner, generation, expires_at FROM mirror_sync_lease').all(),
    ).toEqual([{ owner: null, generation: 0, expires_at: null }]);
    // Idempotent on every open: a second run leaves the one row as it is.
    expect(() => handle.exec(buildSchemaSql(baseSpec))).not.toThrow();
    expect(handle.prepare('SELECT COUNT(*) AS n FROM mirror_sync_lease').get()).toEqual({ n: 1 });
    handle.close();
  });

  it('creates every table from buildSchemaDdl and leaves both singleton tables empty', async () => {
    const handle = await openSqliteHandle(join(dir, 'ddl.db'));
    try {
      handle.exec(buildSchemaDdl(baseSpec));
      expect(
        handle
          .prepare<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'papers_fts_%' ORDER BY name`,
          )
          .all()
          .map((r) => r.name),
      ).toEqual([
        'mirror_sync_lease',
        'mirror_sync_state',
        'papers',
        'papers_fts',
        'schema_version',
      ]);
      expect(handle.prepare('SELECT COUNT(*) AS n FROM mirror_sync_state').get()).toEqual({ n: 0 });
      expect(handle.prepare('SELECT COUNT(*) AS n FROM mirror_sync_lease').get()).toEqual({ n: 0 });
    } finally {
      handle.close();
    }
  });

  it("runs buildSchemaDdl on an initialized store under another connection's write lock, where buildSchemaSql's seeds wait for it", async () => {
    const path = join(dir, 'held.db');
    const setup = await openSqliteHandle(path);
    setup.exec(buildSchemaSql(baseSpec));
    setup.close();

    // Fails at once rather than waiting on a lock.
    const opener = await openSqliteHandle(path, { busyTimeoutMs: 0 });
    const holder = await openSqliteHandle(path);
    try {
      holder.exec('BEGIN IMMEDIATE');
      holder.prepare(`INSERT INTO papers(id) VALUES ('held')`).run();
      expect(() => opener.exec(buildSchemaDdl(baseSpec))).not.toThrow();
      expect(() => opener.exec(buildSchemaSql(baseSpec))).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^SQLITE_BUSY/) }),
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
      opener.close();
    }
  });

  it('creates the sync state row with the mode column last, where adding it to an older store puts it', async () => {
    const handle = await openSqliteHandle(join(dir, 'state.db'));
    try {
      handle.exec(buildSchemaSql(baseSpec));
      expect(
        handle
          .prepare<{ name: string; type: string }>(`PRAGMA table_info(mirror_sync_state)`)
          .all()
          .map(({ name, type }) => `${name} ${type}`),
      ).toEqual([
        'id INTEGER',
        'status TEXT',
        'cursor TEXT',
        'checkpoint TEXT',
        'started_at TEXT',
        'completed_at TEXT',
        'total INTEGER',
        'error TEXT',
        'mode TEXT',
      ]);
      expect(handle.prepare('SELECT status, mode FROM mirror_sync_state').all()).toEqual([
        { status: 'pending', mode: null },
      ]);
    } finally {
      handle.close();
    }
  });
});
