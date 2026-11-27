/**
 * @fileoverview Integration test for the `.env` load (#634). A server started
 * from a directory whose `.env` is the only source of its values sees them in
 * server config read during import — a module-scope `disabledTool()` gate and a
 * `z.lazy` input bound — under Node as under Bun, with the process environment
 * winning over the file. A `.env` that cannot be loaded, or that carries an
 * invalid framework variable, stops startup through the configuration banner;
 * an invalid server variable exits 1 naming it.
 * @module tests/integration/env-file.int.test
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
/** The built package root (`.`) and `/config` subpath a consumer server imports. */
const DIST_ROOT_URL = pathToFileURL(resolve(REPO_ROOT, 'dist/core/index.js')).href;
const DIST_CONFIG_URL = pathToFileURL(resolve(REPO_ROOT, 'dist/config/index.js')).href;
const RUNTIMES = ['bun', 'node'] as const;
const BANNER = 'Configuration error — server failed to start';

/** Server config written to the `api-config` skill's pattern. */
const CONFIG_MODULE = `import { z } from '${DIST_ROOT_URL}';
import { parseEnvConfig } from '${DIST_CONFIG_URL}';

const ServerConfigSchema = z.object({
  readOnly: z.stringbool().default(false),
  baseDir: z.string().optional(),
  timeoutMs: z.coerce.number().int().min(1).default(5000),
  clampLimits: z.stringbool().default(true),
});

let cached;
export function getServerConfig() {
  cached ??= parseEnvConfig(ServerConfigSchema, {
    readOnly: 'ENVFILE_PROBE_READ_ONLY',
    baseDir: 'ENVFILE_PROBE_BASE_DIR',
    timeoutMs: 'ENVFILE_PROBE_TIMEOUT_MS',
    clampLimits: 'ENVFILE_PROBE_CLAMP_LIMITS',
  });
  return cached;
}
`;

/** Definitions that read server config while the module loads, as the `add-tool` gate does. */
const TOOLS_MODULE = `import { disabledTool, tool, z } from '${DIST_ROOT_URL}';
import { getServerConfig } from './config.mjs';

const writeDef = tool('probe_write', {
  description: 'Writes a value.',
  annotations: { readOnlyHint: false },
  input: z.object({ value: z.string().describe('Value to write') }),
  output: z.object({ ok: z.boolean().describe('Whether it wrote') }),
  handler: () => ({ ok: true }),
  format: (result) => [{ type: 'text', text: JSON.stringify(result) }],
});

export const probeWrite = getServerConfig().readOnly
  ? disabledTool(writeDef, { reason: 'Read-only deployment.' })
  : writeDef;

export const probeInfo = tool('probe_info', {
  description: 'Reports the resolved server config.',
  annotations: { readOnlyHint: true },
  input: z.object({}),
  output: z.object({
    baseDir: z.string().describe('Resolved base directory, or (unset)'),
    timeoutMs: z.number().describe('Resolved timeout'),
  }),
  handler: () => {
    const config = getServerConfig();
    return { baseDir: config.baseDir ?? '(unset)', timeoutMs: config.timeoutMs };
  },
  format: (result) => [{ type: 'text', text: JSON.stringify(result) }],
});

export const probeLazy = tool('probe_lazy', {
  description: 'Takes a limit whose bound depends on config.',
  annotations: { readOnlyHint: true },
  input: z.object({
    limit: z
      .lazy(() =>
        getServerConfig().clampLimits ? z.number().int().min(1).max(100) : z.number().int().min(1),
      )
      .describe('Result limit'),
  }),
  output: z.object({ limit: z.number().describe('Limit used') }),
  handler: (input) => ({ limit: input.limit }),
  format: (result) => [{ type: 'text', text: JSON.stringify(result) }],
});
`;

/** Entry whose static imports evaluate the gate and the lazy bound before `createApp()` runs. */
const GATE_ENTRY = `import { createApp } from '${DIST_ROOT_URL}';
import { getServerConfig } from './config.mjs';
import { probeInfo, probeLazy, probeWrite } from './tools.mjs';

await createApp({
  name: 'env-file-probe',
  tools: [probeWrite, probeInfo, probeLazy],
  setup() {
    getServerConfig();
  },
});
`;

/** Entry that reads server config only in `setup()`, inside the startup error boundary. */
const SETUP_ENTRY = `import { createApp } from '${DIST_ROOT_URL}';
import { getServerConfig } from './config.mjs';

await createApp({
  name: 'env-file-probe',
  tools: [],
  setup() {
    getServerConfig();
  },
});
`;

/** The parent environment minus anything that could supply a value the `.env` is meant to. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('MCP_') || key.startsWith('OTEL_') || key.startsWith('ENVFILE_PROBE_')) {
      continue;
    }
    if (key === 'LOGS_DIR') continue;
    env[key] = value;
  }
  return { ...env, DEBUG: '', ...extra };
}

/**
 * Runs `entry` from `cwd` with stdin closed, so a server that does start ends
 * on stdin EOF instead of waiting; resolves with the exit code and stderr.
 */
