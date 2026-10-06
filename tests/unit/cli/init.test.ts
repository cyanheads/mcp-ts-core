/**
 * @fileoverview Unit tests for the CLI scaffold entry point.
 * @module tests/unit/cli/init.test
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Env files a server must keep out of git and out of the image build context. */
const ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.test',
  '.env.development',
  '.env.production.local',
];

/** The template shapes devcheck's Tracked Secrets step treats as safe to track. */
const ENV_TEMPLATES = ['.env.example', '.env.template', '.env.sample'];

/** Each name at the root and one directory down. */
const atAnyDepth = (names: string[], dir: string): string[] => [
  ...names,
  ...names.map((name) => `${dir}/${name}`),
];

/** The subset of `paths` the ignore rules of the repository at `repo` exclude, in input order. */
function ignoredPaths(repo: string, paths: string[]): string[] {
  // `--no-index` checks the rules even for tracked paths, which git otherwise never reports.
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: repo,
    encoding: 'utf8',
    input: paths.join('\n'),
  });
  expect([0, 1], result.stderr).toContain(result.status);
  return result.stdout.split('\n').filter(Boolean);
}

/** The `.env`-prefixed lines of a `.dockerignore`. */
const dockerignoreEnvLines = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('.env'));

interface CodeqlWorkflow {
  jobs: Record<
    string,
    {
      name: string;
      permissions: Record<string, string>;
      'runs-on': string;
      steps: { uses?: string; with?: Record<string, unknown> }[];
      strategy?: unknown;
      'timeout-minutes': number;
    }
  >;
  on: unknown;
  permissions: Record<string, string>;
}

