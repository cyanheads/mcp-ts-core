#!/usr/bin/env bun
/**
 * @fileoverview Hermetic verification of the npm package consumers receive.
 * Builds are checked for freshness, packed as an npm-compatible tarball,
 * installed into an isolated production-only consumer, and exercised through
 * runtime imports, public declarations, and the published CLI bin.
 * @module scripts/verify-package
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INPUT_PATHS } from './build-inputs.js';
import { PUBLIC_RUNTIME_EXPORTS, type PublicRuntimeSubpath } from './public-api-contract.js';

type ConditionalExport = {
  default?: string;
  import?: string;
  types?: string;
};

type PackageJson = {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports: Record<string, ConditionalExport | string>;
  files: string[];
  name: string;
  peerDependencies?: Record<string, string>;
  version: string;
};

type RunResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

/** Summary of a successful package verification run. */
export type PackageVerificationReport = {
  /** Absolute path to the project the installed CLI bin scaffolded. */
  cliProject: string;
  /** Number of entries listed in the packed tarball. */
  packEntries: number;
  /** Public specifiers exercised through runtime imports, sorted. */
  runtimeSubpaths: string[];
  /** Absolute path to the packed tarball. */
  tarball: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_INPUTS = BUILD_INPUT_PATHS.map((path) => join(ROOT, path));

const CONSUMER_SUPPORT_PACKAGES = [
  '@opentelemetry/sdk-node',
  '@supabase/supabase-js',
  '@types/node',
  '@types/papaparse',
  '@types/sanitize-html',
  'chrono-node',
  'fast-check',
  'node-cron',
  'openai',
  'papaparse',
  'pdf-lib',
  'sanitize-html',
  'typescript',
  'typescript-v6',
  'vitest',
] as const;

/**
 * The Worker consumer installs separately, and deliberately declares no
 * `@types/node`. `undici-types` is hoisted as a dependency of that package and
 * six of its declaration files carry `/// <reference types="node" />`, so any
 * program that resolves openai's relative `undici-types` probe pulls Node's
 * globals in — which collide with `@cloudflare/workers-types` on `Buffer`,
 * `console`, and friends. Without the package installed the probe resolves to
 * nothing behind openai's own suppression comment, which is what lets this lane
 * run `skipLibCheck: false` and actually check `dist/core/worker.d.ts` (#411).
 */
const WORKER_CONSUMER_PACKAGES = [
  '@cloudflare/workers-types',
  'openai',
  'typescript',
  'typescript-v6',
] as const;

/**
 * Wall-clock ceiling for every child process this verifier spawns. The slowest
 * step (a cold `bun install` of the consumer support packages) runs well under
 * this, so exceeding it means the child is wedged rather than slow.
 */
const CHILD_TIMEOUT_MS = 300_000;

/**
 * Identity of the throwaway project the tarball is installed into. Deliberately
 * unlike the framework's own name and version so a consumer-anchored config
 * value is distinguishable from a framework-anchored one.
 */
const PACKED_CONSUMER_NAME = 'mcp-ts-core-packed-consumer';
const PACKED_CONSUMER_VERSION = '0.0.0-packed-consumer';

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...env, NODE_PATH: '', NO_COLOR: '1' },
        killSignal: 'SIGKILL',
        maxBuffer: 20 * 1024 * 1024,
        timeout: CHILD_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        if (failure?.killed && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          rejectResult(
            new Error(
              `Timed out after ${CHILD_TIMEOUT_MS / 1000}s and killed with SIGKILL: ${command} ${args.join(' ')} (cwd: ${cwd})`,
            ),
          );
          return;
        }
        resolveResult({
          exitCode: error ? Number(error.code) || 1 : 0,
          stderr: String(stderr ?? ''),
          stdout: String(stdout ?? ''),
        });
      },
    );
  });
}

function assertSuccess(result: RunResult, label: string): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${label} failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`,
  );
}

async function findCommand(name: 'bun' | 'node' | 'npm'): Promise<string> {
  const result = await run('which', ['-a', name], ROOT);
  assertSuccess(result, `locating ${name}`);
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selected =
    name === 'node' ? candidates.find((entry) => !entry.includes('/bun-node-')) : candidates[0];
  if (!selected) throw new Error(`Unable to locate a real ${name} executable.`);
  return selected;
}

async function newestMtimeMs(path: string): Promise<number> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) return metadata.mtimeMs;

  const children = await readdir(path, { withFileTypes: true });
  const childTimes = await Promise.all(
    children.map((entry) => newestMtimeMs(join(path, entry.name))),
  );
  return Math.max(metadata.mtimeMs, ...childTimes);
}

function runtimeSubpaths(pkg: PackageJson): string[] {
  return Object.entries(pkg.exports)
    .filter((entry): entry is [string, ConditionalExport] => typeof entry[1] === 'object')
    .filter(([, entry]) => typeof entry.import === 'string' || typeof entry.default === 'string')
    .map(([subpath]) => (subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`))
    .sort();
}

function publicSpecifier(pkg: PackageJson, subpath: string): string {
  return subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
}

function assertRuntimeSubpathContract(pkg: PackageJson): void {
  const declared = Object.entries(pkg.exports)
    .filter((entry): entry is [string, ConditionalExport] => typeof entry[1] === 'object')
    .filter(([, entry]) => typeof entry.import === 'string' || typeof entry.default === 'string')
    .map(([subpath]) => subpath)
    .sort();
  const expected = Object.keys(PUBLIC_RUNTIME_EXPORTS).sort();
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    throw new Error(
      `Runtime subpaths differ from the explicit public contract.\nDeclared: ${declared.join(', ')}\nExpected: ${expected.join(', ')}`,
    );
  }
}

function requiredBuildArtifacts(pkg: PackageJson): string[] {
  const artifacts = new Set<string>();
  for (const entry of Object.values(pkg.exports)) {
    if (typeof entry === 'string') continue;
    for (const target of [entry.import, entry.default, entry.types]) {
      if (target?.startsWith('./dist/')) artifacts.add(target.slice(2));
    }
  }
  for (const target of Object.values(pkg.bin ?? {})) {
    if (target.startsWith('dist/')) artifacts.add(target);
  }
  return [...artifacts].sort();
}

