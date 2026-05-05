/**
 * @fileoverview Consumer-facing package export integration tests.
 * @module tests/integration/package-consumer.int.test
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST_INDEX = resolve(process.cwd(), 'dist/core/index.js');
const PACKAGE_ROOT = process.cwd();

type RunResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolveResult) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function findRealNode(cwd: string): Promise<string> {
  const result = await run('sh', ['-c', 'which -a node | grep -v /bun-node- | head -n 1'], cwd);
  return result.stdout.trim() || 'node';
}

describe.skipIf(!existsSync(DIST_INDEX))('package consumer exports', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-ts-core-consumer-'));
    const scopeDir = join(tempDir, 'node_modules', '@cyanheads');
    await mkdir(scopeDir, { recursive: true });
    await symlink(PACKAGE_ROOT, join(scopeDir, 'mcp-ts-core'), 'dir');

    const typesDir = join(tempDir, 'node_modules', '@types');
    await mkdir(typesDir, { recursive: true });
    await symlink(
      resolve(PACKAGE_ROOT, 'node_modules', '@types', 'node'),
      join(typesDir, 'node'),
      'dir',
    );

    const cloudflareDir = join(tempDir, 'node_modules', '@cloudflare');
    await mkdir(cloudflareDir, { recursive: true });
    await symlink(
      resolve(PACKAGE_ROOT, 'node_modules', '@cloudflare', 'workers-types'),
      join(cloudflareDir, 'workers-types'),
      'dir',
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('typechecks public subpath imports from a consumer project', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'consumer-test', type: 'module', private: true }, null, 2),
    );
    await writeFile(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            strict: true,
            target: 'ESNext',
            types: ['node', '@cloudflare/workers-types'],
          },
          include: ['./consumer.ts'],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(tempDir, 'consumer.ts'),
      `
import {
  APP_RESOURCE_MIME_TYPE,
  appResource,
  appTool,
  createApp,
  createFail,
  prompt,
  resource,
  tool,
  z,
} from '@cyanheads/mcp-ts-core';
import { checkScopes } from '@cyanheads/mcp-ts-core/auth';
import { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { config } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { PromptDefinition } from '@cyanheads/mcp-ts-core/prompts';
import type { ResourceDefinition } from '@cyanheads/mcp-ts-core/resources';
import { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { IStorageProvider } from '@cyanheads/mcp-ts-core/storage/types';
import { isTaskToolDefinition, type TaskToolDefinition } from '@cyanheads/mcp-ts-core/tasks';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';
import type { ToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { stringToBase64 } from '@cyanheads/mcp-ts-core/utils';
import { createWorkerHandler, type CloudflareBindings } from '@cyanheads/mcp-ts-core/worker';

const echo = tool('consumer_echo', {
  description: 'Echoes a message.',
  input: z.object({ message: z.string().describe('Message') }),
  output: z.object({ echoed: z.string().describe('Echoed message') }),
  handler: (input) => ({ echoed: input.message }),
});

const echoResource = resource('consumer://{id}', {
  description: 'Reads a consumer resource.',
  params: z.object({ id: z.string().describe('Resource ID') }),
  handler: (params) => ({ id: params.id }),
});

const echoPrompt = prompt('consumer_prompt', {
  description: 'Builds a prompt.',
  args: z.object({ message: z.string().describe('Message') }),
  generate: (args) => [
    { role: 'user' as const, content: { type: 'text' as const, text: args.message } },
  ],
});

const ui = appResource('consumer-app://ui', {
  description: 'Consumer UI resource.',
  params: z.object({}).describe('No parameters.'),
  handler: () => '<div>ok</div>',
});

const uiTool = appTool('consumer_app', {
  description: 'Consumer app tool.',
  resourceUri: 'consumer-app://ui',
  input: z.object({}),
  output: z.object({ ok: z.boolean().describe('OK') }),
  handler: () => ({ ok: true }),
});

const fail = createFail([
  {
    reason: 'missing',
    code: JsonRpcErrorCode.NotFound,
    when: 'The requested item does not exist.',
    recovery: 'Request a known item identifier and retry.',
  },
] as const);

const ctx = createMockContext({ tenantId: 'consumer' });
const worker = createWorkerHandler({ tools: [echo, uiTool], resources: [echoResource], prompts: [echoPrompt] });

type Bindings = CloudflareBindings & { CUSTOM: string };
const bindings: Bindings = { CUSTOM: 'value' };
type PublicTypes = [
  ToolDefinition<typeof echo.input, typeof echo.output>,
  ResourceDefinition,
  PromptDefinition<typeof echoPrompt.args>,
  TaskToolDefinition<typeof echo.input, typeof echo.output>,
  IStorageProvider,
];
const publicTypes = undefined as unknown as PublicTypes;

void [
  APP_RESOURCE_MIME_TYPE,
  DataCanvas,
  JsonRpcErrorCode,
  McpError,
  StorageService,
  bindings,
  checkScopes,
  config,
  createApp,
  ctx,
  fail,
  fuzzTool,
  isTaskToolDefinition,
  publicTypes,
  stringToBase64('consumer'),
  ui,
  worker,
];
`,
    );

    const tsc = resolve(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc');
    const result = await run(tsc, ['--project', 'tsconfig.json'], tempDir);

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  });

  it('loads every public runtime subpath through package exports', async () => {
    await writeFile(
      join(tempDir, 'runtime-imports.mjs'),
      `
const specs = [
  '@cyanheads/mcp-ts-core',
  '@cyanheads/mcp-ts-core/worker',
  '@cyanheads/mcp-ts-core/errors',
  '@cyanheads/mcp-ts-core/config',
  '@cyanheads/mcp-ts-core/auth',
  '@cyanheads/mcp-ts-core/storage',
  '@cyanheads/mcp-ts-core/storage/types',
  '@cyanheads/mcp-ts-core/canvas',
  '@cyanheads/mcp-ts-core/utils',
  '@cyanheads/mcp-ts-core/services',
  '@cyanheads/mcp-ts-core/linter',
  '@cyanheads/mcp-ts-core/testing',
  '@cyanheads/mcp-ts-core/testing/fuzz',
  '@cyanheads/mcp-ts-core/tools',
  '@cyanheads/mcp-ts-core/resources',
  '@cyanheads/mcp-ts-core/prompts',
  '@cyanheads/mcp-ts-core/tasks',
];

const loaded = [];
for (const spec of specs) {
  const mod = await import(spec);
  loaded.push([spec, Object.keys(mod).length]);
}
console.log(JSON.stringify(loaded));
`,
    );

    const nodeBin = await findRealNode(tempDir);
    const result = await run(nodeBin, ['runtime-imports.mjs'], tempDir);

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const loaded = JSON.parse(result.stdout) as Array<[string, number]>;
    expect(loaded).toHaveLength(17);
    expect(loaded.find(([spec]) => spec === '@cyanheads/mcp-ts-core')?.[1]).toBeGreaterThan(0);
  });
});
