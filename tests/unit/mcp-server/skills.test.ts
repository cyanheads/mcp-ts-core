/**
 * @fileoverview Unit tests for the SEP-2640 skills module: loading a catalog for
 * serving (folder or record, non-strict, storage failures as
 * `ConfigurationError`, relative folders anchored on the application root) and
 * `validateSkillTree`, the strict check build-time tooling runs. Trees are real
 * directories under a temp root, read through the SDK's own loader.
 * @module tests/unit/mcp-server/skills.test
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAppRoot } from '@/config/appRoot.js';
import { loadServedSkills, type SkillProblem, validateSkillTree } from '@/mcp-server/skills.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

vi.mock('@/config/appRoot.js', () => ({ resolveAppRoot: vi.fn(() => undefined) }));

type TreeEntry = string | Buffer | { symlinkTo: string };

/** `---`-fenced frontmatter lines followed by a one-line body. */
const skillMd = (...lines: string[]) => `---\n${lines.join('\n')}\n---\nBody.\n`;
const DESCRIPTION = 'description: Chain demo_search then demo_get. Use when an ID is needed.';
const conformant = (name: string, ...extra: string[]) =>
  skillMd(`name: ${name}`, DESCRIPTION, ...extra);

let root: string;

/** Writes `files` (paths relative to the tree root) under a fresh `<tmp>/skills`. */
function tree(files: Record<string, TreeEntry>): string {
  const dir = join(root, 'skills');
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    if (typeof content === 'object' && 'symlinkTo' in content) symlinkSync(content.symlinkTo, full);
    else writeFileSync(full, content);
  }
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-unit-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(resolveAppRoot).mockReturnValue(undefined);
});

/** Awaits a rejection and returns it as the `McpError` it must be. */
async function rejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(McpError);
  return error as McpError;
}

describe('loadServedSkills', () => {
  it('serves every skill in a folder and declares the directory-read extension', async () => {
    const dir = tree({
      'alpha-guide/SKILL.md': conformant('alpha-guide'),
      'alpha-guide/references/ids.md': '# IDs\n',
      'beta-guide/SKILL.md': conformant('beta-guide'),
    });

    const skills = await loadServedSkills(dir, () => {});

    expect(skills.names).toEqual(['alpha-guide', 'beta-guide']);
    expect(skills.extensions).toEqual({
      'io.modelcontextprotocol/skills': { directoryRead: true },
    });
  });

  it('serves a record of paths to contents', async () => {
    const skills = await loadServedSkills(
      {
        'record-guide/SKILL.md': conformant('record-guide'),
        'record-guide/references/ids.md': new TextEncoder().encode('# IDs\n'),
      },
      () => {},
    );

    expect(skills.names).toEqual(['record-guide']);
  });

  it('skips a skill the SDK rejects, reports it, and serves the rest', async () => {
    const dir = tree({
      'good-guide/SKILL.md': conformant('good-guide'),
      'foo/SKILL.md': conformant('bar'),
    });
    const problems: SkillProblem[] = [];

    const skills = await loadServedSkills(dir, (problem) => problems.push(problem));

    expect(skills.names).toEqual(['good-guide']);
    expect(problems).toEqual([
      {
        path: 'foo/SKILL.md',
        message: expect.stringContaining('frontmatter name "bar" must match'),
      },
    ]);
  });

  it('resolves a relative folder against the application root, not the working directory', async () => {
    tree({ 'rooted-guide/SKILL.md': conformant('rooted-guide') });
    // The temp root is the application root; the working directory (the repo)
    // has no skills/ folder, so resolving against it would fail to list.
    vi.mocked(resolveAppRoot).mockReturnValue({ dir: root, manifest: {} });

    const skills = await loadServedSkills('skills', () => {});

    expect(skills.names).toEqual(['rooted-guide']);
  });

  it('fails a missing folder as a ConfigurationError naming the resolved path', async () => {
    vi.mocked(resolveAppRoot).mockReturnValue({ dir: root, manifest: {} });
    const missing = join(root, 'not-there');

    const error = await rejection(loadServedSkills('not-there', () => {}));

    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.message).toContain(`Skills folder ${missing} cannot be served`);
    expect(error.message).toContain('ENOENT');
    expect(error.data).toMatchObject({
      skillsPath: missing,
      problems: [{ path: '.', message: expect.stringContaining('cannot be listed') }],
    });
  });

  it('fails a path that names a file rather than a folder', async () => {
    const file = join(root, 'skills.md');
    writeFileSync(file, '# not a folder\n');

    const error = await rejection(loadServedSkills(file, () => {}));

    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data).toMatchObject({ skillsPath: file });
  });

  it('refuses an empty path, which would serve the whole application root', async () => {
    const error = await rejection(loadServedSkills('  ', () => {}));

    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.message).toContain('skills must name a folder');
  });

  it('fails a record whose path leaves the tree', async () => {
    const error = await rejection(
      loadServedSkills({ '../escape/SKILL.md': conformant('escape') }, () => {}),
    );

    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.message).toContain('The skills record cannot be served');
  });
});

