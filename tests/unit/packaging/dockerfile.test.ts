/**
 * @fileoverview Production Docker install invariants for the framework and
 * scaffold template. Optional peers must stay omitted after both dependency
 * installation steps; the later OTEL step otherwise re-resolves them. The
 * production stage sees `bunfig.toml`, so its installs pass the same release-age
 * gate and security scanner as a local install, and the OTEL step installs each
 * package at the range the framework declares in `peerDependencies` (#475).
 *
 * The two images reach that range differently. A scaffold's OTEL packages are
 * the framework's peers, not its own, so `bun add <name>@<range>` installs them.
 * In the framework image they are the project's own peers, which `bun add`
 * keeps as peers and `--omit=peer` then skips, so the step moves them into
 * `dependencies` and reinstalls (#549).
 * @module tests/unit/packaging/dockerfile.test
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Joins Dockerfile continuation lines so each instruction is one assertable line. */
function instructions(path: string): string[] {
  return readFileSync(path, 'utf8')
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Instructions of the stage named `production`, from its `FROM` to the next `FROM` or EOF. */
function productionStage(path: string): string[] {
  const all = instructions(path);
  const start = all.findIndex((line) => /^FROM\s.+\sAS\s+production$/i.test(line));
  expect(start, `${path} has a production stage`).toBeGreaterThanOrEqual(0);
  const end = all.findIndex((line, i) => i > start && line.startsWith('FROM '));
  return all.slice(start, end === -1 ? undefined : end);
}

/** The production stage's single `OTEL_ENABLED`-gated `RUN` instruction. */
function otelStep(path: string): string {
  const matches = productionStage(path).filter(
    (line) => line.startsWith('RUN ') && line.includes('"$OTEL_ENABLED"'),
  );
  expect(matches).toHaveLength(1);
  return matches[0] ?? '';
}

/** The OTEL step's `bun -e` script and the package names passed to it. */
function otelScript(runLine: string): { names: string[]; script: string } {
  const match = runLine.match(/bun -e '([^']+)'((?:\s+@[\w./-]+)+)/);
  expect(match, 'OTEL step reads its ranges through `bun -e`').not.toBeNull();
  return {
    script: match?.[1] ?? '',
    names: (match?.[2] ?? '').trim().split(/\s+/),
  };
}

/**
 * Runs the OTEL script in a scratch dir holding `manifest` as both the
 * project's `package.json` (read by the framework image) and the installed
 * framework's (read by a scaffold).
 */
function runScript(
  scratch: string,
  script: string,
  names: string[],
  manifest: Record<string, unknown>,
): SpawnSyncReturns<string> {
  const fixture = `${JSON.stringify(manifest, null, 2)}\n`;
  const installed = join(scratch, 'node_modules', '@cyanheads', 'mcp-ts-core');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(scratch, 'package.json'), fixture);
  writeFileSync(join(installed, 'package.json'), fixture);
  return spawnSync('bun', ['-e', script, ...names], { cwd: scratch, encoding: 'utf8' });
}

const PEER_DEPENDENCIES: Record<string, string> = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8'),
).peerDependencies;

