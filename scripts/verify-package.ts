#!/usr/bin/env bun
/**
 * @fileoverview Hermetic verification of the npm package consumers receive.
 * Builds are checked for freshness, packed as an npm-compatible tarball,
 * installed into an isolated production-only consumer, and exercised through
 * runtime imports, public declarations, and the published CLI bin.
 * @module scripts/verify-package
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
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
  '@cloudflare/workers-types',
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
 * Wall-clock ceiling for every child process this verifier spawns. The slowest
 * step (a cold `bun install` of the consumer support packages) runs well under
 * this, so exceeding it means the child is wedged rather than slow.
 */
const CHILD_TIMEOUT_MS = 300_000;

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolveResult, rejectResult) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...process.env, NODE_PATH: '', NO_COLOR: '1' },
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
// The SDK ships one shared declaration chunk, so its stdio transport's
// \`ReadBuffer.append(chunk: Buffer)\` is visible to a Worker consumer that has
// no \`@types/node\`. Declaring the global here keeps this lane's
// \`skipLibCheck: false\` — which exists to check OUR declarations — instead of
// pulling in a Node type set that collides with @cloudflare/workers-types on
// \`console\`, \`crypto\`, \`Event\`, and friends.
declare global {
  type Buffer = Uint8Array;
}

import * as Worker from '${pkg.name}/worker';
import type { CloudflareBindings } from '${pkg.name}/worker';

type Bindings = CloudflareBindings & { CUSTOM: string };
declare const bindings: Bindings;
void [Worker, bindings];
`;
}

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

async function verifyTypes(consumerDir: string, pkg: PackageJson): Promise<void> {
  await writeFile(join(consumerDir, 'consumer-node.ts'), nodeTypeConsumerSource(pkg));
  await writeFile(join(consumerDir, 'consumer-supabase.ts'), supabaseTypeConsumerSource(pkg));
  await writeFile(join(consumerDir, 'consumer-worker.ts'), workerTypeConsumerSource(pkg));
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
  await writeFile(
    join(consumerDir, 'tsconfig.worker.json'),
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
        include: ['./consumer-worker.ts'],
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
    const workerResult = await run(tsc, ['--project', 'tsconfig.worker.json'], consumerDir);
    assertSuccess(workerResult, `${compiler} strict Worker consumer typecheck`);
    const supabaseResult = await run(tsc, ['--project', 'tsconfig.supabase.json'], consumerDir);
    assertSuccess(supabaseResult, `${compiler} explicit Supabase client type opt-in`);
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

  // Preserve the generated manifest long enough to assert its published
  // dependency contract above, then point only this temporary verifier copy at
  // the tarball. An offline install gives the scaffold its own dependency tree:
  // undeclared template imports cannot resolve through the repository or the
  // parent consumer, and the registry cannot mask a broken packed artifact.
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(
      {
        ...scaffoldPackage,
        dependencies: {
          ...scaffoldPackage.dependencies,
          [pkg.name]: `file:${tarball}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  const install = await run(
    bunBin,
    ['install', '--offline', '--ignore-scripts', '--backend=copyfile', '--no-progress'],
    projectDir,
  );
  assertSuccess(install, 'installed CLI scaffold offline install');

  const tsc = join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const typecheck = await run(tsc, ['--project', 'tsconfig.json', '--pretty', 'false'], projectDir);
  assertSuccess(typecheck, 'installed CLI scaffold typecheck (src + tests)');

  const build = await run(
    tsc,
    ['--project', 'tsconfig.build.json', '--pretty', 'false'],
    projectDir,
  );
  assertSuccess(build, 'installed CLI scaffold build config');

  const vitest = join(projectDir, 'node_modules', 'vitest', 'vitest.mjs');
  const tests = await run(bunBin, [vitest, 'run', '--config', 'vitest.config.ts'], projectDir);
  assertSuccess(tests, 'installed CLI scaffold test suites');
  return projectDir;
}

/**
 * Packs the repository as npm would, installs the tarball into an isolated
 * production-only consumer, and exercises its runtime imports, public type
 * declarations, and CLI bin.
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
    await mkdir(packDir);
    await mkdir(consumerDir);

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

    const dependencies = Object.fromEntries(
      CONSUMER_SUPPORT_PACKAGES.map((name) => [name, dependencyVersion(pkg, name)]),
    );
    dependencies[pkg.name] = `file:${tarball}`;
    await writeFile(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'mcp-ts-core-packed-consumer',
          private: true,
          type: 'module',
          dependencies,
        },
        null,
        2,
      )}\n`,
    );

    const installed = await run(
      bunBin,
      ['install', '--production', '--ignore-scripts', '--backend=copyfile', '--no-progress'],
      consumerDir,
    );
    assertSuccess(installed, 'production-only tarball install');

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
    await verifyTypes(consumerDir, installedPkg);
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
        `Package verification passed: ${report.runtimeSubpaths.length} runtime subpaths, ${report.packEntries} packed entries, CLI scaffolded/typechecked/built/tested.`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
