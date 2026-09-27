/**
 * @fileoverview Stage invariants for the framework and scaffold Dockerfiles.
 * Everything that can run JavaScript while the image builds — a `bun install`
 * whose `bunfig.toml` starts the Socket scanner as a Bun program, and the OTel
 * step's `scripts/install-otel.ts` — runs in the `deps` stage on
 * `$BUILDPLATFORM`, cross-installing for the target with `--os`/`--cpu`. The
 * production stage copies `node_modules` from it and runs only shell `RUN`s, so
 * the non-native leg of a multi-arch build never runs Bun under QEMU (#575).
 * The RUN steps are executed here with a recording `bun` on `PATH`, so the
 * assertions cover the flags each install actually receives (#578).
 * @module tests/unit/packaging/dockerfile.test
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** Instructions of the stage named `name`, from its `FROM` to the next `FROM` or EOF. */
function stage(path: string, name: string): string[] {
  const all = instructions(path);
  const start = all.findIndex((line) => new RegExp(`^FROM\\s.+\\sAS\\s+${name}$`, 'i').test(line));
  expect(start, `${path} has a ${name} stage`).toBeGreaterThanOrEqual(0);
  const end = all.findIndex((line, i) => i > start && line.startsWith('FROM '));
  return all.slice(start, end === -1 ? undefined : end);
}

/** The single `RUN` of a stage matching `pattern`. */
function runStep(lines: string[], pattern: RegExp): string {
  const matches = lines.filter((line) => line.startsWith('RUN ') && pattern.test(line));
  expect(matches, `one RUN matches ${pattern}`).toHaveLength(1);
  return matches[0] ?? '';
}

/** Index of the first `RUN` that installs packages. */
const firstInstall = (lines: string[]): number =>
  lines.findIndex(
    (line) => line.startsWith('RUN ') && /\bbun (install|add)\b|install-otel/.test(line),
  );

