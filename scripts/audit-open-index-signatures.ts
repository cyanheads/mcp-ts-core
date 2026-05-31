#!/usr/bin/env node
/**
 * @fileoverview Enforces the "open indexed named interface" antipattern across
 * framework source: an interface (or type-literal alias) that mixes explicit
 * named members with an open `[key: string]: unknown` / `[key: string]: any`
 * index signature. The combination silently converts "field is missing" bugs
 * into "field is undefined" bugs — the type system can't flag access to a field
 * the index signature already permits. See #121 (`ctx.auth.token` strip), where
 * `AuthContext`'s index signature let a dropped field compile cleanly and pass
 * `createMockContext({ auth: { token } })` unit tests.
 *
 * Deliberate extensibility bags opt out with a comment on the index signature —
 * either on the line directly above it (after any JSDoc) or trailing it:
 *
 *   // allow open-indexed-named: <rationale>
 *   [key: string]: unknown;
 *
 * Any offender lacking the opt-out fails the check (exit 1). A passing baseline of
 * annotated offenders lets the rule fail-closed on new, possibly-unintentional ones.
 *
 * Framework-only: NOT listed in `package.json` `files:`, so the devcheck step guards
 * on the script's presence and skips cleanly in consumer projects. The pattern is
 * common and legitimate in consumer code (extensibility bags) — enforcing it there
 * would be noise, not signal. Kept separate from `check-framework-antipatterns.ts`
 * because that check is `git grep`-based and this one needs the AST.
 *
 * Runs standalone (`bun run scripts/audit-open-index-signatures.ts`) and as a
 * devcheck step.
 *
 * @module scripts/audit-open-index-signatures
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import * as ts from 'typescript';

const OPT_OUT_MARKER = 'allow open-indexed-named';

interface Finding {
  file: string;
  indexValue: 'unknown' | 'any';
  line: number;
  namedMembers: string[];
  optedOut: boolean;
  typeName: string;
}

/** Tracked, non-test `.ts` files under `src/` (empty when not a git repo). */
function listSourceFiles(): string[] {
  const result = spawnSync('git', ['ls-files', 'src'], { encoding: 'utf-8' });
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts'));
}

function indexValue(node: ts.IndexSignatureDeclaration): 'unknown' | 'any' | null {
  const t = node.type;
  if (!t) return null;
  if (t.kind === ts.SyntaxKind.UnknownKeyword) return 'unknown';
  if (t.kind === ts.SyntaxKind.AnyKeyword) return 'any';
  return null;
}

/** True when an opt-out comment leads or trails the index signature. */
function hasOptOut(text: string, node: ts.IndexSignatureDeclaration): boolean {
  const ranges = [
    ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
  ];
  return ranges.some((r) => text.slice(r.pos, r.end).includes(OPT_OUT_MARKER));
}

function audit(file: string): Finding[] {
  const text = readFileSync(file, 'utf-8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    let members: readonly ts.TypeElement[] | undefined;
    let typeName: string | undefined;

    if (ts.isInterfaceDeclaration(node)) {
      members = node.members;
      typeName = node.name.text;
    } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      members = node.type.members;
      typeName = node.name.text;
    }

    if (members && typeName) {
      const named = members
        .filter(ts.isPropertySignature)
        .map((m) => (ts.isIdentifier(m.name) ? m.name.text : m.name.getText()));
      if (named.length > 0) {
        for (const m of members) {
          if (!ts.isIndexSignatureDeclaration(m)) continue;
          const value = indexValue(m);
          if (!value) continue;
          const { line } = source.getLineAndCharacterOfPosition(m.getStart());
          findings.push({
            file,
            line: line + 1,
            typeName,
            namedMembers: named,
            indexValue: value,
            optedOut: hasOptOut(text, m),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return findings;
}

const files = listSourceFiles();
const findings = files.flatMap(audit);
const violations = findings.filter((f) => !f.optedOut);
const optedOut = findings.length - violations.length;

if (violations.length === 0) {
  const suffix = optedOut > 0 ? ` (${optedOut} opted out)` : '';
  console.log(
    `No un-annotated open-indexed-named interfaces in src/ (${files.length} file(s) scanned)${suffix}.`,
  );
  process.exit(0);
}

console.error(
  `Found ${violations.length} open-indexed-named interface(s) without an opt-out in src/:\n`,
);
for (const f of violations) {
  console.error(`  ${f.file}:${f.line}  ${f.typeName}`);
  console.error(`    named: ${f.namedMembers.join(', ')}`);
  console.error(`    index: [key: string]: ${f.indexValue}\n`);
}
console.error(
  `Annotate intentional bags with '// ${OPT_OUT_MARKER}: <rationale>' above the index\n` +
    'signature, or replace the index signature with explicit named fields. See issue #123.',
);
process.exit(1);