async function assertBuildFresh(pkg: PackageJson): Promise<void> {
  const newestInput = Math.max(...(await Promise.all(BUILD_INPUTS.map(newestMtimeMs))));
  for (const artifact of requiredBuildArtifacts(pkg)) {
    const artifactPath = join(ROOT, artifact);
    let artifactMtime: number;
    try {
      artifactMtime = (await stat(artifactPath)).mtimeMs;
    } catch {
      throw new Error(`Required package artifact is missing: ${artifact}. Run "bun run rebuild".`);
    }
    if (artifactMtime < newestInput) {
      throw new Error(`Required package artifact is stale: ${artifact}. Run "bun run rebuild".`);
    }
  }
}

function tarPath(packagePath: string): string {
  return `package/${packagePath.replace(/^\.\//, '').replace(/\/$/, '')}`;
}

function assertPacklist(pkg: PackageJson, entries: string[]): void {
  const packed = new Set(entries.map((entry) => entry.replace(/\/$/, '')));
  const required = new Set(['package/package.json']);

  for (const entry of Object.values(pkg.exports)) {
    if (typeof entry === 'string') {
      required.add(tarPath(entry));
      continue;
    }
    for (const target of [entry.import, entry.default, entry.types]) {
      if (target) required.add(tarPath(target));
    }
  }
  for (const target of Object.values(pkg.bin ?? {})) required.add(tarPath(target));

  for (const path of required) {
    if (!packed.has(path)) throw new Error(`Package tarball omitted required path: ${path}`);
  }

  for (const declared of pkg.files) {
    const path = tarPath(declared);
    const present = declared.endsWith('/')
      ? [...packed].some((entry) => entry.startsWith(`${path}/`))
      : packed.has(path);
    if (!present)
      throw new Error(`package.json files entry matched nothing in the tarball: ${declared}`);
  }

  for (const forbidden of ['package/node_modules', 'package/src', 'package/tests']) {
    if ([...packed].some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) {
      throw new Error(`Package tarball included forbidden repository content: ${forbidden}`);
    }
  }
}

/**
 * Publishing runs `bun publish`, which packs with Bun's own packer; this
 * verifier packs with npm for install fidelity. The two disagree — Bun skips a
 * path it reads as its own configuration, which is how `templates/bunfig.toml`
 * shipped to every checkout but never to the registry — so the npm listing
 * alone cannot prove what consumers receive. Compare both listings and name any
 * path only npm would ship.
 */
async function assertPackerParity(bunBin: string, npmEntries: string[]): Promise<void> {
  const bunPacked = await run(bunBin, ['pm', 'pack', '--dry-run', '--ignore-scripts'], ROOT);
  assertSuccess(bunPacked, 'bun pm pack --dry-run');

  const listed = new Set(
    `${bunPacked.stdout}\n${bunPacked.stderr}`
      .split(/\r?\n/)
      .map((line) => /^packed\s+\S+\s+(.+)$/.exec(line.trim())?.[1])
      .filter((path): path is string => Boolean(path)),
  );
  if (listed.size === 0) {
    throw new Error('bun pm pack --dry-run produced no file listing to compare against npm pack.');
  }

  const missing = npmEntries
    .filter((entry) => entry.startsWith('package/') && !entry.endsWith('/'))
    .map((entry) => entry.slice('package/'.length))
    .filter((path) => !listed.has(path))
    .sort();

  if (missing.length > 0) {
    throw new Error(
      `bun publish would omit ${missing.length} path(s) that npm pack ships: ${missing.join(', ')}. ` +
        'Bun skips paths it treats as its own configuration — rename the file (an `_` prefix is stripped by `init`) ' +
        'so the published tarball carries it.',
    );
  }
}

function dependencyVersion(pkg: PackageJson, name: string): string {
  const version =
    pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name] ?? pkg.devDependencies?.[name];
  if (!version) throw new Error(`Package verifier has no declared version for ${name}.`);
  return version;
}

function runtimeImportSource(pkg: PackageJson, subpaths: PublicRuntimeSubpath[]): string {
  const contracts = Object.fromEntries(
    subpaths.map((subpath) => [publicSpecifier(pkg, subpath), PUBLIC_RUNTIME_EXPORTS[subpath]]),
  );
  return `
const contracts = ${JSON.stringify(contracts)};
const packageRoot = new URL('./node_modules/@cyanheads/mcp-ts-core/', import.meta.url).href;
const loaded = [];
for (const [specifier, expected] of Object.entries(contracts)) {
  const resolved = import.meta.resolve(specifier);
  if (!resolved.startsWith(packageRoot)) {
    throw new Error(\`\${specifier} resolved outside the installed tarball: \${resolved}\`);
  }
  const module = await import(specifier);
  const actual = Object.keys(module).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(specifier + ' runtime exports differ. Actual: ' + actual.join(', ') + ' Expected: ' + expected.join(', '));
  }
  loaded.push([specifier, resolved, actual.length]);
}

const { config } = await import('${publicSpecifier(pkg, './config')}');
if (config.pkg.name !== ${JSON.stringify(PACKED_CONSUMER_NAME)} || config.pkg.version !== ${JSON.stringify(PACKED_CONSUMER_VERSION)}) {
  throw new Error(
    'Installed package resolved a foreign identity: ' + config.pkg.name + '@' + config.pkg.version +
      ' (expected ' + ${JSON.stringify(`${PACKED_CONSUMER_NAME}@${PACKED_CONSUMER_VERSION}`)} + ')',
  );
}
if (typeof config.logsPath !== 'string' || config.logsPath.includes('node_modules')) {
  throw new Error('Installed package resolved logsPath inside its own install directory: ' + config.logsPath);
}
console.log('PACKAGE_RUNTIME_OK=' + JSON.stringify(loaded));
`;
}