/** A command word `bun`/`bunx`, as opposed to `bun:bun`, `/root/.bun/`, or `USER bun`. */
const BUN_COMMAND = /(?:^|[\s"'[;&|(])bunx?(?=[\s"',\]])/;

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface StepResult {
  /** One entry per `bun` invocation, its arguments space-joined. */
  bunCalls: string[];
  status: number | null;
  stderr: string;
}

/**
 * Runs a `RUN` instruction's shell command in a scratch directory, with a `bun`
 * on `PATH` that records its arguments and succeeds. `RUN` flags (`--mount=…`)
 * are BuildKit's, not the shell's, and are dropped.
 */
function execute(run: string, dir: string, env: Record<string, string>): StepResult {
  const bin = join(dir, '.bin');
  const calls = join(dir, '.bun-calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  rmSync(calls, { force: true });

  const command = run.replace(/^RUN\s+(?:--[\w-]+=\S+\s+)*/, '');
  const result = spawnSync('sh', ['-c', command], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
  });
  return {
    bunCalls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
    status: result.status,
    stderr: result.stderr,
  };
}

describe.each(['Dockerfile', 'templates/Dockerfile'])('%s', (relativePath) => {
  const path = join(ROOT, relativePath);
  const bunfigPath = join(
    ROOT,
    relativePath === 'Dockerfile' ? 'bunfig.toml' : 'templates/_bunfig.toml',
  );
  const scanner = readFileSync(bunfigPath, 'utf8').match(/^scanner\s*=\s*"([^"]+)"/m)?.[1];

  describe('deps stage', () => {
    const deps = () => stage(path, 'deps');
    const cpuMapping = () => runStep(deps(), /\bTARGETARCH\b/);
    const productionInstall = () => runStep(deps(), /\bbun install\b/);
    const otelStep = () => runStep(deps(), /"\$OTEL_ENABLED"/);

    /** Runs the TARGETARCH mapping, then `step`, as BuildKit would for that target. */
    function forTarget(targetArch: string, step: string, env: Record<string, string> = {}) {
      scratch ??= mkdtempSync(join(tmpdir(), 'dockerfile-deps-'));
      const mapped = execute(cpuMapping(), scratch, { TARGETARCH: targetArch });
      expect(mapped.status, mapped.stderr).toBe(0);
      return execute(step, scratch, { TARGETOS: 'linux', TARGETARCH: targetArch, ...env });
    }

    it('runs on the build platform from a clean image, not FROM build', () => {
      const [from] = deps();
      expect(from).toMatch(/^FROM --platform=\$BUILDPLATFORM oven\/bun:\S+ AS deps$/);
      // The build stage's node_modules holds devDependencies; a production tree needs a clean one.
      expect(from).not.toMatch(/^FROM (?:--platform=\S+ )?build\b/);
      expect(deps()).toEqual(expect.arrayContaining(['ARG TARGETOS', 'ARG TARGETARCH']));
    });

    it('copies bunfig.toml and seeds its security scanner before the first install', () => {
      const lines = deps();
      const bunfigCopy = lines.findIndex(
        (line) =>
          line.startsWith('COPY ') && !line.includes('--from=') && /\bbunfig\.toml\b/.test(line),
      );
      // A production-filtered install cannot install the devDependency scanner itself and aborts.
      const seed = lines.indexOf(
        `COPY --from=build /usr/src/app/node_modules/${scanner} ./node_modules/${scanner}`,
      );

      expect(scanner).toBeDefined();
      expect(bunfigCopy).toBeGreaterThan(0);
      expect(seed).toBeGreaterThan(0);
      expect(bunfigCopy).toBeLessThan(firstInstall(lines));
      expect(seed).toBeLessThan(firstInstall(lines));
    });

    it.each([
      ['amd64', 'x64'],
      ['arm64', 'arm64'],
    ])('cross-installs production dependencies for TARGETARCH=%s as --cpu=%s', (arch, cpu) => {
      const { bunCalls, status, stderr } = forTarget(arch, productionInstall());

      expect(status, stderr).toBe(0);
      expect(bunCalls).toEqual([
        `install --production --omit=peer --frozen-lockfile --ignore-scripts --os=linux --cpu=${cpu}`,
      ]);
    });

    it.each(['386', 's390x', ''])('fails the build for TARGETARCH=%j, naming the value', (arch) => {
      scratch = mkdtempSync(join(tmpdir(), 'dockerfile-deps-'));
      const { status, stderr } = execute(cpuMapping(), scratch, { TARGETARCH: arch });

      expect(status).not.toBe(0);
      expect(stderr).toContain(`TARGETARCH '${arch}'`);
    });

    it.each([
      ['amd64', 'x64'],
      ['arm64', 'arm64'],
    ])(
      'runs scripts/install-otel.ts with the target flags when OTEL_ENABLED=true (%s)',
      (arch, cpu) => {
        const { bunCalls, status, stderr } = forTarget(arch, otelStep(), { OTEL_ENABLED: 'true' });

        expect(status, stderr).toBe(0);
        expect(bunCalls).toEqual([`scripts/install-otel.ts --os=linux --cpu=${cpu}`]);
      },
    );

    it('never runs the OTel step when OTEL_ENABLED=false', () => {
      const { bunCalls, status } = forTarget('amd64', otelStep(), { OTEL_ENABLED: 'false' });

      expect(status).toBe(0);
      expect(bunCalls).toEqual([]);
      expect(deps()).toContain('ARG OTEL_ENABLED=true');
    });

    it('copies the OTel script after the production install, so its layer stays cached', () => {
      const lines = deps();
      const copy = lines.indexOf('COPY scripts/install-otel.ts ./scripts/');

      expect(copy).toBeGreaterThan(lines.indexOf(productionInstall()));
      expect(copy).toBeLessThan(lines.indexOf(otelStep()));
    });

    it('removes the seeded scanner after the last install, so the runtime image carries none', () => {
      const lines = deps();
      const removal = runStep(lines, /\brm\b/);
      expect(lines.indexOf(removal)).toBeGreaterThan(lines.indexOf(otelStep()));
      expect(lines.slice(lines.indexOf(removal) + 1).some((line) => line.startsWith('RUN '))).toBe(
        false,
      );

      scratch = mkdtempSync(join(tmpdir(), 'dockerfile-deps-'));
      const seeded = join(scratch, 'node_modules', String(scanner));
      mkdirSync(seeded, { recursive: true });
      writeFileSync(join(seeded, 'package.json'), '{}\n');
      mkdirSync(join(scratch, 'node_modules', 'zod'));
      const { status, stderr } = execute(removal, scratch, {});

      expect(status, stderr).toBe(0);
      expect(existsSync(seeded)).toBe(false);
      expect(existsSync(join(scratch, 'node_modules', 'zod'))).toBe(true);
    });
  });

  describe('production stage', () => {
    const production = () => stage(path, 'production');

    it('invokes bun only from HEALTHCHECK and CMD, never while building', () => {
      const withBun = production().filter((line) => BUN_COMMAND.test(line.replace(/^\S+/, '')));
      expect(withBun.map((line) => line.split(/\s/, 1)[0])).toEqual(['HEALTHCHECK', 'CMD']);
    });

    it('copies the manifest, the deps stage node_modules, and the build output', () => {
      expect(production()).toEqual(
        expect.arrayContaining([
          'COPY package.json ./',
          'COPY --from=deps /usr/src/app/node_modules ./node_modules',
          'COPY --from=build /usr/src/app/dist ./dist',
        ]),
      );
    });
  });

  it('names no OpenTelemetry package and runs bun -e only in HEALTHCHECK', () => {
    const lines = instructions(path);
    expect(lines.filter((line) => /@opentelemetry\/|@hono\/otel/.test(line))).toEqual([]);
    expect(
      lines.filter((line) => line.includes('bun -e')).map((line) => line.split(/\s/, 1)[0]),
    ).toEqual(['HEALTHCHECK']);
  });

  it('sets no environment variable the framework never reads', () => {
    expect(readFileSync(path, 'utf8')).not.toContain('MCP_FORCE_CONSOLE_LOGGING');
  });
});
