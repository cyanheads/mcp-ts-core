/**
 * @fileoverview Structural test: verifies optional peer dependencies are never
 * eagerly imported (value imports) in source files. Only `import type` and
 * dynamic `import()` are safe for optional deps — top-level value imports
 * crash with ERR_MODULE_NOT_FOUND when consumers don't install the package.
 *
 * Relies on `verbatimModuleSyntax: true` in tsconfig — TypeScript enforces
 * that type-only imports use `import type`, so any non-`import type` line
 * is guaranteed to be a value import.
 *
 * Also verifies no string in source names a package manager's add command:
 * a missing-peer message tells the reader to declare the package, since the
 * server may be installed with any package manager.
 * @module tests/unit/packaging/optional-peer-deps
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-v6';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

/**
 * Dedicated integration entry modules may eagerly import the one peer they
 * integrate. The subpath export itself is the consumer's opt-in: importing
 * `./testing/vitest` without vitest installed is the documented requirement
 * of that subpath, not an accidental crash. Each entry here must be an
 * exports-map entry point that no other src/ module imports — laziness is
 * impossible for these because the integration value (e.g. `test.extend`)
 * must be produced at module evaluation.
 */
const INTEGRATION_ENTRYPOINTS: Record<string, string> = {
  'src/testing/vitest.ts': 'vitest',
};

/** Reads optional peer dep names from package.json peerDependenciesMeta. */
function getOptionalPeerDeps(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const meta: Record<string, { optional?: boolean }> = pkg.peerDependenciesMeta ?? {};
  return Object.entries(meta)
    .filter(([, v]) => v.optional)
    .map(([k]) => k);
}

/** Recursively yields all .ts source files (excludes .d.ts). */
function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield full;
  }
}

/** Extracts the package name from an import specifier (handles subpaths). */
function extractPackageName(specifier: string): string {
  // Scoped: @scope/pkg/sub → @scope/pkg
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  // Unscoped: pkg/sub → pkg
  return specifier.split('/')[0]!;
}

/** A package manager's command that adds a dependency (`npm i` but not `npm init`). */
const ADD_COMMAND = /\b(?:bun add|npm (?:install|i)|pnpm add|yarn add)\b/;

interface SourceLiteral {
  location: string;
  text: string;
}

/**
 * Every string and template-literal text in a source file. Parsed rather than
 * matched line by line: comments are not syntax nodes, so a JSDoc install note
 * never reaches the scan, and each `${…}`-separated part of a template is read.
 */
function sourceLiterals(file: string): SourceLiteral[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const literals: SourceLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      literals.push({ location: `${relative(ROOT, file)}:${line}`, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

describe('optional peer dependencies', () => {
  it('are never eagerly imported (value imports) in source files', () => {
    const optionalDeps = new Set(getOptionalPeerDeps());
    const violations: string[] = [];

    for (const file of walkTs(SRC)) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();

        // Type-only imports/exports are safe (erased at compile time)
        if (/^(import|export)\s+type\s/.test(line)) continue;

        // Extract the specifier from import/export ... from '...' lines
        const fromMatch = /(?:^import\s|^export\s).*from\s+['"]([^'"]+)['"]/.exec(line);
        // Also catch side-effect imports: import 'pkg'
        const sideEffectMatch = !fromMatch ? /^import\s+['"]([^'"]+)['"]/.exec(line) : null;

        const specifier = fromMatch?.[1] ?? sideEffectMatch?.[1];
        if (!specifier) continue;

        const pkg = extractPackageName(specifier);
        if (optionalDeps.has(pkg)) {
          const rel = relative(ROOT, file);
          if (INTEGRATION_ENTRYPOINTS[rel] === pkg) continue;
          violations.push(`  ${rel}:${i + 1} → ${line}`);
        }
      }
    }

    expect(
      violations,
      [
        'Found value imports of optional peer dependencies.',
        'These crash at runtime when consumers omit the package.',
        'Fix: move to "dependencies", use `import type`, or use dynamic import().\n',
        ...violations,
      ].join('\n'),
    ).toHaveLength(0);
  });

  it('are never named with a package manager command in a source string', () => {
    const literals = [...walkTs(SRC)].flatMap(sourceLiterals);
    // The scan reaches the missing-peer messages themselves, so an empty result means something.
    expect(literals.some(({ text }) => text.includes('needs the optional peer dependenc'))).toBe(
      true,
    );

    const violations = literals
      .filter(({ text }) => ADD_COMMAND.test(text))
      .map(({ location, text }) => `  ${location} → ${text}`);
    expect(
      violations,
      [
        'Found a package manager command in a source string.',
        "A missing-peer message names the package and says to add it to the server's dependencies.\n",
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });
});