function nodeTypeConsumerSource(pkg: PackageJson): string {
  const nodeSubpaths = runtimeSubpaths(pkg).filter(
    (specifier) => specifier !== `${pkg.name}/worker`,
  );
  const namespaces = nodeSubpaths
    .map((specifier, index) => `import * as Public${index} from '${specifier}';`)
    .join('\n');

  return `${namespaces}
import { createApp, prompt, resource, tool, z } from '${pkg.name}';
import type { CoreServices, SupabaseClientHandle } from '${pkg.name}';
import type { ToolDefinition } from '${pkg.name}/tools';
import type { ResourceDefinition } from '${pkg.name}/resources';
import type { PromptDefinition } from '${pkg.name}/prompts';
import type { ErrorResponse } from '${pkg.name}/errors';
import type { AppConfig } from '${pkg.name}/config';
import { checkScopes } from '${pkg.name}/auth';
import type { StorageService } from '${pkg.name}/storage';
import type { IStorageProvider } from '${pkg.name}/storage/types';
import type { IDataCanvasProvider } from '${pkg.name}/canvas';
import type { Mirror } from '${pkg.name}/mirror';
import type { FetchWithTimeoutOptions } from '${pkg.name}/utils';
import type { ILlmProvider } from '${pkg.name}/services';
import type { LintDiagnostic } from '${pkg.name}/linter';
import type { MockContextOptions } from '${pkg.name}/testing';
import type { FuzzOptions } from '${pkg.name}/testing/fuzz';
import type { McpTestFixtures, ToolContractSuccessCase } from '${pkg.name}/testing/vitest';

const echo = tool('package_echo', {
  description: 'Echoes a package verification value.',
  input: z.object({ value: z.string().describe('Value') }),
  output: z.object({ echoed: z.string().describe('Echoed value') }),
  handler: (input) => ({ echoed: input.value }),
});
const item = resource('package://{id}', {
  description: 'Reads a package verification resource.',
  params: z.object({ id: z.string().describe('Identifier') }),
  handler: (params) => ({ id: params.id }),
});
const message = prompt('package_prompt', {
  description: 'Builds a package verification prompt.',
  args: z.object({ value: z.string().describe('Value') }),
  generate: (args) => [{ role: 'user' as const, content: { type: 'text' as const, text: args.value } }],
});

type PublicContracts = [
  ToolDefinition<typeof echo.input, typeof echo.output>,
  ResourceDefinition,
  PromptDefinition<typeof message.args>,
  ErrorResponse,
  AppConfig,
  StorageService,
  IStorageProvider,
  IDataCanvasProvider,
  Mirror,
  FetchWithTimeoutOptions,
  ILlmProvider,
  LintDiagnostic,
  MockContextOptions,
  FuzzOptions,
  McpTestFixtures,
  CoreServices<SupabaseClientHandle>,
];

const expectedCase = {
  name: 'matches the expected output subset',
  input: { value: 'x' },
  expected: { echoed: 'x' },
} satisfies ToolContractSuccessCase<typeof echo>;
const assertedCase = {
  name: 'runs a custom result assertion',
  input: { value: 'x' },
  assert: (result) => { void result.content; },
} satisfies ToolContractSuccessCase<typeof echo>;
const contractOnlyCase: ToolContractSuccessCase<typeof echo> = {
  name: 'relies on the shared contract checks alone',
  input: { value: 'x' },
};
const invalidExpectedSubset: ToolContractSuccessCase<typeof echo> = {
  name: 'invalid expected subset',
  input: { value: 'x' },
  // @ts-expect-error Expected subsets are checked against the tool output.
  expected: { missing: true },
};

// @ts-expect-error Internal composition is not part of the root API.
import type { ComposedApp } from '${pkg.name}';
// @ts-expect-error Internal composition is not part of the root API.
import { composeServices } from '${pkg.name}';
// @ts-expect-error The framework's storage schema remains internal.
import type { Database } from '${pkg.name}';
// @ts-expect-error Internal manifest accounting remains private.
import type { DefinitionCounts } from '${pkg.name}';

declare const contracts: PublicContracts;
void [${nodeSubpaths.map((_, index) => `Public${index}`).join(', ')}];
void [createApp, checkScopes, echo, item, message, contracts, expectedCase, assertedCase, contractOnlyCase, invalidExpectedSubset];
`;
}

function supabaseTypeConsumerSource(pkg: PackageJson): string {
  return `
import { createApp } from '${pkg.name}';
import type { CoreServices } from '${pkg.name}';
import type { SupabaseClient } from '@supabase/supabase-js';

type Database = {
  public: {
    Tables: {
      items: {
        Row: { id: string; value: string };
        Insert: { id: string; value: string };
        Update: { id?: string; value?: string };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

type ExactClient = SupabaseClient<Database>;
declare const services: CoreServices<ExactClient>;
services.supabase?.from('items').select('id, value');

void createApp<ExactClient>({
  setup(core) {
    core.supabase?.from('items').select('id, value');
  },
});
`;
}

function workerTypeConsumerSource(pkg: PackageJson): string {
  return `
import * as Worker from '${pkg.name}/worker';
import type { CloudflareBindings } from '${pkg.name}/worker';

type Bindings = CloudflareBindings & { CUSTOM: string };
declare const bindings: Bindings;
void [Worker, bindings];
`;
}

/**
 * `@modelcontextprotocol/server` uses `Buffer` in type position, and
 * `@cloudflare/workers-types` declares it as a value only. A real Worker
 * consumer closes that the same way, and it keeps `@types/node` out of the
 * program.
 */
const WORKER_BUFFER_GLOBAL_SOURCE = `export {};
declare global {
  type Buffer = Uint8Array;
}
`;