async function runToExit(
  runtime: (typeof RUNTIMES)[number],
  entry: string,
  cwd: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(runtime, [entry], {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 25_000,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stderr };
}

describe('server config read before createApp() sees ./.env on both runtimes (#634)', () => {
  let root: string;
  let gateEntry: string;
  let setupEntry: string;

  /** A fresh working directory holding `.env` as a file with `contents` or as a directory. */
  async function workDir(contents: string | 'directory'): Promise<string> {
    const dir = await mkdtemp(join(root, 'cwd-'));
    if (contents === 'directory') await mkdir(join(dir, '.env'));
    else await writeFile(join(dir, '.env'), contents);
    return dir;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mcp-env-file-'));
    const fixture = join(root, 'server');
    await mkdir(fixture);
    gateEntry = join(fixture, 'gate.mjs');
    setupEntry = join(fixture, 'setup.mjs');
    await Promise.all([
      writeFile(join(fixture, 'config.mjs'), CONFIG_MODULE),
      writeFile(join(fixture, 'tools.mjs'), TOOLS_MODULE),
      writeFile(gateEntry, GATE_ENTRY),
      writeFile(setupEntry, SETUP_ENTRY),
    ]);
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it.each(RUNTIMES)(
    'applies .env values to the gate and the lazy bound under %s, the process environment winning',
    async (runtime) => {
      const cwd = await workDir(
        'ENVFILE_PROBE_READ_ONLY=true\nENVFILE_PROBE_BASE_DIR=/srv/repos\nENVFILE_PROBE_CLAMP_LIMITS=false\nENVFILE_PROBE_TIMEOUT_MS=9000\n',
      );
      const transport = new StdioClientTransport({
        command: runtime,
        args: [gateEntry],
        cwd,
        env: childEnv({ ENVFILE_PROBE_TIMEOUT_MS: '1234' }),
        stderr: 'ignore',
      });
      const client = new Client({ name: 'env-file-int', version: '1.0.0' });
      await client.connect(transport);

      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(['probe_info', 'probe_lazy']);
        const limit = tools.find((t) => t.name === 'probe_lazy')?.inputSchema.properties?.limit as
          | { maximum?: number }
          | undefined;
        expect(limit).toBeDefined();
        expect(limit?.maximum).not.toBe(100);

        const info = await client.callTool({ name: 'probe_info', arguments: {} });
        expect(info.structuredContent).toEqual({ baseDir: '/srv/repos', timeoutMs: 1234 });

        const lazy = await client.callTool({ name: 'probe_lazy', arguments: { limit: 500 } });
        expect(lazy.isError).toBeFalsy();
        expect(lazy.structuredContent).toEqual({ limit: 500 });
      } finally {
        await client.close();
      }
    },
  );

  it.each(RUNTIMES)(
    'exits 1 under %s naming an invalid server variable set only in .env that a gate reads at import',
    async (runtime) => {
      const cwd = await workDir('ENVFILE_PROBE_READ_ONLY=true\nENVFILE_PROBE_TIMEOUT_MS=abc\n');

      const result = await runToExit(runtime, gateEntry, cwd);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('  - ENVFILE_PROBE_TIMEOUT_MS (timeoutMs): ');
    },
  );

  it.each(RUNTIMES)(
    'prints the banner under %s for that value when only setup() reads it',
    async (runtime) => {
      const cwd = await workDir('ENVFILE_PROBE_TIMEOUT_MS=abc\n');

      const result = await runToExit(runtime, setupEntry, cwd);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(BANNER);
      expect(result.stderr).toContain('  - ENVFILE_PROBE_TIMEOUT_MS (timeoutMs): ');
    },
  );

  it.each(RUNTIMES)(
    'parses no framework config at import under %s: an invalid .env framework variable fails at createApp() through the banner',
    async (runtime) => {
      const cwd = await workDir('ENVFILE_PROBE_READ_ONLY=true\nMCP_LOG_LEVEL=abc\n');

      const result = await runToExit(runtime, gateEntry, cwd);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(BANNER);
      expect(result.stderr).toContain('  - MCP_LOG_LEVEL (logLevel): ');
    },
  );

  it.each(RUNTIMES)(
    'stops startup under %s with the banner when .env is a directory, though a gate read it first',
    async (runtime) => {
      const cwd = await workDir('directory');

      const result = await runToExit(runtime, gateEntry, cwd);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(BANNER);
      expect(result.stderr).toContain('Failed to load .env from the working directory.');
    },
  );

  // POSIX permission bits; root reads a mode-000 file anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each(RUNTIMES)(
    'stops startup under %s with the banner when .env exists but cannot be read',
    async (runtime) => {
      const cwd = await workDir('ENVFILE_PROBE_READ_ONLY=true\n');
      await chmod(join(cwd, '.env'), 0o000);

      const result = await runToExit(runtime, gateEntry, cwd);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(BANNER);
      expect(result.stderr).toContain('Failed to load .env from the working directory.');
    },
  );
});
