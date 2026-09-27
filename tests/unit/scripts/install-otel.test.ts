/**
 * @fileoverview Tests for scripts/install-otel.ts — the Dockerfiles' OTel step
 * (#578). The script runs as a real subprocess against a scratch project, the
 * way a Dockerfile runs it, with a recording `bun` first on `PATH` standing in
 * for the one external boundary: the `bun install` it hands the rewritten
 * manifest to. Resolution, filtering, and the manifest rewrite are all real.
 * @module tests/unit/scripts/install-otel.test
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { otelPeers } from '../../../scripts/install-otel.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'install-otel.ts');

type Manifest = Record<string, unknown> & {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
};

const ROOT_MANIFEST: Manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The installed-framework manifest a scaffold resolves: OTel peers beside other optional peers. */
const FRAMEWORK: Manifest = {
  name: '@cyanheads/mcp-ts-core',
  version: '9.9.9',
  exports: { '.': './dist/core/index.js', './package.json': './package.json' },
  peerDependencies: {
    '@duckdb/node-api': '^1.5.5',
    '@hono/otel': '^9.0.0',
    '@opentelemetry/api-logs': '^9.1.0',
    '@opentelemetry/sdk-node': '^9.2.0',
    openai: '^7.0.0',
    vitest: '>=4.0.0',
  },
  peerDependenciesMeta: {
    '@duckdb/node-api': { optional: true },
    '@hono/otel': { optional: true },
    openai: { optional: true },
  },
};

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A scratch project holding `manifest` as its package.json, plus `framework` installed when given. */
function project(manifest: Manifest, framework?: Manifest): string {
  scratch = mkdtempSync(join(tmpdir(), 'install-otel-'));
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (framework) {
    const installed = join(scratch, 'node_modules', '@cyanheads', 'mcp-ts-core');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), `${JSON.stringify(framework, null, 2)}\n`);
  }
  return scratch;
}

interface Run {
  /** One entry per `bun` invocation: its cwd, then each argument. */
  bunCalls: string[][];
  status: number | null;
  stderr: string;
  stdout: string;
}

/** Runs the script in `dir` with `args`; the `bun` it spawns records its call and exits `bunExit`. */
function run(dir: string, args: string[] = [], bunExit = 0): Run {
  const bin = join(dir, '.bin');
  const log = join(dir, '.bun-calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'bun'),
    `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; printf '\\036\\n'; } >> '${log}'\nexit ${bunExit}\n`,
  );
  chmodSync(join(bin, 'bun'), 0o755);

  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  let calls = '';
  try {
    calls = readFileSync(log, 'utf8');
  } catch {
    // No call recorded.
  }
  return {
    bunCalls: calls
      .split('\u001e\n')
      .filter(Boolean)
      .map((call) => call.trimEnd().split('\n')),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

describe('install-otel', () => {
  it('derives exactly the optional peers src/ loads at runtime from the framework manifest', () => {
    const loaded = [
      'src/utils/telemetry/instrumentation.ts',
      'src/mcp-server/transports/http/httpTransport.ts',
    ].flatMap((file) =>
      [...readFileSync(join(ROOT, file), 'utf8').matchAll(/\bimport\(\s*'(@[^']+)'\s*\)/g)]
        .map((match) => match[1] ?? '')
        .filter((name) => name.startsWith('@opentelemetry/') || name === '@hono/otel'),
    );

    const derived = otelPeers(ROOT_MANIFEST);

    expect(loaded).toEqual(expect.arrayContaining(['@hono/otel', '@opentelemetry/sdk-logs']));
    expect(Object.keys(derived).sort()).toEqual([...new Set(loaded)].sort());
    for (const [name, range] of Object.entries(derived)) {
      expect(range).toBe(ROOT_MANIFEST.peerDependencies?.[name]);
    }
  });

  it('moves the installed framework OTel peers into a server manifest and installs them', () => {
    const server: Manifest = {
      name: 'demo-mcp-server',
      version: '0.1.0',
      dependencies: { '@cyanheads/mcp-ts-core': '^9.9.9', zod: '^4.6.5' },
      devDependencies: { '@opentelemetry/sdk-node': '^8.0.0', typescript: '^7.0.2' },
    };
    const dir = project(server, FRAMEWORK);

    const result = run(dir, ['--os=linux', '--cpu=x64']);

    expect(result.status, result.stderr).toBe(0);
    expect(readManifest(dir)).toEqual({
      ...server,
      dependencies: {
        ...server.dependencies,
        '@hono/otel': '^9.0.0',
        '@opentelemetry/api-logs': '^9.1.0',
        '@opentelemetry/sdk-node': '^9.2.0',
      },
      devDependencies: { typescript: '^7.0.2' },
    });
    expect(result.bunCalls).toEqual([
      [
        realpathSync(dir),
        'install',
        '--omit=dev',
        '--omit=peer',
        '--ignore-scripts',
        '--os=linux',
        '--cpu=x64',
      ],
    ]);
    expect(result.stdout).toContain('3 OpenTelemetry packages');
  });

  it('moves the framework manifest own OTel peers into dependencies and touches nothing else', () => {
    const dir = project(ROOT_MANIFEST);

    const result = run(dir, ['--os=linux', '--cpu=arm64']);

    expect(result.status, result.stderr).toBe(0);
    const peers = otelPeers(ROOT_MANIFEST);
    const names = Object.keys(peers);
    expect(names.length).toBeGreaterThan(0);
    const without = (entries: Record<string, unknown> | undefined) =>
      Object.fromEntries(Object.entries(entries ?? {}).filter(([name]) => !names.includes(name)));
    expect(readManifest(dir)).toEqual({
      ...ROOT_MANIFEST,
      dependencies: { ...ROOT_MANIFEST.dependencies, ...peers },
      devDependencies: without(ROOT_MANIFEST.devDependencies),
      peerDependencies: without(ROOT_MANIFEST.peerDependencies),
      peerDependenciesMeta: without(ROOT_MANIFEST.peerDependenciesMeta),
    });
    // The other optional peers stay peers, so `--omit=peer` keeps them out of the image.
    for (const name of ['vitest', 'openai', '@duckdb/node-api', 'better-sqlite3']) {
      expect(readManifest(dir).peerDependencies).toHaveProperty([name]);
      expect(readManifest(dir).dependencies).not.toHaveProperty([name]);
    }
    expect(result.bunCalls).toHaveLength(1);
  });

  it('exits non-zero before writing or installing when the framework declares no OTel peer', () => {
    const server: Manifest = { name: 'demo-mcp-server', dependencies: { zod: '^4.6.5' } };
    const dir = project(server, { ...FRAMEWORK, peerDependencies: { vitest: '>=4.0.0' } });
    const before = readFileSync(join(dir, 'package.json'), 'utf8');

    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      join(dir, 'node_modules', '@cyanheads', 'mcp-ts-core', 'package.json'),
    );
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(result.bunCalls).toEqual([]);
  });

  it('forwards every argument unchanged and exits with the install exit code', () => {
    const dir = project({ name: 'demo-mcp-server' }, FRAMEWORK);
    const args = ['--os=linux', '--cpu=arm64', '--cache-dir=/tmp/a b', '--verbose'];

    const result = run(dir, args, 7);

    expect(result.status).toBe(7);
    expect(result.bunCalls[0]?.slice(-args.length)).toEqual(args);
  });
});
