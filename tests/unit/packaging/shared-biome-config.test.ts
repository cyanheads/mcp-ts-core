/**
 * @fileoverview Structural test for the shipped `biome.json`, which consumers
 * extend as `@cyanheads/mcp-ts-core/biome` from inside `node_modules` where
 * `biome migrate` can't reach it (#771). A versioned `$schema` URL drifts from
 * every Biome minor in the peer range and draws a schema-mismatch diagnostic
 * on each check; the schema bundled with the installed CLI never does.
 * Markdown stays out of scope because Biome 2.6+ formats it, and test fixtures
 * are byte-exact data. A `markdown` config key can't do this instead: Biome
 * 2.5 rejects keys it doesn't know.
 * @module tests/unit/packaging/shared-biome-config.test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const config = JSON.parse(readFileSync(join(ROOT, 'biome.json'), 'utf8')) as {
  $schema: string;
  files: { includes: string[] };
};

describe('shared biome.json', () => {
  it('takes its schema from the installed Biome CLI, naming no version', () => {
    expect(config.$schema).toBe('./node_modules/@biomejs/biome/configuration_schema.json');
  });

  it('leaves Markdown out of the files Biome formats and lints', () => {
    expect(config.files.includes).toContain('!**/*.md');
  });
});