describe('validateSkillTree', () => {
  it('returns nothing for a conformant tree, host-specific fields included', async () => {
    const dir = tree({
      'demo-guide/SKILL.md': conformant(
        'demo-guide',
        'license: Apache-2.0',
        'compatibility: Requires network access.',
        'disable-model-invocation: true',
        'metadata:',
        '  author: owner',
        '  version: "1.0"',
      ),
      'demo-guide/references/ids.md': '# IDs\n',
    });

    expect(await validateSkillTree(dir)).toEqual([]);
  });

  it.each<[string, Record<string, TreeEntry>, string, string]>([
    [
      'name missing',
      { 'x/SKILL.md': skillMd(DESCRIPTION) },
      'x/SKILL.md',
      'must contain string "name"',
    ],
    [
      'name not a string',
      { '123/SKILL.md': skillMd('name: 123', DESCRIPTION) },
      '123/SKILL.md',
      'must contain string "name"',
    ],
    [
      'name not the directory name',
      { 'foo/SKILL.md': conformant('bar') },
      'foo/SKILL.md',
      'must match the last path segment "foo"',
    ],
    [
      'name over 64 characters',
      { [`${'a'.repeat(65)}/SKILL.md`]: conformant('a'.repeat(65)) },
      `${'a'.repeat(65)}/SKILL.md`,
      'must be 1-64 lowercase letters, digits and single hyphens',
    ],
    [
      'name with uppercase letters',
      { 'Foo/SKILL.md': conformant('Foo') },
      'Foo/SKILL.md',
      'must be 1-64 lowercase letters, digits and single hyphens',
    ],
    [
      'name with a double hyphen',
      { 'a--b/SKILL.md': conformant('a--b') },
      'a--b/SKILL.md',
      'must be 1-64 lowercase letters, digits and single hyphens',
    ],
    [
      'description missing',
      { 'x/SKILL.md': skillMd('name: x') },
      'x/SKILL.md',
      'must contain string "name" and "description"',
    ],
    [
      'description empty',
      { 'x/SKILL.md': skillMd('name: x', 'description: ""') },
      'x/SKILL.md',
      'description must be 1-1024 characters',
    ],
    [
      'description over 1024 characters',
      { 'x/SKILL.md': skillMd('name: x', `description: ${'d'.repeat(1025)}`) },
      'x/SKILL.md',
      'description must be 1-1024 characters',
    ],
    [
      'compatibility empty',
      { 'x/SKILL.md': conformant('x', 'compatibility: ""') },
      'x/SKILL.md',
      'compatibility must be a string of 1-500 characters',
    ],
    [
      'compatibility not a string',
      { 'x/SKILL.md': conformant('x', 'compatibility: 3') },
      'x/SKILL.md',
      'compatibility must be a string of 1-500 characters',
    ],
    [
      'compatibility over 500 characters',
      { 'x/SKILL.md': conformant('x', `compatibility: ${'c'.repeat(501)}`) },
      'x/SKILL.md',
      'compatibility must be a string of 1-500 characters',
    ],
    [
      'an unquoted metadata number',
      { 'x/SKILL.md': conformant('x', 'metadata:', '  version: 1.0') },
      'x/SKILL.md',
      'metadata must map strings to strings',
    ],
    [
      'a multi-line quoted value',
      { 'x/SKILL.md': skillMd('name: x', 'description: "first line', '  second line"') },
      'x/SKILL.md',
      'multi-line quoted values are not supported',
    ],
    [
      'a YAML anchor',
      { 'x/SKILL.md': skillMd('name: &n x', DESCRIPTION) },
      'x/SKILL.md',
      'anchors, aliases and tags are not supported',
    ],
    [
      'a symlinked reference file',
      {
        'x/SKILL.md': conformant('x'),
        'x/references/real.md': '# r\n',
        'x/references/link.md': { symlinkTo: 'real.md' },
      },
      'x/references/link.md',
      'symlinks and other special files are not followed',
    ],
    [
      'a SKILL.md directly under the root',
      { 'SKILL.md': conformant('skills') },
      'SKILL.md',
      'a SKILL.md at the root has no skill path',
    ],
    [
      'a skill over 512 files',
      Object.fromEntries([
        ['x/SKILL.md', conformant('x')],
        ...Array.from({ length: 512 }, (_, i) => [`x/r/${i}.md`, `${i}\n`]),
      ]),
      'x',
      'exceeds the limit of 512 files / 16777216 bytes',
    ],
    [
      'a skill over 16 MiB',
      { 'x/SKILL.md': conformant('x'), 'x/references/big.bin': Buffer.alloc(16 * 1024 * 1024) },
      'x',
      'exceeds the limit of 512 files / 16777216 bytes',
    ],
  ])('reports %s, naming the file', async (_label, files, path, message) => {
    expect(await validateSkillTree(tree(files))).toEqual([
      { path, message: expect.stringContaining(message) },
    ]);
  });

  it('reports every problem in the tree, not only the first', async () => {
    const dir = tree({
      'good-guide/SKILL.md': conformant('good-guide'),
      'foo/SKILL.md': conformant('bar'),
      'y/SKILL.md': skillMd('name: y', 'description: ""'),
    });

    const problems = await validateSkillTree(dir);

    expect(problems.map((problem) => problem.path).sort()).toEqual(['foo/SKILL.md', 'y/SKILL.md']);
  });

  it('reports a root that cannot be listed', async () => {
    expect(await validateSkillTree(join(root, 'absent'))).toEqual([
      { path: '.', message: expect.stringContaining('cannot be listed') },
    ]);
  });
});