/** Every optional peer the OTel instrumentation loads — the set the image installs. */
const OTEL_PEERS = Object.keys(PEER_DEPENDENCIES).filter(
  (name) => name.startsWith('@opentelemetry/') || name === '@hono/otel',
);

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe.each(['Dockerfile', 'templates/Dockerfile'])('%s production stage', (relativePath) => {
  const path = join(ROOT, relativePath);

  it('omits optional peers from the production install and the OTEL step', () => {
    const otel = otelStep(path);
    const productionInstall = productionStage(path).filter(
      (line) => line.includes('bun install --production') && line !== otel,
    );

    expect(productionInstall).toHaveLength(1);
    expect(productionInstall[0]).toContain('--omit=peer');
    expect(productionInstall[0]).toContain('--frozen-lockfile');
    expect(productionInstall[0]).not.toContain('rm -rf');
    expect(otel).toContain('--omit=peer');
  });

  it('copies bunfig.toml before the first bun install', () => {
    const stage = productionStage(path);
    const firstInstall = stage.findIndex(
      (line) => line.startsWith('RUN ') && /\bbun (install|add)\b/.test(line),
    );
    const bunfigCopy = stage.findIndex(
      (line) =>
        line.startsWith('COPY ') && !line.includes('--from=') && /\bbunfig\.toml\b/.test(line),
    );

    expect(firstInstall).toBeGreaterThan(0);
    expect(bunfigCopy).toBeGreaterThan(0);
    expect(bunfigCopy).toBeLessThan(firstInstall);
  });

  it('seeds the bunfig.toml security scanner from the build stage before the first install', () => {
    // A production-filtered install cannot install the devDependency scanner itself and aborts.
    const bunfig = readFileSync(
      join(ROOT, relativePath === 'Dockerfile' ? 'bunfig.toml' : 'templates/_bunfig.toml'),
      'utf8',
    );
    const scanner = bunfig.match(/^scanner\s*=\s*"([^"]+)"/m)?.[1];
    expect(scanner).toBeDefined();

    const stage = productionStage(path);
    const firstInstall = stage.findIndex(
      (line) => line.startsWith('RUN ') && /\bbun (install|add)\b/.test(line),
    );
    const seed = stage.indexOf(
      `COPY --from=build /usr/src/app/node_modules/${scanner} ./node_modules/${scanner}`,
    );

    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(firstInstall);
  });

  it('names every OpenTelemetry optional peer the framework declares', () => {
    const { names } = otelScript(otelStep(path));

    expect(OTEL_PEERS).toEqual(
      expect.arrayContaining([
        '@opentelemetry/sdk-logs',
        '@opentelemetry/exporter-logs-otlp-http',
        '@opentelemetry/api-logs',
      ]),
    );
    expect([...names].sort()).toEqual([...OTEL_PEERS].sort());
  });

  it('fails the build when a named package has no declared peer range', () => {
    const { names, script } = otelScript(otelStep(path));
    const manifest = { name: '@cyanheads/mcp-ts-core', dependencies: {}, peerDependencies: {} };

    scratch = mkdtempSync(join(tmpdir(), 'dockerfile-otel-'));
    const result = runScript(scratch, script, names, manifest);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(names[0]);
    expect(JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'))).toEqual(manifest);
  });

  it('sets no environment variable the framework never reads', () => {
    expect(readFileSync(path, 'utf8')).not.toContain('MCP_FORCE_CONSOLE_LOGGING');
  });
});

describe('templates/Dockerfile OTEL step', () => {
  const path = join(ROOT, 'templates/Dockerfile');

  it('passes each package to bun add as <name>@<range> from the installed framework', () => {
    const otel = otelStep(path);
    const { names, script } = otelScript(otel);

    expect(otel).toMatch(/specs=\$\(bun -e '/);
    expect(otel).toMatch(/&& bun add --omit=dev --omit=peer --ignore-scripts \$specs;/);

    // Distinct from the real ranges, so the output can only come from the file the script reads.
    const peers = Object.fromEntries(names.map((name, i) => [name, `^9.${i}.0`]));
    scratch = mkdtempSync(join(tmpdir(), 'dockerfile-otel-'));
    const result = runScript(scratch, script, names, {
      name: '@cyanheads/mcp-ts-core',
      peerDependencies: peers,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\s+/)).toEqual(names.map((name, i) => `${name}@^9.${i}.0`));
  });
});

describe('Dockerfile OTEL step (#549)', () => {
  const path = join(ROOT, 'Dockerfile');

  it('reinstalls with --omit=peer after the manifest rewrite, without the frozen lockfile', () => {
    const otel = otelStep(path);

    expect(otel).not.toContain('bun add');
    expect(otel).toMatch(/&& bun install --production --omit=peer --ignore-scripts;/);
    expect(otel).not.toContain('--frozen-lockfile');
  });

  it('moves the named peers into dependencies at their peer range and leaves other peers', () => {
    const { names, script } = otelScript(otelStep(path));

    // Peer and dev ranges differ, so the result shows which one the rewrite took.
    const peers = Object.fromEntries(names.map((name, i) => [name, `^9.${i}.0`]));
    const devs = Object.fromEntries(names.map((name) => [name, '^8.0.0']));
    const optional = Object.fromEntries(names.map((name) => [name, { optional: true }]));
    scratch = mkdtempSync(join(tmpdir(), 'dockerfile-otel-'));
    const result = runScript(scratch, script, names, {
      name: '@cyanheads/mcp-ts-core',
      dependencies: { '@opentelemetry/api': '^1.9.1' },
      devDependencies: { ...devs, vitest: '^4.1.11' },
      peerDependencies: { ...peers, vitest: '^4.1.0', '@duckdb/node-api': '^1.5.5' },
      peerDependenciesMeta: { ...optional, vitest: { optional: true } },
    });

    expect(result.status, result.stderr).toBe(0);
    const rewritten = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
    expect(rewritten.dependencies).toEqual({ '@opentelemetry/api': '^1.9.1', ...peers });
    expect(rewritten.devDependencies).toEqual({ vitest: '^4.1.11' });
    expect(rewritten.peerDependencies).toEqual({ vitest: '^4.1.0', '@duckdb/node-api': '^1.5.5' });
    expect(rewritten.peerDependenciesMeta).toEqual({ vitest: { optional: true } });
  });
});
