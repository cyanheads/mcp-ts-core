/**
 * @fileoverview The scripts the package publishes (`package.json` `files`) are
 * copied into every server by `init` and the maintenance resync, so none may
 * name a module by a literal path the published package does not contain: a
 * literal specifier enters the typecheck of any server program that reaches
 * the script, and a path that exists only in this repository fails it (#797).
 * `test:package` typechecks every script in a scaffold; this is the fast check.
 * @module tests/unit/scripts/shipped-scripts.test
 */

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const { files } = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
  files: string[];
};
const SHIPPED_SCRIPTS = files.filter(
  (entry) => entry.startsWith('scripts/') && entry.endsWith('.ts'),
);

/**
 * A literal relative module specifier: a static import or re-export, an
 * `import()` call, or an `import()` type query. TypeScript also resolves an
 * `import()` argument written as a template literal without substitutions.
 */
const RELATIVE_SPECIFIER =
  /\b(?:from|import)\s*\(?\s*(?:(['"])(\.{1,2}\/[^'"]+)\1|`(\.{1,2}\/[^`$]+)`)/g;

/** The literal relative module specifiers in `source`. */
function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(RELATIVE_SPECIFIER)].flatMap(
    ([, , quoted, template]) => quoted ?? template ?? [],
  );
}

/** Whether the package publishes `path` — a `files` entry names it or a directory holding it. */
function published(path: string): boolean {
  const candidates = [path, path.replace(/\.js$/, '.ts')];
  return files.some((entry) =>
    candidates.some((candidate) =>
      entry.endsWith('/') ? candidate.startsWith(entry) : candidate === entry,
    ),
  );
}

describe('shipped scripts (#797)', () => {
  it('lists the scripts init copies', () => {
    expect(SHIPPED_SCRIPTS).toContain('scripts/lint-packaging.ts');
    expect(SHIPPED_SCRIPTS).toContain('scripts/lint-mcp.ts');
  });

  it.each([
    "import { a } from '../src/a.js';",
    'export * from "../src/a.js";',
    "const m = await import('../src/a.js');",
    'const m = await import(`../src/a.js`);',
    "type A = typeof import('../src/a.js');",
  ])('reads the specifier in %s', (line) => {
    expect(relativeSpecifiers(line)).toEqual(['../src/a.js']);
  });

  it.each(SHIPPED_SCRIPTS)('%s names no module outside the published package', (script) => {
    const source = readFileSync(new URL(script, ROOT), 'utf8');
    const outside = relativeSpecifiers(source)
      .map((specifier) => posix.join(posix.dirname(script), specifier))
      .filter((target) => !published(target));
    expect(outside).toEqual([]);
  });
});
