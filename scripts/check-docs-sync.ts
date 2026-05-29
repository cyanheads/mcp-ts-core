#!/usr/bin/env node
/**
 * @fileoverview Verifies that CLAUDE.md and AGENTS.md stay in sync. The init CLI
 * ships both files byte-identical and each agent tool reads the file named for
 * it — silent drift after edits leaves one agent on a stale protocol.
 *
 * Checks the project-root pair, plus the framework's `templates/` pair when it
 * exists. The template pair is mcp-ts-core-only — downstream servers have no
 * `templates/` directory, so that pair is silently skipped there.
 *
 * Behavior (per pair):
 *   • Both exist, identical   → pass
 *   • Both exist, drift       → fail, print first divergent lines + fix hint
 *   • Only one exists         → pass (report which file is present)
 *   • Neither exists          → skip (pair not present)
 *
 * Runs as a devcheck step and standalone: `bun run scripts/check-docs-sync.ts`.
 *
 * @module scripts/check-docs-sync
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const MAX_DIFF_LINES = 20;

/**
 * Line-by-line drift summary. Not a true unified diff — tools that move lines
 * will show every shifted line as divergent, which is fine for the enforcement
 * use case (the fix is always "reconcile both files" regardless).
 */
function summarizeDrift(a: string, b: string, aLabel: string, bLabel: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const lines: string[] = [];
  let drifts = 0;

  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      drifts++;
      if (drifts <= MAX_DIFF_LINES) {
        const lineNo = String(i + 1).padStart(4);
        if (aLines[i] !== undefined) lines.push(`${lineNo}  - ${aLabel}: ${aLines[i]}`);
        if (bLines[i] !== undefined) lines.push(`${lineNo}  + ${bLabel}: ${bLines[i]}`);
      }
    }
  }

  if (drifts > MAX_DIFF_LINES) {
    lines.push(`      ... and ${drifts - MAX_DIFF_LINES} more diverging line(s)`);
  }
  return lines.join('\n');
}

/**
 * Compare one CLAUDE.md/AGENTS.md pair. `prefix` labels and locates the pair
 * ('' for the project root, 'templates/' for the framework template pair).
 * Returns true when in sync or absent, false on drift.
 */
function checkPair(prefix: string): boolean {
  const claudeLabel = `${prefix}CLAUDE.md`;
  const agentsLabel = `${prefix}AGENTS.md`;
  const claudePath = resolve(claudeLabel);
  const agentsPath = resolve(agentsLabel);
  const hasClaude = existsSync(claudePath);
  const hasAgents = existsSync(agentsPath);

  if (!hasClaude && !hasAgents) {
    return true; // pair absent — nothing to check (e.g. templates/ in a downstream server)
  }

  if (hasClaude !== hasAgents) {
    const present = hasClaude ? claudeLabel : agentsLabel;
    const absent = hasClaude ? agentsLabel : claudeLabel;
    console.log(`${present} found. No ${absent} found — nothing to sync.`);
    return true;
  }

  const claude = readFileSync(claudePath, 'utf-8');
  const agents = readFileSync(agentsPath, 'utf-8');

  if (claude === agents) {
    console.log(`${claudeLabel} and ${agentsLabel} are in sync.`);
    return true;
  }

  console.error(`${claudeLabel} and ${agentsLabel} have drifted:`);
  console.error('');
  console.error(summarizeDrift(claude, agents, claudeLabel, agentsLabel));
  console.error('');
  console.error(
    `Fix: edit both files together, or \`cp ${claudeLabel} ${agentsLabel}\` (or reverse) if one is canonical.`,
  );
  return false;
}

// Root pair runs in every mcp-ts-core project (framework + scaffolded servers).
// The templates/ pair is framework-only and self-skips where the dir is absent.
const ok = [checkPair(''), checkPair('templates/')].every(Boolean);

process.exit(ok ? 0 : 1);
