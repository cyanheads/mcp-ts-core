/**
 * @fileoverview Tests devcheck's two git-backed scans against a git-initialized
 * scaffold: the TODOs/FIXMEs step (issues #588, #885) and the Tracked Secrets
 * step (issues #594, #629, #885). Both scan the working tree, untracked files
 * included, so a file a change adds fails before it is ever staged; git's own
 * ignore rules and each step's pathspec excludes still apply, and staged-file
 * mode (`--husky-hook`) scans only the staged files.
 *
 * `devcheck.ts` resolves its project root from the script location
 * (`scripts/..`), not the cwd, and ships to consumer servers verbatim through
 * the maintenance script sync. The faithful reproduction therefore copies the
 * self-contained script (it imports only `node:` builtins) into a temp project,
 * runs `git init` there, writes or stages the fixture files, and runs the one
 * step with `--only`. The child environment reads no global or system git
 * config, so a personal `core.excludesFile` can neither hide an untracked
 * fixture nor keep a staged one out of the index. Git's repository-locating
 * variables are stripped too, so a run inside a git hook cannot point the
 * scaffold's commands at another repo.
 *
 * @module tests/unit/scripts/devcheck-git-scans.test
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

/**
 * The child environment: no colour, no Husky detection, no inherited git
 * repository, and no global or system git config.
 */
const CHILD_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
  };
  for (const key of [
    'FORCE_COLOR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_PARAMS',
    'GIT_WORK_TREE',
    'HUSKY',
  ]) {
    delete env[key];
  }
  return env;
})();

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: CHILD_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

/**
 * A git-initialized project carrying devcheck.ts, as a consumer server has it:
 * both files tracked, or, with `stage: false`, a fresh scaffold after `git init`
 * with nothing added.
 */
function makeScaffold({ stage = true }: { stage?: boolean } = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'devcheck-git-scans-'));
  mkdirSync(resolve(dir, 'scripts'));
  copyFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), resolve(dir, 'scripts', 'devcheck.ts'));
  writeFileSync(resolve(dir, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  git(dir, 'init', '-q');
  if (stage) git(dir, 'add', '-f', '--', 'package.json', 'scripts/devcheck.ts');
  return dir;
}

/** Writes each file, creating parent directories, and leaves it untracked. */
function write(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, file)), { recursive: true });
    writeFileSync(resolve(dir, file), content);
  }
}

/** Writes each file, creating parent directories, and stages it. */
function track(dir: string, files: Record<string, string>): void {
  write(dir, files);
  git(dir, 'add', '-f', '--', ...Object.keys(files));
}

