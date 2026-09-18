/**
 * @fileoverview Unit tests for application-root resolution — the anchor for
 * server identity and relative filesystem paths. Every case builds a real
 * directory layout under a temp root and points `process.argv[1]` at it, since
 * the resolver's whole job is reading what is actually on disk.
 * @module tests/unit/config/appRoot
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetAppRootCache, resolveAppRoot } from '@/config/appRoot.js';

let tempRoot: string;
const originalArgv1 = process.argv[1] ?? '';
const originalCwd = process.cwd();

/** Creates `dir` and writes a manifest into it. Returns the directory. */
function makePackage(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

/** Creates the file at `path` (with its parents) and points the entry module at it. */
function setEntry(path: string, contents = ''): string {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  process.argv[1] = path;
  return path;
}

beforeEach(() => {
  // Realpath the temp root: macOS hands out a symlinked /var path, and the
  // resolver reports the resolved location.
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-app-root-')));
  resetAppRootCache();
});

afterEach(() => {
  process.argv[1] = originalArgv1;
  process.chdir(originalCwd);
  resetAppRootCache();
  rmSync(tempRoot, { force: true, recursive: true });
});

describe('resolveAppRoot', () => {
  it('resolves the nearest manifest above the entry module', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'my-server', version: '2.10.4' });
    setEntry(join(app, 'dist', 'index.js'));

    const root = resolveAppRoot();

    expect(root?.dir).toBe(app);
    expect(root?.manifest).toEqual({ name: 'my-server', version: '2.10.4' });
  });

  it('walks past intermediate directories that hold no manifest', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'deep-server', version: '1.2.3' });
    setEntry(join(app, 'dist', 'config', 'index.js'));

    expect(resolveAppRoot()?.dir).toBe(app);
  });

  it('ignores the launching working directory, however unrelated it is', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'my-server', version: '2.10.4' });
    const foreign = makePackage(join(tempRoot, 'someone-elses-repo'), {
      name: 'my-unrelated-app',
      version: '9.9.9-totally-not-the-server',
    });
    setEntry(join(app, 'dist', 'index.js'));
    process.chdir(foreign);

    const root = resolveAppRoot();

    expect(root?.dir).toBe(app);
    expect(root?.manifest.version).toBe('2.10.4');
  });

  it('resolves an installed package launched from an arbitrary directory', () => {
    const installed = makePackage(
      join(tempRoot, 'npx-cache', 'node_modules', '@scope', 'some-server'),
      { name: '@scope/some-server', version: '4.0.1' },
    );
    setEntry(join(installed, 'dist', 'index.js'));
    process.chdir(makePackage(join(tempRoot, 'workdir'), { name: 'editor-project', version: '7' }));

    expect(resolveAppRoot()?.manifest.version).toBe('4.0.1');
  });

  it('prefers the installing project when the entry module is a tool under its node_modules', () => {
    const project = makePackage(join(tempRoot, 'project'), {
      name: 'the-project',
      version: '0.4.2',
    });
    makePackage(join(project, 'node_modules', 'test-runner'), {
      name: 'test-runner',
      version: '4.1.11',
    });
    setEntry(join(project, 'node_modules', 'test-runner', 'dist', 'workers', 'forks.js'));
    process.chdir(project);

    const root = resolveAppRoot();

    expect(root?.dir).toBe(project);
    expect(root?.manifest.name).toBe('the-project');
  });

  describe('workspace and cache topologies (#399)', () => {
    /**
     * A workspace repo with one package and a runner installed at the repo root.
     * `entry` is where the runner's worker file goes, relative to the repo.
     */
    function makeWorkspace(entry: string[], declaration: 'workspaces' | 'pnpm' = 'workspaces') {
      const repo = makePackage(
        join(tempRoot, 'repo'),
        declaration === 'workspaces'
          ? { name: 'the-monorepo', version: '1.0.0', workspaces: ['packages/*'] }
          : { name: 'the-monorepo', version: '1.0.0' },
      );
      if (declaration === 'pnpm') {
        writeFileSync(join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      }
      const pkg = makePackage(join(repo, 'packages', 'my-server'), {
        name: 'my-server',
        version: '0.2.0',
      });
      setEntry(join(repo, ...entry));
      process.chdir(pkg);
      return { pkg, repo };
    }

    it('resolves the workspace package when the runner is hoisted to the repo root', () => {
      makeWorkspace(['node_modules', 'test-runner', 'dist', 'workers', 'forks.js']);
      makePackage(join(tempRoot, 'repo', 'node_modules', 'test-runner'), {
        name: 'test-runner',
        version: '4.1.11',
      });

      expect(resolveAppRoot()?.manifest.name).toBe('my-server');
    });

    it('resolves the workspace package when the runner entry sits under a nested node_modules', () => {
      const nested = ['node_modules', 'test-runner', 'node_modules', 'worker-lib'];
      makeWorkspace([...nested, 'dist', 'index.js']);
      makePackage(join(tempRoot, 'repo', ...nested), { name: 'worker-lib', version: '2.0.0' });

      expect(resolveAppRoot()?.manifest.name).toBe('my-server');
    });

    it('resolves the workspace package through a pnpm isolated layout', () => {
      const isolated = [
        'node_modules',
        '.pnpm',
        'test-runner@4.1.11',
        'node_modules',
        'test-runner',
      ];
      makeWorkspace([...isolated, 'dist', 'workers', 'forks.js'], 'pnpm');
      makePackage(join(tempRoot, 'repo', ...isolated), {
        name: 'test-runner',
        version: '4.1.11',
      });

      expect(resolveAppRoot()?.manifest.name).toBe('my-server');
    });

    it('keeps the installed package when the working directory sits under a cache prefix', () => {
      const cache = join(tempRoot, 'npx-cache');
      const installed = makePackage(join(cache, 'node_modules', 'some-server'), {
        name: 'some-server',
        version: '4.0.1',
      });
      setEntry(join(installed, 'dist', 'index.js'));
      // The cache root is an ancestor of the cwd, but declares no workspace.
      makePackage(cache, { name: 'cache-root', version: '0.0.0' });
      process.chdir(
        makePackage(join(cache, 'node_modules', 'cache-neighbour'), {
          name: 'cache-neighbour',
          version: '9.9.9',
        }),
      );

      expect(resolveAppRoot()?.manifest.name).toBe('some-server');
    });

    it('keeps its own identity as a plain dependency run from a subdirectory of the project', () => {
      const project = makePackage(join(tempRoot, 'project'), {
        name: 'the-project',
        version: '0.4.2',
      });
      const tool = makePackage(join(project, 'node_modules', 'some-server'), {
        name: 'some-server',
        version: '3.3.3',
      });
      setEntry(join(tool, 'dist', 'index.js'));
      const src = join(project, 'src');
      mkdirSync(src, { recursive: true });
      process.chdir(src);

      expect(resolveAppRoot()?.manifest.name).toBe('some-server');
    });
  });

  it('keeps the installed package when the process does not run from the installing project', () => {
    const project = makePackage(join(tempRoot, 'project'), {
      name: 'the-project',
      version: '0.4.2',
    });
    const tool = makePackage(join(project, 'node_modules', 'some-server'), {
      name: 'some-server',
      version: '3.3.3',
    });
    setEntry(join(tool, 'dist', 'index.js'));
    process.chdir(makePackage(join(tempRoot, 'elsewhere'), { name: 'elsewhere', version: '1' }));

    expect(resolveAppRoot()?.manifest.name).toBe('some-server');
  });

  it('follows a symlinked bin shim to the real package', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'linked-server', version: '5.6.7' });
    const target = setEntry(join(app, 'dist', 'index.js'));
    const binDir = join(tempRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, 'linked-server');
    symlinkSync(target, shim);
    process.argv[1] = shim;

    expect(resolveAppRoot()?.dir).toBe(app);
  });

  it('accepts an entry that names a directory', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'dir-entry', version: '1.0.0' });
    process.argv[1] = app;

    expect(resolveAppRoot()?.dir).toBe(app);
  });

  it('falls back to the working directory when there is no entry module', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'cwd-server', version: '8.8.8' });
    process.argv[1] = ''; // `node -e`, or a host that embeds the runtime
    process.chdir(app);

    expect(resolveAppRoot()?.manifest.name).toBe('cwd-server');
  });

  it('falls back to the working directory when the entry path does not exist', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'cwd-server', version: '3.2.1' });
    process.argv[1] = join(tempRoot, 'deleted', 'index.js');
    process.chdir(app);

    expect(resolveAppRoot()?.dir).toBe(app);
  });

  it('walks past a malformed manifest', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'valid-above', version: '1.0.0' });
    const broken = join(app, 'packages', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'package.json'), '{ not json');
    setEntry(join(broken, 'index.js'));

    expect(resolveAppRoot()?.manifest.name).toBe('valid-above');
  });

  it('returns undefined when no manifest exists above the entry module', () => {
    setEntry(join(tempRoot, 'loose', 'index.js'));
    process.chdir(tempRoot);

    // The temp root itself is manifest-free, and so is every directory above it.
    expect(resolveAppRoot()).toBeUndefined();
  });

  it('keeps only the identity fields, dropping foreign and mistyped ones', () => {
    const app = makePackage(join(tempRoot, 'server'), {
      name: 'typed-server',
      version: '1.0.0',
      description: 'A server.',
      keywords: ['mcp', 7, 'server'],
      scripts: { build: 'tsc' },
      dependencies: { zod: '^4' },
    });
    setEntry(join(app, 'index.js'));

    expect(resolveAppRoot()?.manifest).toEqual({
      description: 'A server.',
      keywords: ['mcp', 'server'],
      name: 'typed-server',
      version: '1.0.0',
    });
  });

  it('drops a non-array keywords field rather than passing it through', () => {
    const app = makePackage(join(tempRoot, 'server'), { name: 'k', version: '1', keywords: 'mcp' });
    setEntry(join(app, 'index.js'));

    expect(resolveAppRoot()?.manifest).toEqual({ name: 'k', version: '1' });
  });

  it('caches the resolved root until the cache is reset', () => {
    const first = makePackage(join(tempRoot, 'first'), { name: 'first', version: '1.0.0' });
    setEntry(join(first, 'index.js'));
    expect(resolveAppRoot()?.manifest.name).toBe('first');

    const second = makePackage(join(tempRoot, 'second'), { name: 'second', version: '2.0.0' });
    setEntry(join(second, 'index.js'));
    expect(resolveAppRoot()?.manifest.name).toBe('first');

    resetAppRootCache();
    expect(resolveAppRoot()?.manifest.name).toBe('second');
  });

  it('caches a failed resolution instead of re-walking on every call', () => {
    setEntry(join(tempRoot, 'loose', 'index.js'));
    process.chdir(tempRoot);
    expect(resolveAppRoot()).toBeUndefined();

    const app = makePackage(join(tempRoot, 'loose'), { name: 'appeared-later', version: '1.0.0' });
    expect(resolveAppRoot()).toBeUndefined();

    resetAppRootCache();
    expect(resolveAppRoot()?.dir).toBe(app);
  });
});