async function verifyRuntimeImports(
  consumerDir: string,
  pkg: PackageJson,
  nodeBin: string,
  bunBin: string,
): Promise<void> {
  const vitestSpecifier = `${pkg.name}/testing/vitest`;
  const directSubpaths = (Object.keys(PUBLIC_RUNTIME_EXPORTS) as PublicRuntimeSubpath[]).filter(
    (subpath) => publicSpecifier(pkg, subpath) !== vitestSpecifier,
  );
  const source = runtimeImportSource(pkg, directSubpaths);
  await writeFile(join(consumerDir, 'runtime-imports.mjs'), source);

  await writeFile(
    join(consumerDir, 'runtime-vitest.test.mjs'),
    `
import { expect, test } from 'vitest';

test('loads the published testing/vitest subpath in its required host context', async () => {
  const resolved = import.meta.resolve('${vitestSpecifier}');
  const packageRoot = new URL('./node_modules/@cyanheads/mcp-ts-core/', import.meta.url).href;
  expect(resolved.startsWith(packageRoot)).toBe(true);
  const module = await import('${vitestSpecifier}');
  expect(Object.keys(module).sort()).toEqual(${JSON.stringify(
    [...PUBLIC_RUNTIME_EXPORTS['./testing/vitest']].sort(),
  )});
});
`,
  );
  await writeFile(
    join(consumerDir, 'vitest.runtime.config.mjs'),
    `export default { test: { include: ['runtime-vitest.test.mjs'] } };\n`,
  );
  const vitestBin = join(consumerDir, 'node_modules', 'vitest', 'vitest.mjs');

  for (const [runtime, executable] of [
    ['Node', nodeBin],
    ['Bun', bunBin],
  ] as const) {
    const result = await run(executable, ['runtime-imports.mjs'], consumerDir);
    assertSuccess(result, `${runtime} package subpath imports`);
    if (!result.stdout.includes('PACKAGE_RUNTIME_OK=')) {
      throw new Error(`${runtime} package subpath imports produced no verification marker.`);
    }

    const vitestResult = await run(
      executable,
      [vitestBin, 'run', '--config', 'vitest.runtime.config.mjs'],
      consumerDir,
    );
    assertSuccess(vitestResult, `${runtime} testing/vitest package import`);
  }
}

/**
 * The clean consumer installs neither optional peer of `testing/apps`. Importing the
 * subpath must still succeed, since the peers load on first use, and `renderAppTool` must
 * reject naming the first missing package. Either peer resolving in the consumer would
 * leave that path unexercised, so that fails the check too.
 */
async function verifyAppsWithoutPeers(
  consumerDir: string,
  pkg: PackageJson,
  nodeBin: string,
  bunBin: string,
): Promise<void> {
  const peers = ['@modelcontextprotocol/client', '@modelcontextprotocol/ext-apps'];
  await writeFile(
    join(consumerDir, 'apps-without-peers.mjs'),
    `
const peers = ${JSON.stringify(peers)};
for (const peer of peers) {
  let resolved;
  try {
    resolved = import.meta.resolve(peer);
  } catch {}
  if (resolved) {
    throw new Error(peer + ' resolves in the clean consumer (' + resolved + '), so the missing-peer path goes unverified.');
  }
}
const { renderAppTool } = await import('${publicSpecifier(pkg, './testing/apps')}');
const error = await renderAppTool({ server: { command: 'unused' }, tool: 'unused' }).then(
  () => undefined,
  (rejection) => rejection,
);
if (error?.data?.reason !== 'missing_peer' || error.data.package !== peers[0] || !String(error.message).includes(peers[0])) {
  throw new Error('renderAppTool without its optional peers did not reject naming ' + peers[0] + ': ' + (error ? error.message : 'it resolved'));
}
console.log('APPS_WITHOUT_PEERS_OK=' + error.data.package);
`,
  );
  for (const [runtime, executable] of [
    ['Node', nodeBin],
    ['Bun', bunBin],
  ] as const) {
    const result = await run(executable, ['apps-without-peers.mjs'], consumerDir);
    assertSuccess(result, `${runtime} testing/apps import without its optional peers`);
    if (!result.stdout.includes('APPS_WITHOUT_PEERS_OK=')) {
      throw new Error(
        `${runtime} testing/apps optional-peer check produced no verification marker.`,
      );
    }
  }
}

async function verifyTypes(consumerDir: string, pkg: PackageJson): Promise<void> {
  await writeFile(join(consumerDir, 'consumer-node.ts'), nodeTypeConsumerSource(pkg));
  await writeFile(join(consumerDir, 'consumer-supabase.ts'), supabaseTypeConsumerSource(pkg));
  await writeFile(
    join(consumerDir, 'tsconfig.node.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2025', 'DOM', 'DOM.Iterable', 'ESNext.TypedArrays'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2025',
          types: ['node'],
        },
        include: ['./consumer-node.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumerDir, 'tsconfig.supabase.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2025', 'DOM', 'DOM.Iterable', 'ESNext.TypedArrays'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          noUncheckedIndexedAccess: true,
          // Supabase's WebAuthn declarations currently conflict with TS 7's
          // DOM declarations; this lane verifies our generic opt-in contract.
          skipLibCheck: true,
          strict: true,
          target: 'ES2025',
          types: ['node'],
        },
        include: ['./consumer-supabase.ts'],
      },
      null,
      2,
    )}\n`,
  );

  const compilers = [
    ['TypeScript 7', join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc')],
    ['TypeScript 6', join(consumerDir, 'node_modules', 'typescript-v6', 'bin', 'tsc')],
  ] as const;
  for (const [compiler, tsc] of compilers) {
    const nodeResult = await run(
      tsc,
      ['--project', 'tsconfig.node.json', '--listFiles'],
      consumerDir,
    );
    assertSuccess(nodeResult, `${compiler} strict Node consumer typecheck`);
    if (nodeResult.stdout.includes('/@supabase/')) {
      throw new Error(`${compiler} default public declaration graph unexpectedly loaded Supabase.`);
    }
    const supabaseResult = await run(tsc, ['--project', 'tsconfig.supabase.json'], consumerDir);
    assertSuccess(supabaseResult, `${compiler} explicit Supabase client type opt-in`);
  }
}

/**
 * Typechecks the published Worker entry from an install root that carries no
 * `@types/node`, with `skipLibCheck: false` — so `dist/core/worker.d.ts` and
 * everything only it reaches are actually checked against Cloudflare's globals,
 * the way the Node lane checks the rest against `@types/node` (#411). Isolation
 * is what holds the lane green: put `@types/node` back in this fixture's
 * dependencies and it fails.
 */
async function verifyWorkerTypes(workerDir: string, pkg: PackageJson): Promise<void> {
  await writeFile(join(workerDir, 'consumer-worker.ts'), workerTypeConsumerSource(pkg));
  await writeFile(join(workerDir, 'buffer-global.d.ts'), WORKER_BUFFER_GLOBAL_SOURCE);
  await writeFile(
    join(workerDir, 'tsconfig.worker.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2025', 'ESNext.Disposable', 'ESNext.TypedArrays'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2025',
          types: ['@cloudflare/workers-types'],
        },
        include: ['./consumer-worker.ts', './buffer-global.d.ts'],
      },
      null,
      2,
    )}\n`,
  );

  const compilers = [
    ['TypeScript 7', join(workerDir, 'node_modules', 'typescript', 'bin', 'tsc')],
    ['TypeScript 6', join(workerDir, 'node_modules', 'typescript-v6', 'bin', 'tsc')],
  ] as const;
  for (const [compiler, tsc] of compilers) {
    const result = await run(tsc, ['--project', 'tsconfig.worker.json', '--listFiles'], workerDir);
    assertSuccess(result, `${compiler} strict Worker consumer typecheck`);

    const files = result.stdout.split(/\r?\n/).filter(Boolean);
    if (!files.some((file) => file.endsWith('/dist/core/worker.d.ts'))) {
      throw new Error(
        `${compiler} Worker consumer program did not include dist/core/worker.d.ts — the lane is not checking what it claims to.`,
      );
    }
    const nodeTypes = files.filter((file) => file.includes('/@types/node/'));
    if (nodeTypes.length > 0) {
      throw new Error(
        `${compiler} Worker consumer program loaded ${nodeTypes.length} @types/node declaration(s): ${nodeTypes[0]}`,
      );
    }
  }
}

