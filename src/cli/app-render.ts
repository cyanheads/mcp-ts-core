/**
 * @fileoverview The `app-render` subcommand of the `mcp-ts-core` bin: renders an app
 * tool's view in the headless MCP Apps host, writes `report.json` and screenshots under
 * `--out`, and prints the report. Exits non-zero only on bad arguments or a setup failure
 * (see `renderAppTool`). Loaded on demand from `src/cli/init.ts`.
 * @module src/cli/app-render
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type {
  AppRenderStep,
  AppServerTarget,
  RenderAppToolOptions,
} from '../testing/apps/index.js';

export const APP_RENDER_USAGE = `
  Usage:
    mcp-ts-core app-render --tool <name> [--args '<json>'] [--click <selector>]...
                           [--out <dir>] [--browser <path>] [--theme light|dark]
                           [--width <px>] [--height <px>] [--stream-input] [--timeout <ms>]
                           (--url <url> | -- <command> [args...])

    Renders the tool's ui:// view in headless chrome-headless-shell inside the MCP Apps
    sandbox, clicks each --click selector in order (a screenshot after each), and prints
    the report. With --out, writes report.json and the screenshots there.

    Browser: --browser, else MCP_APPS_BROWSER_PATH, else the newest chrome-headless-shell
    in Puppeteer's cache. To install one there:
      npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer

  Example:
    mcp-ts-core app-render --tool my_app_tool --args '{"query":"probe"}' \\
      --click '#action-btn' --out ./app-run -- bun run dist/index.js
`;

/** Run the subcommand with the arguments after `app-render`. Returns the exit code. */
export async function appRender(argv: string[]): Promise<number> {
  let options: RenderAppToolOptions;
  try {
    const parsed = parseCli(argv);
    if (!parsed) {
      console.log(APP_RENDER_USAGE);
      return 0;
    }
    options = parsed;
  } catch (err) {
    console.error(`app-render: ${errorMessage(err)}\n${APP_RENDER_USAGE}`);
    return 1;
  }

  const { renderAppTool } = await import('../testing/apps/index.js');
  try {
    const report = await renderAppTool(options);
    const json = JSON.stringify(report, null, 2);
    if (options.outDir) {
      await mkdir(options.outDir, { recursive: true });
      await writeFile(path.join(options.outDir, 'report.json'), `${json}\n`);
    }
    console.log(json);
    return 0;
  } catch (err) {
    console.error(`app-render: ${errorMessage(err)}`);
    return 1;
  }
}

/** Options from the command line, or undefined for `--help`. */
function parseCli(argv: string[]): RenderAppToolOptions | undefined {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tool: { type: 'string' },
      args: { type: 'string' },
      click: { type: 'string', multiple: true },
      out: { type: 'string' },
      browser: { type: 'string' },
      url: { type: 'string' },
      theme: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      'stream-input': { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return;
  if (!values.tool) throw new Error('--tool is required.');

  let server: AppServerTarget;
  if (values.url) {
    if (positionals.length > 0)
      throw new Error('Pass either --url or a command after --, not both.');
    server = { url: values.url };
  } else {
    const [command, ...args] = positionals;
    if (!command) throw new Error('Pass the server as --url <url> or as a command after --.');
    server = { command, args, env: inheritedEnv() };
  }

  let args: unknown = {};
  if (values.args !== undefined) {
    try {
      args = JSON.parse(values.args);
    } catch (err) {
      throw new Error(`--args is not valid JSON: ${errorMessage(err)}`);
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('--args must be a JSON object.');
  }
  if (values.theme !== undefined && values.theme !== 'light' && values.theme !== 'dark') {
    throw new Error('--theme must be light or dark.');
  }
  const steps: AppRenderStep[] = (values.click ?? []).flatMap((selector, i) => [
    { click: selector },
    { screenshot: `click-${i + 1}` },
  ]);
  const width = optionalNumber(values.width, '--width');
  const height = optionalNumber(values.height, '--height');
  const timeoutMs = optionalNumber(values.timeout, '--timeout');
  return {
    server,
    tool: values.tool,
    arguments: args as Record<string, unknown>,
    steps,
    host: {
      ...(values.theme && { theme: values.theme }),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
      ...(values['stream-input'] && { streamInput: true }),
    },
    ...(values.out && { outDir: path.resolve(values.out) }),
    ...(values.browser && { browserPath: values.browser }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}

function optionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive number.`);
  return parsed;
}

/** This process's environment, passed to a stdio server so its configuration reaches it. */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