describe('CLI init command', () => {
  let originalArgv: string[];
  let originalCwd: string;
  let tempDirs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    originalArgv = [...process.argv];
    originalCwd = process.cwd();
    tempDirs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    for (const dir of tempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cli-test-'));
    tempDirs.push(dir);
    return dir;
  }

  async function runCli(args: string[]): Promise<void> {
    vi.resetModules();
    process.argv = ['node', 'mcp-ts-core', ...args];
    await import('@/cli/init.js');
  }

  function getLoggedOutput(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls
      .flat()
      .map((value: unknown) => String(value))
      .join('\n');
  }

  it('prints usage and exits successfully for --help', async () => {
    await expect(runCli(['--help'])).rejects.toThrow('EXIT:0');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('@cyanheads/mcp-ts-core');
    expect(output).toContain('Usage:');
    expect(output).toContain('mcp-ts-core init [name]');
  });

  it('prints usage and exits with failure for an unknown subcommand', async () => {
    await expect(runCli(['unknown-command'])).rejects.toThrow('EXIT:1');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Usage:');
    expect(output).toContain('mcp-ts-core --help');
  });

  it('prints usage and exits successfully for "init --help" without scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '--help'])).rejects.toThrow('EXIT:0');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Usage:');
    expect(output).toContain('mcp-ts-core init [name]');
    expect(existsSync(join(tempRoot, 'package.json'))).toBe(false);
  });

  it('prints usage and exits successfully for "init -h" without scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '-h'])).rejects.toThrow('EXIT:0');

    expect(existsSync(join(tempRoot, 'package.json'))).toBe(false);
  });

  it('rejects unknown flags on init without scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '--bogus'])).rejects.toThrow('EXIT:1');

    expect(getLoggedOutput(errorSpy)).toContain('unknown flag(s): --bogus');
    expect(existsSync(join(tempRoot, 'package.json'))).toBe(false);
  });

  it('rejects invalid project names before scaffolding', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await expect(runCli(['init', '../bad-project'])).rejects.toThrow('EXIT:1');

    expect(getLoggedOutput(errorSpy)).toContain('invalid project name "../bad-project"');
    expect(existsSync(join(tempRoot, '../bad-project'))).toBe(false);
  });

  it('scaffolds a named project with templates, scripts, and external skills', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const dest = join(tempRoot, 'demo-server');
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
    expect(existsSync(join(dest, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dest, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'build.ts'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'devcheck.ts'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'check-framework-antipatterns.ts'))).toBe(true);
    expect(existsSync(join(dest, 'scripts', 'check-dependency-specifiers.ts'))).toBe(true);
    // The scaffold Dockerfile's OTel step runs it; a scaffold without it fails the image build.
    expect(existsSync(join(dest, 'scripts', 'install-otel.ts'))).toBe(true);
    expect(readFileSync(join(dest, 'Dockerfile'), 'utf-8')).toContain('scripts/install-otel.ts');
    // Likewise the deps stage's musl prune, which runs after the OTel step.
    expect(existsSync(join(dest, 'scripts', 'prune-musl-packages.ts'))).toBe(true);
    expect(readFileSync(join(dest, 'Dockerfile'), 'utf-8')).toContain(
      'scripts/prune-musl-packages.ts',
    );
    expect(existsSync(join(dest, 'framework-skills', 'add-tool', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'framework-skills', 'README.md'))).toBe(false);
    // Plugin hosts auto-load a root skills/ — the scaffold must never create one.
    expect(existsSync(join(dest, 'skills'))).toBe(false);
    expect(existsSync(join(dest, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dest, 'tsconfig.build.json'))).toBe(true);
    expect(existsSync(join(dest, 'biome.json'))).toBe(true);
    expect(existsSync(join(dest, '.gitignore'))).toBe(true);
    expect(existsSync(join(dest, '.dockerignore'))).toBe(true);
    expect(existsSync(join(dest, 'bunfig.toml'))).toBe(true);
    expect(existsSync(join(dest, 'tests', 'smoke', 'definitions.smoke.test.ts'))).toBe(true);
    expect(existsSync(join(dest, 'tests', 'integration', 'echo-contract.int.test.ts'))).toBe(true);
    expect(existsSync(join(dest, 'tests', 'fuzz', 'echo-tool.fuzz.test.ts'))).toBe(true);

    const packageJson = readFileSync(join(dest, 'package.json'), 'utf-8');
    const claude = readFileSync(join(dest, 'CLAUDE.md'), 'utf-8');
    const vitestConfig = readFileSync(join(dest, 'vitest.config.ts'), 'utf-8');
    const bunfig = readFileSync(join(dest, 'bunfig.toml'), 'utf-8');

    // The template is stored `_`-prefixed because Bun's packer drops a path it
    // reads as its own config, which kept it out of the published tarball.
    expect(bunfig).toContain('minimumReleaseAge');
    expect(bunfig).toContain('@socketsecurity/bun-security-scanner');

    expect(packageJson).toContain('"name": "demo-server"');
    expect(packageJson).not.toContain('{{PACKAGE_NAME}}');
    expect(packageJson).not.toContain('{{FRAMEWORK_VERSION}}');
    expect(packageJson).toContain('"test:coverage": "vitest run --coverage"');
    // devDependencies carry no placeholders; the scaffold must preserve the template's pins.
    const templateDevDeps: Record<string, string> = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'templates', 'package.json'),
        'utf-8',
      ),
    ).devDependencies;
    expect(JSON.parse(packageJson).devDependencies).toEqual(templateDevDeps);
    expect(vitestConfig).toContain("name: 'smoke'");
    expect(vitestConfig).toContain("name: 'integration'");
    expect(vitestConfig).toContain("name: 'fuzz'");
    expect(claude).toContain('**Server:** demo-server');
    expect(claude).not.toContain('{{PACKAGE_NAME}}');

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Scaffolding demo-server');
    expect(output).toContain('Next steps:');
    expect(output).toContain('cd demo-server');
    expect(output).toContain('bun install');
  });

  it('fills every template placeholder, version ranges included, from the framework manifest', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const dest = join(tempRoot, 'demo-server');
    const framework = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      version: string;
    };
    // Skills and scripts are copied verbatim, and skill docs show placeholders on purpose.
    const substituted = readdirSync(dest, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dest, join(entry.parentPath, entry.name)))
      .filter((path) => !path.startsWith('framework-skills/') && !path.startsWith('scripts/'));
    expect(substituted).toContain('package.json');
    const unfilled = substituted.filter((path) =>
      /\{\{[A-Z_]+\}\}/.test(readFileSync(join(dest, path), 'utf8')),
    );
    expect(unfilled).toEqual([]);

    const sdkRange = framework.dependencies['@modelcontextprotocol/server'];
    const zodRange = framework.peerDependencies.zod;
    expect(sdkRange).toBeTruthy();
    expect(zodRange).toBeTruthy();
    const { dependencies } = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
    expect(dependencies['@cyanheads/mcp-ts-core']).toBe(`^${framework.version}`);
    expect(dependencies.zod).toBe(zodRange);
    for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readFileSync(join(dest, doc), 'utf8');
      expect(text, doc).toContain(`**MCP SDK:** \`@modelcontextprotocol/server\` ${sdkRange}\n`);
      expect(text, doc).toContain(`**Zod:** ${zodRange}\n`);
    }
  });

  it('names an in-place scaffold after the directory it runs in', async () => {
    const dest = join(createTempDir(), 'inplace-server');
    mkdirSync(dest);
    process.chdir(dest);

    await runCli(['init']);

    expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).name).toBe(
      'inplace-server',
    );
    expect(readFileSync(join(dest, 'CLAUDE.md'), 'utf8')).toContain('**Server:** inplace-server');
  });

  it('ships the external-audience framework skills and none of the internal ones', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const audienceOf = (skill: string): unknown => {
      const skillMd = readFileSync(join(ROOT, 'framework-skills', skill, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? '';
      return (yaml.load(frontmatter) as { metadata?: { audience?: unknown } }).metadata?.audience;
    };
    const skills = readdirSync(join(ROOT, 'framework-skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const internal = skills.filter((skill) => audienceOf(skill) === 'internal');
    // The repository keeps framework-only skills; without one this case proves nothing.
    expect(internal).toContain('add-export');

    expect(readdirSync(join(tempRoot, 'demo-server', 'framework-skills')).sort()).toEqual(
      skills.filter((skill) => audienceOf(skill) === 'external').sort(),
    );
  });

  it('scaffolds in the current directory, skips existing files, and preserves user content', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    writeFileSync(join(tempRoot, 'package.json'), '{"name":"preexisting"}\n');
    writeFileSync(join(tempRoot, 'CLAUDE.md'), 'keep me\n');
    mkdirSync(join(tempRoot, 'scripts'));
    mkdirSync(join(tempRoot, 'framework-skills', 'api-auth'), { recursive: true });
    writeFileSync(join(tempRoot, 'scripts', 'build.ts'), '// custom build\n');
    writeFileSync(
      join(tempRoot, 'framework-skills', 'api-auth', 'SKILL.md'),
      'custom auth instructions\n',
    );

    await runCli(['init']);

    expect(readFileSync(join(tempRoot, 'package.json'), 'utf-8')).toBe('{"name":"preexisting"}\n');
    expect(readFileSync(join(tempRoot, 'CLAUDE.md'), 'utf-8')).toBe('keep me\n');
    expect(existsSync(join(tempRoot, 'scripts', 'build.ts'))).toBe(true);
    expect(readFileSync(join(tempRoot, 'scripts', 'build.ts'), 'utf8')).toBe('// custom build\n');
    expect(readFileSync(join(tempRoot, 'framework-skills', 'api-auth', 'SKILL.md'), 'utf8')).toBe(
      'custom auth instructions\n',
    );

    const output = getLoggedOutput(logSpy);
    expect(output).toContain('Skipped (already exist):');
    expect(output).toContain('package.json');
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('bun install');
    expect(output).not.toContain('\n    1. cd ');
  });

  it('scaffolds ignore rules that keep every env file but the three templates out of git and the image', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const dest = join(tempRoot, 'demo-server');
    const envFiles = atAnyDepth(ENV_FILES, 'nested');
    const templates = atAnyDepth(ENV_TEMPLATES, 'nested');
    mkdirSync(join(dest, 'nested'));
    for (const file of [...envFiles, ...templates]) {
      writeFileSync(join(dest, file), 'API_KEY=value\n');
    }
    expect(spawnSync('git', ['init', '-q'], { cwd: dest }).status).toBe(0);

    expect(ignoredPaths(dest, [...envFiles, ...templates])).toEqual(envFiles);

    // With everything git does not ignore staged, devcheck's Tracked Secrets step passes.
    expect(spawnSync('git', ['add', '-A'], { cwd: dest }).status).toBe(0);
    const secrets = spawnSync(
      'bun',
      ['run', 'scripts/devcheck.ts', '--only', 'Tracked Secrets', '--no-fix'],
      { cwd: dest, encoding: 'utf8' },
    );
    expect(secrets.status, `${secrets.stdout}${secrets.stderr}`).toBe(0);
    expect(secrets.stdout).toMatch(/Tracked Secrets\s+✅ PASSED/);

    // No build step reads an env template, so the build context takes none of them.
    expect(dockerignoreEnvLines(join(dest, '.dockerignore'))).toEqual(['.env*']);
  });

  it('scaffolds the CodeQL workflow byte-identical to the repository copy, triggers and pins intact', async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const scaffolded = readFileSync(
      join(tempRoot, 'demo-server', '.github', 'workflows', 'codeql.yml'),
      'utf8',
    );
    expect(scaffolded).toBe(readFileSync(join(ROOT, '.github', 'workflows', 'codeql.yml'), 'utf8'));

    const workflow = yaml.load(scaffolded) as CodeqlWorkflow;
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      pull_request: { branches: ['main'] },
      schedule: [{ cron: '30 6 * * 1' }],
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['analyze']);
    const analyze = workflow.jobs.analyze;
    expect(analyze?.name).toBe('Analyze');
    expect(analyze?.['runs-on']).toBe('ubuntu-latest');
    expect(analyze?.['timeout-minutes']).toBe(15);
    expect(analyze?.permissions).toEqual({
      'security-events': 'write',
      contents: 'read',
      actions: 'read',
    });
    expect(analyze?.steps.map((step) => step.uses)).toEqual([
      'actions/checkout@v7',
      'github/codeql-action/init@v4',
      'github/codeql-action/analyze@v4',
    ]);
    expect(analyze?.steps[1]?.with).toMatchObject({ 'build-mode': 'none' });
  });

  it("analyzes each CodeQL language in its own job, uploading under default setup's category", async () => {
    const tempRoot = createTempDir();
    process.chdir(tempRoot);

    await runCli(['init', 'demo-server']);

    const workflow = yaml.load(
      readFileSync(join(tempRoot, 'demo-server', '.github', 'workflows', 'codeql.yml'), 'utf8'),
    ) as CodeqlWorkflow;
    const analyze = workflow.jobs.analyze;
    // One language failing must not cancel the other's upload.
    expect(analyze?.strategy).toEqual({
      'fail-fast': false,
      matrix: { language: ['actions', 'javascript-typescript'] },
    });
    const [, init, upload] = analyze?.steps ?? [];
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    const language = '${{ matrix.language }}';
    expect(init?.with).toEqual({ languages: language, 'build-mode': 'none' });
    // An alert re-evaluates only through analyses in its own category; this is default setup's name.
    expect(upload?.with).toEqual({ category: `/language:${language}` });
  });
});

describe('repository ignore rules for env files', () => {
  it('git ignores every env file but the three template shapes, here and under templates/', () => {
    const envFiles = atAnyDepth(ENV_FILES, 'templates');
    const templates = atAnyDepth(ENV_TEMPLATES, 'templates');

    expect(ignoredPaths(ROOT, [...envFiles, ...templates])).toEqual(envFiles);
    // The repo's own templates are among the unignored paths above and stay tracked.
    const tracked = spawnSync('git', ['ls-files', '.env.example', 'templates/.env.example'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(tracked.stdout.trim().split('\n')).toEqual(['.env.example', 'templates/.env.example']);
  });

  it.each(['.dockerignore', 'templates/_.dockerignore'])(
    '%s keeps every env file out of the build context',
    (file) => {
      expect(dockerignoreEnvLines(join(ROOT, file))).toEqual(['.env*']);
    },
  );
});