/** Digest of every file path and its contents under `dir`, to detect any write into it. */
async function directoryDigest(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const entries = (await readdir(dir, { recursive: true })).sort();
  for (const entry of entries) {
    const path = join(dir, entry);
    if (!(await stat(path)).isFile()) continue;
    hash
      .update(entry)
      .update('\0')
      .update(await readFile(path))
      .update('\0');
  }
  return hash.digest('hex');
}

/**
 * Builds a consumer that extends the shipped `tsconfig.base.json` and restates
 * nothing but `rootDir` and `include`. Its output, build info, and `@/` alias
 * must all resolve inside the consumer, and the installed package must come
 * out byte-identical: a relative path in the base resolves against the
 * package's own directory and compiles into its `dist/` (#521).
 */
async function verifyBaseConfigConsumer(
  consumerDir: string,
  installedPackageDir: string,
  pkg: PackageJson,
): Promise<void> {
  const projectDir = join(consumerDir, 'base-config-consumer');
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await writeFile(
    join(projectDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: `${pkg.name}/tsconfig.base.json`,
        compilerOptions: { rootDir: 'src' },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(projectDir, 'src', 'value.ts'), `export const value = 'mine';\n`);
  await writeFile(
    join(projectDir, 'src', 'index.ts'),
    `import { value } from '@/value.js';\n\nexport const consumer = value;\n`,
  );

  const packageDigest = await directoryDigest(installedPackageDir);
  const compilers = [
    ['TypeScript 7', join(consumerDir, 'node_modules', 'typescript', 'bin', 'tsc')],
    ['TypeScript 6', join(consumerDir, 'node_modules', 'typescript-v6', 'bin', 'tsc')],
  ] as const;
  for (const [compiler, tsc] of compilers) {
    await rm(join(projectDir, 'dist'), { force: true, recursive: true });
    await rm(join(projectDir, 'tsconfig.tsbuildinfo'), { force: true });

    const build = await run(tsc, ['--project', 'tsconfig.json', '--pretty', 'false'], projectDir);
    assertSuccess(build, `${compiler} build of a consumer extending tsconfig.base.json`);
    await access(join(projectDir, 'dist', 'index.js'), constants.R_OK);
    await access(join(projectDir, 'tsconfig.tsbuildinfo'), constants.R_OK);
    if ((await directoryDigest(installedPackageDir)) !== packageDigest) {
      throw new Error(
        `${compiler} build of a consumer extending tsconfig.base.json wrote into the installed package.`,
      );
    }
  }
}

/**
 * Variables that, inherited from a git hook running this verifier, would point
 * the scaffold's `git` at another repository (`GIT_DIR`, …) or switch its
 * devcheck into staged-files mode (`HUSKY`, `GIT_PARAMS`).
 */
const HOOK_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_PARAMS',
  'GIT_WORK_TREE',
  'HUSKY',
]);

/**
 * The only diagnostics, errors or warnings, a fresh scaffold's `lint:mcp` may
 * report: the `server.json` identity `init` ships empty on purpose (setup skill
 * step 5). Anything else is a defect in the shipped template definitions.
 */
const SCAFFOLD_TODO_LINT_RULES = [
  'server-json-description-required',
  'server-json-name-format',
  'server-json-repository-url',
];

/**
 * The only diagnostics a fresh scaffold's `lint:packaging` may report: the
 * plugin-manifest fields `init` ships empty (setup skill step 5).
 */
const SCAFFOLD_TODO_PACKAGING = [
  '.claude-plugin/plugin.json "description" is empty',
  '.codex-plugin/plugin.json "description" is empty',
  '.codex-plugin/plugin.json interface.longDescription is empty',
  '.codex-plugin/plugin.json interface.shortDescription is empty',
];

type DevcheckStatus = 'FAILED' | 'PASSED' | 'SKIPPED' | 'WARNING';

/**
 * Every devcheck step's status on the scaffold once the setup skill's identity,
 * skill-mirror, and git steps have run, under `--no-fix --no-audit --no-deps`
 * (the two network-bound steps report registry state, not the scaffold). Exact:
 * a step that starts skipping in a consumer layout, or a step added without
 * being verified there, fails the lane.
 */
