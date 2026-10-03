/**
 * @fileoverview Tests devcheck's gate predicate for the Packaging step (issue
 * #343). The step used to run only when `manifest.json` or a plugin manifest
 * existed, so a project carrying just an `.mcpbignore` — the framework itself —
 * never had its bundle-content guards checked, and three unanchored dev-dir
 * patterns sat undetected behind a green `devcheck`. `server.json` gates the
 * step in its own right, for the npm launch-shape check (#622).
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location
 * (`scripts/..`), not the cwd, so the faithful reproduction copies both
 * scripts into a temp dir and runs the gate there, exactly as a scaffolded
 * server would.
 *
 * Their one package import is the `.mcpbignore` guard's `import('ignore')`,
 * which skips the guard when the package cannot load. The scaffold links the
 * repository's own copy into its `node_modules`: without that directory Bun
 * auto-installs `ignore` from the registry, and a failed install turned the
 * guard off, so the unanchored-pattern case failed whenever the network did.
 *
 * @module tests/unit/scripts/devcheck-packaging-gate.test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

/** A scaffold carrying devcheck, the packaging linter it shells out to, and the linter's `ignore`. */
function makeScaffold(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'devcheck-packaging-gate-'));
  mkdirSync(resolve(dir, 'scripts'));
  mkdirSync(resolve(dir, 'src'));
  mkdirSync(resolve(dir, 'node_modules'));
  for (const script of ['devcheck.ts', 'lint-packaging.ts']) {
    copyFileSync(resolve(SCRIPTS_DIR, script), resolve(dir, 'scripts', script));
  }
  symlinkSync(
    resolve(REPO_ROOT, 'node_modules', 'ignore'),
    resolve(dir, 'node_modules', 'ignore'),
    'dir',
  );
  writeFileSync(resolve(dir, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  writeFileSync(resolve(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  return dir;
}

function runPackagingCheck(cwd: string): { code: number; out: string } {
  const result = spawnSync(
    'bun',
    ['run', 'scripts/devcheck.ts', '--only', 'Packaging', '--no-fix'],
    { cwd, encoding: 'utf-8' },
  );
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/**
 * The step's own summary row, isolated from the `--only` skip notices that also
 * name it. Colour codes are stripped so the row matches on its leading label.
 */
function packagingLine(out: string): string {
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '');
  return plain.split('\n').find((line) => line.startsWith('Packaging')) ?? '';
}

describe('devcheck Packaging gate (#343)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips cleanly with no manifest, plugin manifest, .mcpbignore, README, Dockerfile, or server.json', () => {
    const { code, out } = runPackagingCheck(dir);
    expect(code).toBe(0);
    expect(packagingLine(out)).toContain('SKIPPED');
  });

  describe('server.json as the only packaging input (#622)', () => {
    it('runs on a server.json alone and fails a streamable-http entry that starts stdio', () => {
      writeFileSync(
        resolve(dir, 'server.json'),
        `${JSON.stringify({
          packages: [
            {
              registryType: 'npm',
              identifier: 'scaffold',
              version: '0.0.0',
              packageArguments: [
                { type: 'positional', value: 'run' },
                { type: 'positional', value: 'start:http' },
              ],
              transport: { type: 'streamable-http', url: 'http://localhost:3010/mcp' },
            },
          ],
        })}\n`,
      );
      const { code, out } = runPackagingCheck(dir);
      expect(packagingLine(out)).not.toContain('SKIPPED');
      expect(code).not.toBe(0);
      expect(out).toContain('server.json packages[0]');
      expect(out).toContain('MCP_TRANSPORT_TYPE');
      expect(out).toContain('"run" "start:http"');
    });

    it('runs on the scaffold template server.json alone and passes it', () => {
      copyFileSync(resolve(REPO_ROOT, 'templates', 'server.json'), resolve(dir, 'server.json'));
      const { code, out } = runPackagingCheck(dir);
      expect(packagingLine(out)).not.toContain('SKIPPED');
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });
  });

  describe('README as the only packaging input (#418)', () => {
    /** Writes a README carrying a static version badge; the scaffold's package.json is 0.0.0. */
    const writeReadme = (version: string): void => {
      writeFileSync(
        resolve(dir, 'README.md'),
        `# scaffold\n\n[![Version](https://img.shields.io/badge/Version-${version}-blue.svg)](./CHANGELOG.md)\n`,
      );
    };

    it('runs on a README alone and passes a badge that matches package.json', () => {
      writeReadme('0.0.0');
      const { code, out } = runPackagingCheck(dir);
      expect(packagingLine(out)).not.toContain('SKIPPED');
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });

    it('fails a version badge left behind by a release', () => {
      writeReadme('0.0.1');
      const { code, out } = runPackagingCheck(dir);
      expect(code).not.toBe(0);
      expect(out).toContain('README.md version badge');
      expect(out).toContain('"0.0.1"');
      expect(out).toContain('0.0.0');
    });

    it('runs on a README carrying no version badge and passes it', () => {
      writeFileSync(resolve(dir, 'README.md'), '# scaffold\n\nSome prose.\n');
      const { code, out } = runPackagingCheck(dir);
      expect(packagingLine(out)).not.toContain('SKIPPED');
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });
  });

  it('runs on an .mcpbignore alone and fails an unanchored dev-dir pattern', () => {
    writeFileSync(resolve(dir, '.mcpbignore'), 'framework-skills/\n');
    const { code, out } = runPackagingCheck(dir);
    expect(code).not.toBe(0);
    expect(packagingLine(out)).not.toContain('SKIPPED');
    expect(out).toContain('unanchored pattern');
  });

  it('passes on an .mcpbignore whose dev-dir patterns are root-anchored', () => {
    writeFileSync(resolve(dir, '.mcpbignore'), '/framework-skills/\n/.claude/\n/.agents/\n');
    const { code, out } = runPackagingCheck(dir);
    expect(code).toBe(0);
    expect(packagingLine(out)).not.toContain('SKIPPED');
    expect(out).toContain('Packaging alignment OK.');
  });

  it('runs on a Dockerfile alone and fails a build stage off the build platform', () => {
    writeFileSync(resolve(dir, 'Dockerfile'), 'FROM oven/bun:1.4.2\nRUN bun run build\n');
    const { code, out } = runPackagingCheck(dir);
    expect(code).not.toBe(0);
    expect(packagingLine(out)).not.toContain('SKIPPED');
    expect(out).toContain('--platform=$BUILDPLATFORM');
  });

  it('fails a production stage that installs after copying bunfig.toml (#575)', () => {
    writeFileSync(
      resolve(dir, 'Dockerfile'),
      [
        'FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build',
        'COPY . .',
        'RUN bun install && bun run build',
        'FROM oven/bun:1.4.2-slim AS production',
        'COPY package.json bun.lock bunfig.toml ./',
        'RUN bun install --production --omit=peer --frozen-lockfile --ignore-scripts',
        'COPY --from=build /app/dist ./dist',
        'CMD ["bun", "run", "dist/index.js"]',
      ].join('\n'),
    );
    const { code, out } = runPackagingCheck(dir);
    expect(code).not.toBe(0);
    expect(out).toContain('Dockerfile:4 "FROM oven/bun:1.4.2-slim AS production"');
    expect(out).toContain('Dockerfile:6 runs `bun install` after bunfig.toml');
  });

  describe('plugin manifest as the only packaging input (#393)', () => {
    /** Writes `.claude-plugin/plugin.json`; the scaffold's package.json is 0.0.0. */
    const writePlugin = (version: string): void => {
      mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        resolve(dir, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({
          name: 'scaffold',
          version,
          description: 'A scaffolded server.',
          mcpServers: { scaffold: { command: 'npx', args: ['-y', 'scaffold'] } },
        })}\n`,
      );
    };

    it('passes when the plugin version matches package.json', () => {
      writePlugin('0.0.0');
      const { code, out } = runPackagingCheck(dir);
      expect(packagingLine(out)).not.toContain('SKIPPED');
      expect(out).toContain('Packaging alignment OK.');
      expect(code).toBe(0);
    });

    it('fails a plugin version left behind by a release', () => {
      writePlugin('0.0.1');
      const { code, out } = runPackagingCheck(dir);
      expect(code).not.toBe(0);
      expect(out).toContain('.claude-plugin/plugin.json');
      expect(out).toContain('"0.0.1"');
      expect(out).toContain('0.0.0');
    });
  });
});
