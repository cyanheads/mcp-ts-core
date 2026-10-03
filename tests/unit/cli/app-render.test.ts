/**
 * @fileoverview Tests for the `app-render` CLI subcommand: argument parsing, the options
 * it hands `renderAppTool`, `report.json` under `--out`, exit codes, and the dispatch from
 * the `mcp-ts-core` bin. `renderAppTool` is replaced; no browser runs.
 * @module tests/unit/cli/app-render.test
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_RENDER_USAGE, appRender } from '@/cli/app-render.js';
import type { AppRenderReport, RenderAppToolOptions } from '@/testing/apps/index.js';
import { configurationError } from '@/types-global/errors.js';

const renderAppTool = vi.hoisted(() =>
  vi.fn<(options: RenderAppToolOptions) => Promise<AppRenderReport>>(),
);
vi.mock('@/testing/apps/index.js', () => ({ renderAppTool }));

const REPORT = {
  tool: 'my_app_tool',
  initialized: true,
  text: 'rendered',
} as unknown as AppRenderReport;

describe('app-render CLI', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let tempDirs: string[];

  beforeEach(() => {
    renderAppTool.mockReset();
    renderAppTool.mockResolvedValue(REPORT);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDirs = [];
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  const logged = () => logSpy.mock.calls.flat().map(String).join('\n');
  const errored = () => errorSpy.mock.calls.flat().map(String).join('\n');
  const optionsPassed = () => renderAppTool.mock.calls[0]?.[0] as RenderAppToolOptions;

  it.each([['--help'], ['-h']])(
    'prints usage and exits 0 for %s without rendering',
    async (flag) => {
      await expect(appRender([flag])).resolves.toBe(0);
      expect(logged()).toContain('mcp-ts-core app-render --tool <name>');
      expect(logged()).toContain('npx @puppeteer/browsers install chrome-headless-shell@stable');
      expect(renderAppTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    [['--', 'bun', 'run', 'dist/index.js'], '--tool is required.'],
    [['--tool', 't'], 'Pass the server as --url <url> or as a command after --.'],
    [
      ['--tool', 't', '--url', 'http://127.0.0.1:1/mcp', '--', 'bun', 'x.js'],
      'Pass either --url or a command after --, not both.',
    ],
    [['--tool', 't', '--args', '[1,2]', '--', 'bun'], '--args must be a JSON object.'],
    [['--tool', 't', '--args', 'null', '--', 'bun'], '--args must be a JSON object.'],
    [['--tool', 't', '--args', '"text"', '--', 'bun'], '--args must be a JSON object.'],
    [['--tool', 't', '--args', '{not json', '--', 'bun'], '--args is not valid JSON: '],
    [['--tool', 't', '--theme', 'sepia', '--', 'bun'], '--theme must be light or dark.'],
    [['--tool', 't', '--width', '0', '--', 'bun'], '--width must be a positive number.'],
    [['--tool', 't', '--height=-5', '--', 'bun'], '--height must be a positive number.'],
    [['--tool', 't', '--timeout', 'soon', '--', 'bun'], '--timeout must be a positive number.'],
    [['--tool', 't', '--width', 'Infinity', '--', 'bun'], '--width must be a positive number.'],
    [['--tool', 't', '--bogus', '--', 'bun'], '--bogus'],
  ])('exits 1 with usage for %j', async (argv, message) => {
    await expect(appRender(argv)).resolves.toBe(1);
    expect(errored()).toContain('app-render: ');
    expect(errored()).toContain(message);
    expect(errored()).toContain('Usage:');
    expect(renderAppTool).not.toHaveBeenCalled();
  });

  it('runs a stdio command with the inherited environment and default options', async () => {
    vi.stubEnv('APP_RENDER_TEST_MARKER', 'present');
    try {
      await expect(
        appRender(['--tool', 'my_app_tool', '--', 'bun', 'run', 'dist/index.js']),
      ).resolves.toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
    const options = optionsPassed();
    expect(options).toEqual({
      server: { command: 'bun', args: ['run', 'dist/index.js'], env: expect.any(Object) },
      tool: 'my_app_tool',
      arguments: {},
      steps: [],
      host: {},
    });
    const env = (options.server as { env: Record<string, string> }).env;
    expect(env.APP_RENDER_TEST_MARKER).toBe('present');
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
    expect(JSON.parse(logged())).toEqual(REPORT);
  });

  it('maps every option and expands each --click into a click and a screenshot', async () => {
    await expect(
      appRender([
        '--tool',
        'my_app_tool',
        '--url',
        'http://127.0.0.1:3010/mcp',
        '--args',
        '{"query":"probe","limit":3}',
        '--click',
        '#first',
        '--click',
        '.second button',
        '--theme',
        'dark',
        '--width',
        '480',
        '--height',
        '320.5',
        '--stream-input',
        '--timeout',
        '2500',
        '--browser',
        '/opt/shell/chrome-headless-shell',
      ]),
    ).resolves.toBe(0);
    expect(optionsPassed()).toEqual({
      server: { url: 'http://127.0.0.1:3010/mcp' },
      tool: 'my_app_tool',
      arguments: { query: 'probe', limit: 3 },
      steps: [
        { click: '#first' },
        { screenshot: 'click-1' },
        { click: '.second button' },
        { screenshot: 'click-2' },
      ],
      host: { theme: 'dark', width: 480, height: 320.5, streamInput: true },
      browserPath: '/opt/shell/chrome-headless-shell',
      timeoutMs: 2500,
    });
  });

  it('accepts the light theme', async () => {
    await appRender(['--tool', 't', '--theme', 'light', '--url', 'http://127.0.0.1:1/mcp']);
    expect(optionsPassed().host).toEqual({ theme: 'light' });
  });

  it('writes report.json under --out, resolved to an absolute path, and prints the report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'app-render-cli-'));
    tempDirs.push(root);
    const out = path.join(root, 'nested', 'run');
    const relative = path.relative(process.cwd(), out);

    await expect(appRender(['--tool', 't', '--out', relative, '--', 'bun'])).resolves.toBe(0);
    expect(optionsPassed().outDir).toBe(path.resolve(relative));
    const written = await readFile(path.join(out, 'report.json'), 'utf8');
    expect(written.endsWith('}\n')).toBe(true);
    expect(JSON.parse(written)).toEqual(REPORT);
    expect(logged()).toBe(JSON.stringify(REPORT, null, 2));
  });

  it('writes no report.json without --out', async () => {
    const cwdReport = path.join(process.cwd(), 'report.json');
    const existedBefore = existsSync(cwdReport);
    await expect(appRender(['--tool', 't', '--', 'bun'])).resolves.toBe(0);
    expect(existsSync(cwdReport)).toBe(existedBefore);
  });

  it('exits 1 and prints the error when setup fails', async () => {
    renderAppTool.mockRejectedValue(
      configurationError('No browser found: install chrome-headless-shell.'),
    );
    await expect(appRender(['--tool', 't', '--', 'bun'])).resolves.toBe(1);
    expect(errored()).toBe('app-render: No browser found: install chrome-headless-shell.');
    expect(logged()).toBe('');
  });

  it('prints a thrown non-Error value as text', async () => {
    renderAppTool.mockRejectedValue('plain failure');
    await expect(appRender(['--tool', 't', '--', 'bun'])).resolves.toBe(1);
    expect(errored()).toBe('app-render: plain failure');
  });
});

describe('mcp-ts-core bin dispatch', () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalArgv = [...process.argv];
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('hands the arguments after app-render to the subcommand and sets its exit code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    process.argv = ['node', 'mcp-ts-core', 'app-render', '--help'];
    await import('@/cli/init.js');
    expect(process.exitCode).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain(APP_RENDER_USAGE.trim());
  });

  it.each([['--help'], ['-h']])(
    'prints the top-level usage, listing app-render, and exits 0 for %s',
    async (flag) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`EXIT:${code ?? 0}`);
      }) as never);
      vi.resetModules();
      process.argv = ['node', 'mcp-ts-core', flag];
      await expect(import('@/cli/init.js')).rejects.toThrow('EXIT:0');
      expect(log.mock.calls.flat().join('\n')).toContain('mcp-ts-core app-render');
    },
  );
});