const SCAFFOLD_DEVCHECK_STATUS: Readonly<Record<string, DevcheckStatus>> = {
  'TODOs/FIXMEs': 'PASSED',
  'Tracked Secrets': 'PASSED',
  'MCP Definitions': 'PASSED',
  Packaging: 'PASSED',
  'Framework Antipatterns': 'PASSED',
  'Dependency Specifiers': 'PASSED',
  'Open-Indexed Interfaces': 'SKIPPED',
  'Docs Sync': 'PASSED',
  'Skills Sync': 'PASSED',
  'Skill Versions': 'PASSED',
  'Changelog Sync': 'PASSED',
  TypeScript: 'PASSED',
  'TypeScript (Worker)': 'SKIPPED',
  Tests: 'SKIPPED',
  'Unused Dependencies': 'PASSED',
  'Security Audit': 'SKIPPED',
  'Dependencies (Outdated)': 'SKIPPED',
};

/** Steps that must appear in the summary but whose status is not asserted. */
const SCAFFOLD_DEVCHECK_UNASSERTED = new Set([
  // A fresh scaffold fails Biome today: its templates are not Biome-clean (#557).
  'Biome',
]);

/** Replaces the one occurrence of `search` in the file at `path`, or throws naming the count. */
async function replaceOnce(path: string, search: string, replacement: string): Promise<void> {
  const source = await readFile(path, 'utf8');
  const occurrences = source.split(search).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one ${search} in ${path}, found ${occurrences}.`);
  }
  await writeFile(
    path,
    source.replace(search, () => replacement),
  );
}

/**
 * A fresh scaffold's first lint run is a to-do list, not a green light: both
 * gates must fail on exactly the identity fields `init` ships empty, with no
 * other diagnostic. Also
 * requires `lint:mcp` to have loaded every kind of template definition — it
 * exits 0 with "Skipping lint" when discovery finds nothing, so a discovery bug
 * in the consumer layout would otherwise pass silently.
 */
async function verifyScaffoldTodoList(
  projectDir: string,
  bunBin: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const lintMcp = await run(bunBin, ['run', 'lint:mcp'], projectDir, env);
  const lintMcpOutput = `${lintMcp.stdout}\n${lintMcp.stderr}`;
  const counts = /Linting (\d+) tool\(s\), (\d+) resource\(s\), (\d+) prompt\(s\)/
    .exec(lintMcpOutput)
    ?.slice(1)
    .map(Number);
  const rules = [...lintMcpOutput.matchAll(/[✗⚠] \[([^\]]+)\]/g)].map((match) => match[1]).sort();
  if (
    lintMcp.exitCode !== 1 ||
    !counts?.every((count) => count > 0) ||
    rules.join() !== [...SCAFFOLD_TODO_LINT_RULES].sort().join()
  ) {
    throw new Error(
      `Fresh scaffold lint:mcp must load at least one tool, resource, and prompt, then report exactly ${SCAFFOLD_TODO_LINT_RULES.join(', ')}. ` +
        `Got exit ${lintMcp.exitCode}, counts ${counts?.join('/') ?? 'none'}, rules ${rules.join(', ') || 'none'}.\n${lintMcpOutput}`,
    );
  }

  const lintPackaging = await run(bunBin, ['run', 'lint:packaging'], projectDir, env);
  const lintPackagingOutput = `${lintPackaging.stdout}\n${lintPackaging.stderr}`;
  const gaps = lintPackagingOutput
    .split(/\r?\n/)
    .map((line) => /^\s*[✗⚠] (.+?)(?: — .*)?$/.exec(line)?.[1])
    .filter((gap): gap is string => Boolean(gap))
    .sort();
  if (
    lintPackaging.exitCode !== 1 ||
    gaps.join('\n') !== [...SCAFFOLD_TODO_PACKAGING].sort().join('\n')
  ) {
    throw new Error(
      `Fresh scaffold lint:packaging must report exactly: ${SCAFFOLD_TODO_PACKAGING.join('; ')}. ` +
        `Got exit ${lintPackaging.exitCode}.\n${lintPackagingOutput}`,
    );
  }
}

/** Fills only the identity fields the setup skill's step 5 gates, as single-line edits. */
async function populateScaffoldIdentity(projectDir: string, projectName: string): Promise<void> {
  const description = '"Scaffold verified by the package lane."';
  const serverJson = join(projectDir, 'server.json');
  await replaceOnce(
    serverJson,
    `"name": "${projectName}"`,
    `"name": "io.github.example/${projectName}"`,
  );
  await replaceOnce(serverJson, '"description": ""', `"description": ${description}`);
  await replaceOnce(serverJson, '"url": ""', `"url": "https://github.com/example/${projectName}"`);
  const claudePlugin = join(projectDir, '.claude-plugin', 'plugin.json');
  await replaceOnce(claudePlugin, '"description": ""', `"description": ${description}`);
  const codexPlugin = join(projectDir, '.codex-plugin', 'plugin.json');
  await replaceOnce(codexPlugin, '"description": ""', `"description": ${description}`);
  await replaceOnce(codexPlugin, '"shortDescription": ""', `"shortDescription": ${description}`);
  await replaceOnce(codexPlugin, '"longDescription": ""', `"longDescription": ${description}`);
}

type DevcheckRow = { lines: string[]; status: DevcheckStatus };

/** Rows of devcheck's `Checkup Summary` by step name, each with the output printed under it. */
function parseDevcheckSummary(stdout: string): Map<string, DevcheckRow> {
  const rows = new Map<string, DevcheckRow>();
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('Checkup Summary'));
  if (start === -1) return rows;

  let current: DevcheckRow | undefined;
  for (const line of lines.slice(start + 1)) {
    const row = /^(\S.*?)\s+\S+\s+(FAILED|PASSED|SKIPPED|WARNING)\b/.exec(line);
    if (row?.[1]) {
      current = { lines: [line], status: row[2] as DevcheckStatus };
      rows.set(row[1], current);
    } else if (line.startsWith('---')) {
      current = undefined; // the rule that closes the summary
    } else {
      current?.lines.push(line);
    }
  }
  return rows;
}

/**
 * Runs the scaffold's own gate on the project the setup skill leaves behind:
 * identity populated, framework skills mirrored into `.claude/skills`, and the
 * tree under git so the git-backed steps run instead of skipping. Every step's
 * status must match {@link SCAFFOLD_DEVCHECK_STATUS}.
 */
async function verifyScaffoldDevcheck(
  projectDir: string,
  projectName: string,
  bunBin: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await populateScaffoldIdentity(projectDir, projectName);
  await cp(join(projectDir, 'framework-skills'), join(projectDir, '.claude', 'skills'), {
    recursive: true,
  });
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
  ]) {
    assertSuccess(await run('git', args, projectDir, env), `installed CLI scaffold git ${args[0]}`);
  }

  const flags = ['--no-fix', '--no-audit', '--no-deps'];
  const devcheck = await run(bunBin, ['run', 'devcheck', ...flags], projectDir, env);
  const rows = parseDevcheckSummary(devcheck.stdout);
  if (rows.size === 0) {
    throw new Error(
      `installed CLI scaffold devcheck printed no summary (exit ${devcheck.exitCode}).\n${devcheck.stderr}\n${devcheck.stdout}`,
    );
  }

  const mismatches: Array<{ detail: string; name: string }> = [];
  for (const [name, expected] of Object.entries(SCAFFOLD_DEVCHECK_STATUS)) {
    const actual = rows.get(name)?.status ?? 'no summary row';
    if (actual !== expected) {
      mismatches.push({ name, detail: `expected ${expected}, got ${actual}` });
    }
  }
  for (const name of SCAFFOLD_DEVCHECK_UNASSERTED) {
    if (!rows.has(name)) mismatches.push({ name, detail: 'no summary row' });
  }
  for (const [name, row] of rows) {
    if (!Object.hasOwn(SCAFFOLD_DEVCHECK_STATUS, name) && !SCAFFOLD_DEVCHECK_UNASSERTED.has(name)) {
      mismatches.push({ name, detail: `unexpected step, got ${row.status}` });
    }
  }
  if (mismatches.length > 0) {
    const headline = mismatches.map(({ name, detail }) => `${name} (${detail})`).join('; ');
    const blocks = mismatches.map(({ name }) => rows.get(name)?.lines.join('\n').trimEnd() ?? name);
    throw new Error(
      `installed CLI scaffold devcheck ${flags.join(' ')}: ${headline}\n\n${blocks.join('\n\n')}`,
    );
  }
}

async function verifyCli(
  consumerDir: string,
  installedPackageDir: string,
  pkg: PackageJson,
  tarball: string,
  bunBin: string,
  nodeBin: string,
): Promise<string> {
  const binName = Object.keys(pkg.bin ?? {})[0];
  const binTarget = binName ? pkg.bin?.[binName] : undefined;
  if (!binName || !binTarget) throw new Error('package.json must declare a CLI bin.');

  const linkedBin = join(consumerDir, 'node_modules', '.bin', binName);
  const installedTarget = join(installedPackageDir, binTarget);
  await access(linkedBin, constants.X_OK);
  await access(installedTarget, constants.R_OK);

  const help = await run(linkedBin, ['--help'], consumerDir);
  assertSuccess(help, 'installed CLI bin --help');
  if (!help.stdout.includes('mcp-ts-core init')) {
    throw new Error('Installed CLI bin did not print the expected usage.');
  }

  const projectName = 'packed-cli-server';
  const init = await run(nodeBin, [installedTarget, 'init', projectName], consumerDir);
  assertSuccess(init, 'installed CLI init');

  const projectDir = join(consumerDir, projectName);
  const scaffoldPackage = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    name?: string;
  };
  if (scaffoldPackage.name !== projectName) {
    throw new Error(`CLI scaffold has unexpected package name: ${String(scaffoldPackage.name)}`);
  }
  if (scaffoldPackage.dependencies?.[pkg.name] !== `^${pkg.version}`) {
    throw new Error(`CLI scaffold did not substitute framework version ${pkg.version}.`);
  }
  if (scaffoldPackage.devDependencies?.['fast-check'] !== dependencyVersion(pkg, 'fast-check')) {
    throw new Error('CLI scaffold did not declare fast-check as a direct devDependency.');
  }
  await access(join(projectDir, 'src', 'index.ts'), constants.R_OK);
  await access(join(projectDir, 'scripts', 'build.ts'), constants.R_OK);
  // The scaffold Dockerfile's deps stage runs both; without either the image build fails at its COPY.
  await access(join(projectDir, 'scripts', 'install-otel.ts'), constants.R_OK);
  await access(join(projectDir, 'scripts', 'prune-musl-packages.ts'), constants.R_OK);

  // Preserve the generated manifest long enough to assert its published
  // dependency contract above, then point only this temporary verifier copy at
  // the tarball. Installing in the scaffold gives it its own dependency tree:
  // undeclared template imports cannot resolve through the repository or the
  // parent consumer, and the framework resolves only from the packed artifact.
  // The one dependency line is edited in place, leaving the rest of the file
  // byte-identical to what `init` wrote, so the scaffold's own Biome reads the
  // template's formatting rather than this verifier's.
  // `--prefer-offline`, not `--offline`: cached manifests expire, and a strict
  // offline install fails on any metadata the cache no longer holds.
  await replaceOnce(
    join(projectDir, 'package.json'),
    `${JSON.stringify(pkg.name)}: ${JSON.stringify(`^${pkg.version}`)}`,
    `${JSON.stringify(pkg.name)}: ${JSON.stringify(`file:${tarball}`)}`,
  );
  const install = await run(
    bunBin,
    ['install', '--prefer-offline', '--ignore-scripts', '--backend=copyfile', '--no-progress'],
    projectDir,
  );
  assertSuccess(install, 'installed CLI scaffold install');

  const tsc = join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const typecheck = await run(tsc, ['--project', 'tsconfig.json', '--pretty', 'false'], projectDir);
  assertSuccess(typecheck, 'installed CLI scaffold typecheck (src + tests)');
  // The scaffold sets `tsBuildInfoFile` and inherits `incremental` from the
  // shipped base; without it, tsc exits 0 and silently writes no build info.
  await access(join(projectDir, '.tsbuildinfo'), constants.R_OK);

  // Build through the scaffold's own `build` script — `scripts/build.ts`, which
  // ships in the package and resolves its tsconfig itself. Invoking
  // `tsc --project tsconfig.build.json` here instead would verify the
  // scaffold's config while leaving the shipped script's default path
  // unexercised, which is how a default matching only this repo's layout
  // reached a release (#440).
  const build = await run(bunBin, ['run', 'build'], projectDir);
  assertSuccess(build, 'installed CLI scaffold build (scripts/build.ts)');
  await access(join(projectDir, 'dist', 'index.js'), constants.R_OK);

  // The scaffold's own root script, as its user runs it.
  const tests = await run(bunBin, ['run', 'test'], projectDir);
  assertSuccess(tests, 'installed CLI scaffold `bun run test`');

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !HOOK_ENV_KEYS.has(key)),
  );
  await verifyScaffoldTodoList(projectDir, bunBin, env);
  await verifyScaffoldDevcheck(projectDir, projectName, bunBin, env);
  return projectDir;
}

/**
 * Packs the repository as npm would, installs the tarball into an isolated
 * production-only consumer, and exercises its runtime imports, public type
 * declarations, and CLI bin — whose scaffold must typecheck, build, pass its
 * own tests, and pass its own devcheck once the setup skill's steps have run.
 *
 * @returns What the run verified.
 * @throws If the build is stale, the packlist drifts, or any verification step fails.
 */
export async function verifyPublishedPackage(): Promise<PackageVerificationReport> {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as PackageJson;
  assertRuntimeSubpathContract(pkg);
  await assertBuildFresh(pkg);

  const tempRoot = await mkdtemp(join(tmpdir(), 'mcp-ts-core-package-'));
  const keepTemp = process.env.KEEP_PACKAGE_TEST_TMP === '1';
  try {
    const packDir = join(tempRoot, 'pack');
    const consumerDir = join(tempRoot, 'consumer');
    const workerConsumerDir = join(tempRoot, 'consumer-worker');
    await mkdir(packDir);
    await mkdir(consumerDir);
    await mkdir(workerConsumerDir);

    const [bunBin, nodeBin, npmBin] = await Promise.all([
      findCommand('bun'),
      findCommand('node'),
      findCommand('npm'),
    ]);
    const packed = await run(
      npmBin,
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
      ROOT,
    );
    assertSuccess(packed, 'npm pack');
    const tarballs = (await readdir(packDir)).filter((entry) => entry.endsWith('.tgz'));
    const [tarballName] = tarballs;
    if (tarballs.length !== 1 || !tarballName) {
      throw new Error(`Expected one package tarball, found: ${tarballs.join(', ') || 'none'}`);
    }
    const tarball = join(packDir, tarballName);
    await access(tarball, constants.R_OK);

    const listed = await run('tar', ['-tzf', tarball], ROOT);
    assertSuccess(listed, 'tarball packlist read');
    const packEntries = listed.stdout.split(/\r?\n/).filter(Boolean);
    assertPacklist(pkg, packEntries);
    await assertPackerParity(bunBin, packEntries);

    const dependencies = Object.fromEntries(
      CONSUMER_SUPPORT_PACKAGES.map((name) => [name, dependencyVersion(pkg, name)]),
    );
    dependencies[pkg.name] = `file:${tarball}`;
    await writeFile(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: PACKED_CONSUMER_NAME,
          version: PACKED_CONSUMER_VERSION,
          private: true,
          type: 'module',
          dependencies,
        },
        null,
        2,
      )}\n`,
    );

    const workerDependencies = Object.fromEntries(
      WORKER_CONSUMER_PACKAGES.map((name) => [name, dependencyVersion(pkg, name)]),
    );
    workerDependencies[pkg.name] = `file:${tarball}`;
    await writeFile(
      join(workerConsumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: `${PACKED_CONSUMER_NAME}-worker`,
          version: PACKED_CONSUMER_VERSION,
          private: true,
          type: 'module',
          dependencies: workerDependencies,
        },
        null,
        2,
      )}\n`,
    );

    const installArgs = [
      'install',
      '--production',
      '--ignore-scripts',
      '--backend=copyfile',
      '--no-progress',
    ];
    const [installed, workerInstalled] = await Promise.all([
      run(bunBin, installArgs, consumerDir),
      run(bunBin, installArgs, workerConsumerDir),
    ]);
    assertSuccess(installed, 'production-only tarball install');
    assertSuccess(workerInstalled, 'Worker consumer tarball install');

    const packageDir = join(consumerDir, 'node_modules', '@cyanheads', 'mcp-ts-core');
    const packageMetadata = await lstat(packageDir);
    if (packageMetadata.isSymbolicLink()) {
      throw new Error('Packed consumer unexpectedly installed mcp-ts-core as a symlink.');
    }
    const installedPackageDir = await realpath(packageDir);
    const installedConsumerDir = await realpath(consumerDir);
    if (!installedPackageDir.startsWith(`${installedConsumerDir}/node_modules/`)) {
      throw new Error(`Packed package resolved outside the clean consumer: ${installedPackageDir}`);
    }

    const installedPkg = JSON.parse(
      await readFile(join(installedPackageDir, 'package.json'), 'utf8'),
    ) as PackageJson;
    if (installedPkg.name !== pkg.name || installedPkg.version !== pkg.version) {
      throw new Error(
        `Installed tarball identity mismatch: ${installedPkg.name}@${installedPkg.version}`,
      );
    }

    await verifyRuntimeImports(consumerDir, installedPkg, nodeBin, bunBin);
    await verifyAppsWithoutPeers(consumerDir, installedPkg, nodeBin, bunBin);
    await verifyTypes(consumerDir, installedPkg);
    await verifyWorkerTypes(workerConsumerDir, installedPkg);
    await verifyBaseConfigConsumer(consumerDir, installedPackageDir, installedPkg);
    const cliProject = await verifyCli(
      consumerDir,
      installedPackageDir,
      installedPkg,
      tarball,
      bunBin,
      nodeBin,
    );

    return {
      cliProject,
      packEntries: packEntries.length,
      runtimeSubpaths: runtimeSubpaths(installedPkg),
      tarball,
    };
  } finally {
    if (!keepTemp) await rm(tempRoot, { force: true, recursive: true });
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  verifyPublishedPackage()
    .then((report) => {
      console.log(
        `Package verification passed: ${report.runtimeSubpaths.length} runtime subpaths, ${report.packEntries} packed entries, CLI scaffolded/typechecked/built/tested/devchecked.`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
