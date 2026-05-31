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
  buildSchemaSql,
  DEFAULT_FTS_TOKENIZER,
  type SchemaSpec,
  validateSchemaSpec,
} from '@/services/mirror/sqlite/schema.js';

const baseSpec: SchemaSpec = {
  table: 'papers',
  primaryKey: 'id',
  columns: { id: 'TEXT', title: 'TEXT', abstract: 'TEXT', updated: 'TEXT' },
  fts: ['title', 'abstract'],
  indexes: [{ columns: ['updated'] }],
};

describe('buildSchemaSql', () => {
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
    handle.close();
  });
});
