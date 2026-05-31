/**
 * @fileoverview DDL generation for the SQLite mirror store. Builds the primary
 * table, secondary indexes, an optional FTS5 external-content index with sync
 * triggers, the single-row `mirror_sync_state` table, and the `schema_version`
 * table — all from a declarative column/FTS spec.
 * @module services/mirror/sqlite/schema
 */

import { configurationError } from '@/types-global/errors.js';

/** Default FTS5 tokenizer — Unicode-aware, diacritic-stripping, no stemming. */
export const DEFAULT_FTS_TOKENIZER = 'unicode61 remove_diacritics 2';

/** Declarative schema spec consumed by {@link buildSchemaSql}. */
export interface SchemaSpec {
  /** Column name → SQLite type/declaration (e.g. `'TEXT'`, `'INTEGER NOT NULL'`). */
  columns: Record<string, string>;
  /** Columns to index in FTS5 (subset of `columns`). Omit/empty to skip FTS. */
  fts?: string[];
  /** FTS5 tokenizer directive. Defaults to {@link DEFAULT_FTS_TOKENIZER}. */
  ftsTokenizer?: string;
  /** Secondary indexes over declared columns. */
  indexes?: Array<{ name?: string; columns: string[] }>;
  /** Primary-key column — receives `PRIMARY KEY NOT NULL` and drives upsert/tombstone. */
  primaryKey: string;
  /** Primary table name. */
  table: string;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, role: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw configurationError(
      `Invalid mirror ${role} identifier "${value}" — must match ${IDENTIFIER_RE.source}.`,
      { value, role },
    );
  }
}

/** Validate a {@link SchemaSpec} and return its FTS column set (validated). */
export function validateSchemaSpec(spec: SchemaSpec): { ftsColumns: string[]; tokenizer: string } {
  assertIdentifier(spec.table, 'table');
  const columnNames = Object.keys(spec.columns);
  if (columnNames.length === 0) {
    throw configurationError('Mirror schema must declare at least one column.', {
      table: spec.table,
    });
  }
  for (const col of columnNames) assertIdentifier(col, 'column');
  if (!(spec.primaryKey in spec.columns)) {
    throw configurationError(
      `Mirror primaryKey "${spec.primaryKey}" is not among the declared columns.`,
      { primaryKey: spec.primaryKey, columns: columnNames },
    );
  }

  const ftsColumns = spec.fts ?? [];
  for (const col of ftsColumns) {
    if (!(col in spec.columns)) {
      throw configurationError(`Mirror FTS column "${col}" is not a declared column.`, {
        column: col,
        columns: columnNames,
      });
    }
  }

  const tokenizer = spec.ftsTokenizer ?? DEFAULT_FTS_TOKENIZER;
  if (tokenizer.includes('"')) {
    throw configurationError('Mirror ftsTokenizer must not contain a double-quote character.', {
      tokenizer,
    });
  }

  for (const idx of spec.indexes ?? []) {
    for (const col of idx.columns) {
      if (!(col in spec.columns)) {
        throw configurationError(`Mirror index column "${col}" is not a declared column.`, {
          column: col,
        });
      }
    }
  }

  return { ftsColumns, tokenizer };
}

/**
 * Build the full idempotent DDL for a mirror store. Safe to run on every open
 * (`CREATE … IF NOT EXISTS` throughout). Returns one SQL string.
 */
export function buildSchemaSql(spec: SchemaSpec): string {
  const { ftsColumns, tokenizer } = validateSchemaSpec(spec);
  const t = spec.table;

  const columnDefs = Object.entries(spec.columns).map(([name, decl]) => {
    const base = `${name} ${decl}`.trim();
    return name === spec.primaryKey ? `${name} ${decl} PRIMARY KEY NOT NULL`.trim() : base;
  });

  const parts: string[] = [
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
    `CREATE TABLE IF NOT EXISTS ${t} (\n  ${columnDefs.join(',\n  ')}\n);`,
  ];

  for (const idx of spec.indexes ?? []) {
    const name = idx.name ?? `${t}_${idx.columns.join('_')}_idx`;
    assertIdentifier(name, 'index');
    parts.push(`CREATE INDEX IF NOT EXISTS ${name} ON ${t}(${idx.columns.join(', ')});`);
  }

  if (ftsColumns.length > 0) {
    parts.push(buildFtsSql(t, ftsColumns, tokenizer));
  }

  parts.push(
    `CREATE TABLE IF NOT EXISTS mirror_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  cursor TEXT,
  checkpoint TEXT,
  started_at TEXT,
  completed_at TEXT,
  total INTEGER,
  error TEXT
);`,
    `INSERT OR IGNORE INTO mirror_sync_state(id, status) VALUES (1, 'pending');`,
  );

  return parts.join('\n\n');
}

/**
 * Build the FTS5 external-content virtual table and its insert/delete/update
 * sync triggers. External content (`content=<table>`) stores only the index, not
 * a copy of the text; the triggers keep it in lock-step with the base table,
 * using the `('delete', …)` command-row form required for external-content
 * deletes.
 */
function buildFtsSql(table: string, ftsColumns: string[], tokenizer: string): string {
  const cols = ftsColumns.join(', ');
  const newCols = ftsColumns.map((c) => `new.${c}`).join(', ');
  const oldCols = ftsColumns.map((c) => `old.${c}`).join(', ');
  const fts = `${table}_fts`;

  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(
  ${ftsColumns.join(',\n  ')},
  content='${table}',
  content_rowid='rowid',
  tokenize="${tokenizer}"
);

CREATE TRIGGER IF NOT EXISTS ${table}_ai AFTER INSERT ON ${table} BEGIN
  INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.rowid, ${newCols});
END;

CREATE TRIGGER IF NOT EXISTS ${table}_ad AFTER DELETE ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldCols});
END;

CREATE TRIGGER IF NOT EXISTS ${table}_au AFTER UPDATE ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.rowid, ${oldCols});
  INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.rowid, ${newCols});
END;`;
}
