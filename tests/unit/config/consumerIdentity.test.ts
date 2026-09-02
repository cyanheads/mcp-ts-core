/**
 * @fileoverview Config-level tests for the two values a consumer owns but the
 * framework derives: the served package's identity and the log directory. Both
 * are anchored on the application root, so each case builds a real project on
 * disk, points the entry module at it, and launches from somewhere else.
 * @module tests/unit/config/consumerIdentity
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAppRootCache } from '@/config/appRoot.js';
import { parseConfig } from '@/config/index.js';

let tempRoot: string;
const originalArgv1 = process.argv[1] ?? '';
const originalCwd = process.cwd();

/** Environment overrides that keep an ambient `.env` out of the assertions. */
const CLEAN_ENV = {
  LOGS_DIR: undefined,
  MCP_SERVER_DESCRIPTION: undefined,
  MCP_SERVER_NAME: undefined,
  MCP_SERVER_VERSION: undefined,
  OTEL_SERVICE_NAME: undefined,
  OTEL_SERVICE_VERSION: undefined,
  PACKAGE_KEYWORDS: undefined,
  PACKAGE_NAME: undefined,
  PACKAGE_VERSION: undefined,
} satisfies Record<string, string | undefined>;

function makePackage(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

/** Builds a served package with its built entry point, and returns its root. */
function makeServer(name: string, manifest: Record<string, unknown>): string {
  const dir = makePackage(join(tempRoot, name), manifest);
  const entry = join(dir, 'dist', 'index.js');
  mkdirSync(resolve(entry, '..'), { recursive: true });
  writeFileSync(entry, '');
  process.argv[1] = entry;
  return dir;
}

beforeEach(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-consumer-identity-')));
  resetAppRootCache();
});

afterEach(() => {
  process.argv[1] = originalArgv1;
  process.chdir(originalCwd);
  resetAppRootCache();
  rmSync(tempRoot, { force: true, recursive: true });
});

describe('served package identity', () => {
  it('reports the served package, not the project sitting in the launching directory', () => {
    makeServer('served-server', {
      name: 'served-server',
      version: '2.10.4',
      description: 'The served server.',
      keywords: ['mcp', 'served'],
    });
    process.chdir(
      makePackage(join(tempRoot, 'clients-open-project'), {
        name: 'my-unrelated-app',
        version: '9.9.9-totally-not-the-server',
        description: "Someone else's app.",
        keywords: ['unrelated'],
      }),
    );

    const parsed = parseConfig(CLEAN_ENV);

    expect(parsed.pkg.version).toBe('2.10.4');
    expect(parsed.mcpServerVersion).toBe('2.10.4');
    expect(parsed.mcpServerName).toBe('served-server');
    expect(parsed.mcpServerDescription).toBe('The served server.');
    expect(parsed.mcpServerKeywords).toEqual(['mcp', 'served']);
    expect(parsed.openTelemetry.serviceVersion).toBe('2.10.4');
    expect(parsed.openTelemetry.serviceName).toBe('served-server');
  });

  it('falls back to the framework identity when the launching directory has no manifest either', () => {
    process.argv[1] = join(tempRoot, 'loose', 'index.js');
    mkdirSync(join(tempRoot, 'loose'), { recursive: true });
    writeFileSync(process.argv[1], '');
    process.chdir(tempRoot);

    const parsed = parseConfig(CLEAN_ENV);

    expect(parsed.pkg.name).toBe('@cyanheads/mcp-ts-core');
  });

  it('keeps environment overrides ahead of the resolved manifest', () => {
    makeServer('served-server', { name: 'served-server', version: '2.10.4' });

    const parsed = parseConfig({
      ...CLEAN_ENV,
      MCP_SERVER_VERSION: '0.0.1-override',
      PACKAGE_NAME: 'env-named-server',
    });

    expect(parsed.pkg.name).toBe('env-named-server');
    expect(parsed.mcpServerVersion).toBe('0.0.1-override');
  });
});

describe('logsPath anchoring', () => {
  it('resolves a relative path under the application root', () => {
    const app = makeServer('served-server', { name: 'served-server', version: '1.0.0' });
    process.chdir(makePackage(join(tempRoot, 'elsewhere'), { name: 'elsewhere', version: '1' }));

    expect(parseConfig(CLEAN_ENV).logsPath).toBe(join(app, 'logs'));
  });

  it('resolves a relative LOGS_DIR under the application root', () => {
    const app = makeServer('served-server', { name: 'served-server', version: '1.0.0' });

    expect(parseConfig({ ...CLEAN_ENV, LOGS_DIR: 'var/log' }).logsPath).toBe(
      join(app, 'var', 'log'),
    );
  });

  it('honors an absolute LOGS_DIR verbatim', () => {
    makeServer('served-server', { name: 'served-server', version: '1.0.0' });
    const absolute = join(tempRoot, 'absolute-logs');

    expect(parseConfig({ ...CLEAN_ENV, LOGS_DIR: absolute }).logsPath).toBe(absolute);
  });

  it('never writes a dependency-installed framework’s logs inside node_modules', () => {
    // The consumer topology the framework actually ships in: the application at
    // the project root, this package installed beneath it.
    const app = makeServer('consumer-server', { name: 'consumer-server', version: '1.0.0' });
    makePackage(join(app, 'node_modules', '@cyanheads', 'mcp-ts-core'), {
      name: '@cyanheads/mcp-ts-core',
      version: '0.0.0-installed',
    });

    const logsPath = parseConfig(CLEAN_ENV).logsPath;

    expect(logsPath).toBe(join(app, 'logs'));
    expect(logsPath).not.toContain('node_modules');
  });

  it('falls back to the working directory when no manifest is reachable', () => {
    process.argv[1] = '';
    const workdir = join(tempRoot, 'no-manifest-anywhere');
    mkdirSync(workdir, { recursive: true });
    process.chdir(workdir);

    expect(parseConfig(CLEAN_ENV).logsPath).toBe(join(workdir, 'logs'));
  });
});