function runStep(cwd: string, step: string, ...flags: string[]): { code: number; out: string } {
  const result = spawnSync(
    'bun',
    ['run', 'scripts/devcheck.ts', '--only', step, '--no-fix', ...flags],
    { cwd, encoding: 'utf-8', env: CHILD_ENV },
  );
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

/** The step's summary row, isolated from the `--only` skip notices that also name it. */
function summaryRow(out: string, step: string): string {
  return out.split('\n').find((line) => line.startsWith(step)) ?? '';
}

describe('devcheck TODOs/FIXMEs step (#588, #885)', { timeout: 20_000 }, () => {
  const STEP = 'TODOs/FIXMEs';
  let dir: string;

  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['TODO', 'FIXME'])('fails a tracked uppercase %s marker', (marker) => {
    track(dir, { 'src/index.ts': `export const x = 1; // ${marker}: wire the cache\n` });
    const { code, out } = runStep(dir, STEP);
    expect(code).toBe(1);
    expect(summaryRow(out, STEP)).toContain('FAILED');
    expect(out).toContain('src/index.ts:1:');
  });

  it('fails a staged marker in staged-file mode (--husky-hook)', () => {
    track(dir, { 'src/index.ts': '// TODO: wire the cache\nexport const x = 1;\n' });
    const { code, out } = runStep(dir, STEP, '--husky-hook');
    expect(code).toBe(1);
    expect(summaryRow(out, STEP)).toContain('FAILED');
    expect(out).toContain('src/index.ts:1:');
  });

  it('fails an untracked marker in full mode, before the file is ever added (#885)', () => {
    write(dir, { 'src/new.ts': '// TODO: wire this up\n' });
    const { code, out } = runStep(dir, STEP);
    expect(code).toBe(1);
    expect(summaryRow(out, STEP)).toContain('FAILED');
    expect(out).toContain('src/new.ts:1:');
  });

  it('passes untracked markers that .gitignore, .git/info/exclude, or core.excludesFile cover', () => {
    track(dir, { '.gitignore': 'ignored/\n*.gen.ts\n' });
    mkdirSync(resolve(dir, '.git/info'), { recursive: true });
    writeFileSync(resolve(dir, '.git/info/exclude'), 'local-only.ts\n');
    write(dir, { 'excludes.txt': 'scratch.ts\n' });
    git(dir, 'config', 'core.excludesFile', resolve(dir, 'excludes.txt'));
    write(dir, {
      'ignored/deep/notes.ts': '// TODO: inside an ignored directory\n',
      'src/client.gen.ts': '// TODO: matches an ignored glob\n',
      'local-only.ts': '// FIXME: listed in .git/info/exclude\n',
      'scratch.ts': '// TODO: listed in core.excludesFile\n',
    });
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('scans only the staged files in staged-file mode: an untracked marker elsewhere passes', () => {
    track(dir, { 'src/staged.ts': 'export const z = 1;\n' });
    write(dir, { 'src/other.ts': '// FIXME: not part of this commit\n' });
    const { code, out } = runStep(dir, STEP, '--husky-hook');
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(out).not.toContain('src/other.ts');
    expect(code).toBe(0);
  });

  /** Skill prose names the markers; every directory the maintenance sync writes skills into. */
  const SKILL_PROSE: Record<string, string> = {
    'framework-skills/git-wrapup/SKILL.md': '- [ ] No TODO placeholders.\n',
    '.claude/skills/git-wrapup/SKILL.md': '- [ ] No TODO placeholders.\n',
    '.agents/skills/git-wrapup/SKILL.md': '- [ ] No TODO placeholders.\n',
    '.codex/skills/greenfield/SKILL.md': '- no unfinished TODO/FIXME\n',
    '.cursor/skills/greenfield/SKILL.md': '- no unfinished TODO/FIXME\n',
    '.windsurf/skills/tool-defs/SKILL.md': '"TODO: support batch mode"\n',
  };

  it('passes when the only markers sit in framework skill prose, in full mode', () => {
    track(dir, SKILL_PROSE);
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('passes the same skill prose staged in staged-file mode (--husky-hook)', () => {
    track(dir, SKILL_PROSE);
    const { code, out } = runStep(dir, STEP, '--husky-hook');
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('passes lowercase and mixed-case words and identifiers that contain the marker', () => {
    track(dir, {
      'src/stopwords.ts': "export const STOP_WORDS = ['todo', 'para', 'Todo'];\n",
      'src/limits.ts': 'export const MAX_TODO_ITEMS = 50;\nconst todoList: string[] = [];\n',
    });
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  /** Markers in the paths the step excludes: changelogs, lockfiles, and tests. */
  const EXCLUDED_PROSE: Record<string, string> = {
    'CHANGELOG.md': '- Fixed the TODO scan.\n',
    'changelog/0.1.x/0.1.0.md': '- Fixed the FIXME scan.\n',
    'bun.lock': '{ "TODO": 1 }\n',
    'tests/unit/cache.test.ts': "it.todo('TODO: cover eviction');\n",
  };

  it('keeps the existing excludes: changelogs, lockfiles, devcheck itself, and tests', () => {
    track(dir, EXCLUDED_PROSE);
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('applies the same excludes to untracked files, skill prose included', () => {
    write(dir, { ...EXCLUDED_PROSE, ...SKILL_PROSE });
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('passes a fresh scaffold after git init with nothing added, devcheck.ts itself untracked', () => {
    const fresh = makeScaffold({ stage: false });
    try {
      const { code, out } = runStep(fresh, STEP);
      expect(summaryRow(out, STEP)).toContain('PASSED');
      expect(code).toBe(0);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  describe('devcheck.config.json todos.ignore', () => {
    /** Generated data that holds the marker words as data, not as markers. */
    const GENERATED_DATA: Record<string, string> = {
      'src/data/stopwords.ts': "export const WORDS = ['FIXME', 'TODO'];\n",
      'generated/words.txt': 'TODO\n',
    };
    const CONFIG = { todos: { ignore: ['src/data/stopwords.ts', 'generated/'] } };

    it('passes markers in the listed paths, in full mode', () => {
      write(dir, { 'devcheck.config.json': JSON.stringify(CONFIG) });
      track(dir, GENERATED_DATA);
      const { code, out } = runStep(dir, STEP);
      expect(summaryRow(out, STEP)).toContain('PASSED');
      expect(code).toBe(0);
    });

    it('passes the same paths staged, in staged-file mode (--husky-hook)', () => {
      write(dir, { 'devcheck.config.json': JSON.stringify(CONFIG) });
      track(dir, GENERATED_DATA);
      const { code, out } = runStep(dir, STEP, '--husky-hook');
      expect(summaryRow(out, STEP)).toContain('PASSED');
      expect(code).toBe(0);
    });

    it('still fails a marker in any other file, untracked included', () => {
      write(dir, { 'devcheck.config.json': JSON.stringify(CONFIG) });
      track(dir, GENERATED_DATA);
      write(dir, { 'src/new.ts': '// TODO: wire this up\n' });
      const { code, out } = runStep(dir, STEP);
      expect(code).toBe(1);
      expect(summaryRow(out, STEP)).toContain('FAILED');
      expect(out).toContain('src/new.ts:1:');
      expect(out).not.toContain('stopwords.ts');
      expect(out).not.toContain('words.txt');
    });

    it('excludes only the built-in paths without a todos block', () => {
      write(dir, { 'devcheck.config.json': JSON.stringify({ skillsSync: { ignore: ['x'] } }) });
      track(dir, GENERATED_DATA);
      const { code, out } = runStep(dir, STEP);
      expect(code).toBe(1);
      expect(summaryRow(out, STEP)).toContain('FAILED');
      expect(out).toContain('src/data/stopwords.ts:1:');
      expect(out).toContain('generated/words.txt:1:');
    });

    // An empty entry becomes the pathspec `:!`, which excludes every file.
    it.each([
      ['an empty entry', ['src/data/stopwords.ts', '']],
      ['a non-string entry', [42]],
      ['a bare string', 'src/data/stopwords.ts'],
    ])('fails the step naming todos.ignore for %s', (_label, ignore) => {
      write(dir, { 'devcheck.config.json': JSON.stringify({ todos: { ignore } }) });
      const { code, out } = runStep(dir, STEP);
      expect(code).toBe(1);
      expect(summaryRow(out, STEP)).toContain('FAILED');
      // The step's tip names `todos.ignore` on every failure, so assert the
      // validation message itself.
      expect(out).toContain(
        'devcheck.config.json todos.ignore must be an array of non-empty pathspec strings.',
      );
    });
  });
});

describe('devcheck Tracked Secrets step (#594, #629, #885)', { timeout: 20_000 }, () => {
  const STEP = 'Tracked Secrets';
  let dir: string;

  beforeEach(() => {
    dir = makeScaffold();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The `.env` template shapes the step accepts, at the root and in subdirectories. */
  const ENV_TEMPLATES: Record<string, string> = {
    '.env.example': 'ACME_API_KEY=\n',
    'templates/.env.example': 'ACME_API_KEY=\n',
    '.env.template': 'ACME_API_KEY=\n',
    'config/.env.sample': 'ACME_API_KEY=\n',
  };

  it('passes a project that tracks no secret-shaped file', () => {
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('passes the .env template shapes at the root and in subdirectories', () => {
    track(dir, ENV_TEMPLATES);
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it('passes the GitHub secret scanning config at .github/secret_scanning.yml (#594)', () => {
    track(dir, {
      ...ENV_TEMPLATES,
      '.github/secret_scanning.yml': 'paths-ignore:\n  - "tests/fixtures/**"\n',
    });
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });

  it.each([
    'secret_scanning.yml',
    'config/secret_scanning.yml',
    'fixtures/.github/secret_scanning.yml',
  ])('fails a secret_scanning.yml at %s, off the exact repo-root path (#594)', (file) => {
    track(dir, { ...ENV_TEMPLATES, [file]: 'paths-ignore: []\n' });
    const { code, out } = runStep(dir, STEP);
    expect(code).toBe(1);
    expect(summaryRow(out, STEP)).toContain('FAILED');
    expect(out).toContain(file);
  });

  const SECRET_NAMES = [
    '.npmrc',
    '.netrc',
    'credentials.json',
    'server.pem',
    'server.key',
    'secrets.json',
    '.htpasswd',
    '.env',
    '.env.local',
  ];

  // Each name at the repository root and in a subdirectory, then files inside
  // a secret-named directory.
  it.each([
    ...SECRET_NAMES,
    ...SECRET_NAMES.map((name) => `config/${name}`),
    'secrets/prod.json',
    'config/secrets/prod.json',
    'deploy/.env.d/app.conf',
  ])('fails a tracked %s (#629)', (file) => {
    track(dir, { ...ENV_TEMPLATES, [file]: 'token=abc\n' });
    const { code, out } = runStep(dir, STEP);
    expect(code).toBe(1);
    expect(summaryRow(out, STEP)).toContain('FAILED');
    expect(out).toContain(file);
  });

  it.each(['server.key', '.npmrc', 'config/credentials.json', 'secrets/prod.json'])(
    'fails an untracked %s that no ignore rule covers, before it is ever added (#885)',
    (file) => {
      write(dir, { [file]: 'token=abc\n' });
      const { code, out } = runStep(dir, STEP);
      expect(code).toBe(1);
      expect(summaryRow(out, STEP)).toContain('FAILED');
      expect(out).toContain(file);
    },
  );

  it('passes untracked secret-shaped files that ignore rules cover, and untracked .env templates', () => {
    track(dir, { '.gitignore': '.env*\n!.env.example\nignored/\n' });
    mkdirSync(resolve(dir, '.git/info'), { recursive: true });
    writeFileSync(resolve(dir, '.git/info/exclude'), 'server.key\n');
    write(dir, {
      '.env': 'ACME_API_KEY=abc\n',
      'config/.env.local': 'ACME_API_KEY=abc\n',
      'ignored/deep/credentials.json': '{"token":"abc"}\n',
      'server.key': 'token=abc\n',
      ...ENV_TEMPLATES,
    });
    const { code, out } = runStep(dir, STEP);
    expect(summaryRow(out, STEP)).toContain('PASSED');
    expect(code).toBe(0);
  });
});
