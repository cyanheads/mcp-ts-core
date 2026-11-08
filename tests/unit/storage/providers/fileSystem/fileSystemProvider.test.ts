/**
 * @fileoverview Tests for the FileSystem storage provider: its on-disk layout,
 * the one-time copy of a storage path in the earlier layout, and stored trees
 * holding files the provider did not write.
 * @module tests/unit/storage/providers/fileSystem/fileSystemProvider.test
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/**
 * A one-shot hook run just before the next `renameSync`, so a test can land a
 * second construction between the first one's copy and its rename. The rename
 * itself is the real one, failure included.
 */
const fsHooks = vi.hoisted(() => ({ beforeRename: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const hook = fsHooks.beforeRename;
      fsHooks.beforeRename = undefined;
      hook?.();
      actual.renameSync(...args);
    },
  };
});

const DATA = '_v2';

/** Every file below `dir`, as its `/`-joined relative path mapped to its contents. */
function snapshot(dir: string): Map<string, string> {
  return new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, file).split(path.sep).join('/'), readFileSync(file, 'utf-8')];
      }),
  );
}

/** Writes `contents` at `relative` (`/`-separated) below `dir`. */
function writeAt(dir: string, relative: string, contents: string): void {
  const file = path.join(dir, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** The entries of `snapshot` outside the data root: the earlier layout's files. */
function legacyOnly(files: Map<string, string>): Map<string, string> {
  return new Map([...files].filter(([relative]) => !relative.startsWith(`${DATA}/`)));
}

const doc = (value: unknown, expiresAt?: number) =>
  JSON.stringify({ __mcp: { v: 1, ...(expiresAt !== undefined && { expiresAt }) }, value });

/** The directory name of a tenant ID whose encoding passes the name limit. */
const digestDir = (tenantId: string) => `%%${createHash('sha256').update(tenantId).digest('hex')}`;

const tooLongMessage = (key: string) =>
  `Key "${key}" is too long for filesystem storage. Use a shorter key or shorter "/"-separated segments.`;

/** 86 uppercase letters, and 128 characters of which 85 encode to three bytes. */
const UPPER_86 = 'U'.repeat(86);
const MIXED_128 = `${'Ab.'.repeat(42)}Ab`;

describe('FileSystemProvider', () => {
  let root: string;
  let provider: FileSystemProvider;
  let warningSpy: MockInstance<typeof logger.warning>;
  const restores: Array<() => void> = [];
  const testContext = requestContextService.createRequestContext({ operation: 'test' });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'fs-provider-test-'));
    warningSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    provider = new FileSystemProvider(root);
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    fsHooks.beforeRename = undefined;
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** `chmod`, undone after the test; `false` when the mode does not bind this process (root, an ACL). */
  function lockFile(file: string): boolean {
    chmodSync(file, 0o000);
    restores.push(() => chmodSync(file, 0o644));
    try {
      readFileSync(file);
      return false;
    } catch {
      return true;
    }
  }

  const migrationWarnings = () =>
    warningSpy.mock.calls.filter(([message]) => message.startsWith('Filesystem storage moved'));

  describe('Constructor', () => {
    it('creates the storage path and its data root when neither exists', () => {
      const newPath = path.join(root, 'new-dir');
      expect(new FileSystemProvider(newPath)).toBeDefined();
      expect(readdirSync(newPath)).toEqual([DATA]);
    });

    it('should throw error when storage path is empty', () => {
      expect(() => new FileSystemProvider('')).toThrow(McpError);
    });
  });

  describe('On-disk layout', () => {
    it.each([
      ['default', 'session/abc123', '_v2/default/session/abc123.json'],
      ['TenantA', 'k', '_v2/%54enant%41/k.json'],
      ['tenant.one', 'User/x.y', '_v2/tenant%2eone/%55ser/x%2ey.json'],
      ['default', 'config.json', '_v2/default/config%2ejson.json'],
      ['default', 'x/./y', '_v2/default/x/%2e/y.json'],
      ['default', 'm//n', '_v2/default/m/%/n.json'],
      ['default', 't/', '_v2/default/t/.json'],
      ['default', '/lead', '_v2/default/%/lead.json'],
      ['default', '.', '_v2/default/%2e.json'],
    ])('stores tenant %s key %s at %s', async (tenantId, key, expected) => {
      await provider.set(tenantId, key, 'value', testContext);

      expect([...snapshot(root).keys()]).toEqual([expected]);
      await expect(provider.get(tenantId, key, testContext)).resolves.toBe('value');
    });

    it('keeps a key holding ".." segments inside its tenant directory', async () => {
      // StorageService rejects such a key; a direct caller's still cannot leave the tenant.
      await provider.set('tenant1', '../../../etc/passwd', 'contained', testContext);

      expect([...snapshot(root).keys()]).toEqual([
        '_v2/tenant1/%2e%2e/%2e%2e/%2e%2e/etc/passwd.json',
      ]);
      await expect(provider.get('tenant1', '../../../etc/passwd', testContext)).resolves.toBe(
        'contained',
      );
    });

    it('lists and clears only the names the layout writes', async () => {
      await provider.set('tenant1', 'a', 1, testContext);
      await provider.set('tenant1', 'dir/b', 2, testContext);
      const tenantPath = path.join(root, DATA, 'tenant1');
      const strays = [
        '.DS_Store',
        'Upper.json',
        'noext',
        'x%2E.json',
        'swap.json.tmp',
        'Bar/c.json',
        '%zz/d.json',
        'dot.dir/e.json',
        'dir/f',
      ];
      for (const stray of strays) writeAt(tenantPath, stray, doc('stray'));

      await expect(provider.list('tenant1', '', testContext)).resolves.toMatchObject({
        keys: ['a', 'dir/b'],
      });
      await expect(provider.clear('tenant1', testContext)).resolves.toBe(2);
      expect([...snapshot(tenantPath).keys()].sort()).toEqual([...strays].sort());
    });

    /**
     * A file name holds 255 bytes on APFS and ext4, `.json` takes 5, and an
     * uppercase letter or `.` encodes to 3.
     */
    it.each([
      ['lowercase', 'a'.repeat(250), 'a'.repeat(251)],
      ['uppercase', 'A'.repeat(83), 'A'.repeat(84)],
      ['dotted', `${'a.'.repeat(62)}a`, 'a.'.repeat(63)],
    ])(
      'stores a %s last segment up to the name limit and rejects one past it',
      async (_label, atLimit, pastLimit) => {
        await provider.set('tenant1', `dir/${atLimit}`, 'fits', testContext);
        await expect(provider.get('tenant1', `dir/${atLimit}`, testContext)).resolves.toBe('fits');

        await expect(
          provider.set('tenant1', `dir/${pastLimit}`, 'too long', testContext),
        ).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: `Key "dir/${pastLimit}" is too long for filesystem storage. Use a shorter key or shorter "/"-separated segments.`,
        });
      },
    );

    /**
     * A tenant directory's name holds 255 bytes as well. A tenant ID whose
     * encoding fits is named by it; any other by `%%` and the ID's SHA-256.
     */
    it.each([
      ['at the name limit', 'U'.repeat(85), '%55'.repeat(85)],
      ['one byte past it', `a${'U'.repeat(85)}`, digestDir(`a${'U'.repeat(85)}`)],
      ['of 86 uppercase letters', UPPER_86, digestDir(UPPER_86)],
      ['of 128 characters', MIXED_128, digestDir(MIXED_128)],
    ])('names the directory of a tenant ID %s', async (_label, tenantId, dirName) => {
      await provider.set(tenantId, 'dir/k', 'value', testContext);

      expect([...snapshot(root).keys()]).toEqual([`_v2/${dirName}/dir/k.json`]);
      await expect(provider.get(tenantId, 'dir/k', testContext)).resolves.toBe('value');
      await expect(provider.list(tenantId, '', testContext)).resolves.toMatchObject({
        keys: ['dir/k'],
      });
    });

    describe.each([
      [
        'setMany',
        (target: FileSystemProvider, tenantId: string, keys: string[]) =>
          target.setMany(tenantId, new Map(keys.map((key) => [key, 'written'])), testContext),
      ],
      [
        'deleteMany',
        (target: FileSystemProvider, tenantId: string, keys: string[]) =>
          target.deleteMany(tenantId, keys, testContext),
      ],
      [
        'getMany',
        (target: FileSystemProvider, tenantId: string, keys: string[]) =>
          target.getMany(tenantId, keys, testContext),
      ],
    ])('%s', (_operation, run) => {
      const pastLimit = `batch/${'a'.repeat(251)}`;

      it('rejects a key past the name limit before it touches the filesystem', async () => {
        await expect(run(provider, 'fresh', ['batch/ok', pastLimit])).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          message: tooLongMessage(pastLimit),
        });
        expect(readdirSync(path.join(root, DATA))).toEqual([]);
      });

      it('leaves every stored file in place when one key is past the name limit', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        writeAt(path.join(root, DATA, 'tenant1'), 'batch/ok.json', doc('stored'));
        writeAt(path.join(root, DATA, 'tenant1'), 'batch/expired.json', doc('expired', 1));
        const before = snapshot(root);

        await expect(
          run(provider, 'tenant1', ['batch/ok', 'batch/expired', 'batch/new', pastLimit]),
        ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });

        expect(snapshot(root)).toEqual(before);
        expect(readdirSync(path.join(root, DATA, 'tenant1', 'batch')).sort()).toEqual([
          'expired.json',
          'ok.json',
        ]);
      });
    });
  });

  describe('Path Traversal Security', () => {
    it('should prevent path traversal with ../ in tenant ID', async () => {
      await expect(
        provider.set('../../evil-tenant', 'key1', { data: 'evil' }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should sanitize tenant IDs containing slashes', async () => {
      await expect(
        provider.set('tenant/with/slashes', 'key1', { data: 'test' }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should reject tenantId "." that would collapse into the storage root', async () => {
      // Pre-fix: tenant '.' wrote into storage root, overlapping every other tenant's keyspace.
      await expect(
        provider.set('.', 'alice/secret', { hijacked: true }, testContext),
      ).rejects.toThrow(McpError);
    });

    it('should reject tenantId variants the upstream gate blocks', async () => {
      for (const bad of ['./alice', 'alice/.', '.alice', 'alice.', 'alice..bob', '']) {
        await expect(provider.set(bad, 'k', { v: 1 }, testContext)).rejects.toThrow(McpError);
      }
    });
  });

  describe('List Operation', () => {
    it('should skip files with corrupted JSON during list rather than throwing', async () => {
      await provider.set('tenant1', 'good-key', { value: 1 }, testContext);
      writeAt(path.join(root, DATA, 'tenant1'), 'corrupt-key.json', 'not-valid-json{{{');

      const result = await provider.list('tenant1', '', testContext);

      expect(result.keys).toEqual(['good-key']);
    });
  });

  describe('Error Handling', () => {
    it('should handle very long keys up to filesystem limits', async () => {
      // Use a reasonably long key that stays within filesystem limits
      const longKey = 'a'.repeat(200);
      await provider.set('tenant1', longKey, { data: 'test' }, testContext);

      const result = await provider.get('tenant1', longKey, testContext);
      expect(result).toEqual({ data: 'test' });
    });

    it('should reject a corrupted stored value as SerializationError', async () => {
      writeAt(path.join(root, DATA, 'tenant1'), 'corrupt-key.json', 'not-valid-json{{{');

      await expect(provider.get('tenant1', 'corrupt-key', testContext)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
      });
    });

    it('should read a missing key as null and delete it as false', async () => {
      await expect(provider.get('tenant1', 'absent', testContext)).resolves.toBeNull();
      await expect(provider.delete('tenant1', 'absent', testContext)).resolves.toBe(false);
    });

    // A directory where a key's file is expected fails with a directory error,
    // not ENOENT, so the provider must reject rather than treat it as a missing
    // key. The raw fs error quotes the absolute path; the rejection names the
    // key instead (#645).
    it.each([
      ['get', 'read'],
      ['delete', 'delete'],
    ] as const)(
      'should reject a non-ENOENT %s failure as DatabaseError without the storage path',
      async (operation, verb) => {
        mkdirSync(path.join(root, DATA, 'tenant1', 'dir-not-file.json'), { recursive: true });

        const error = await provider[operation]('tenant1', 'dir-not-file', testContext).catch(
          (err: unknown) => err,
        );

        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.DatabaseError,
          message: `Failed to ${verb} stored value for key "dir-not-file".`,
        });
        expect((error as McpError).message).not.toContain(root);
        expect((error as McpError).data).not.toHaveProperty('rootCause');
        expect(JSON.stringify((error as McpError).data)).not.toContain(root);
      },
    );
  });

  describe('Stored document', () => {
    it('writes one file per key holding the envelope bytes, TTL included', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      await provider.set('tenant1', 'doc/item', { a: 1 }, testContext, { ttl: 5 });

      expect([...snapshot(root).values()]).toEqual([
        '{"__mcp":{"v":1,"expiresAt":6000},"value":{"a":1}}',
      ]);
    });
  });

  describe('Legacy Data Format Support', () => {
    it('should handle legacy data without envelope', async () => {
      // A document written before envelopes existed is the value itself.
      writeAt(
        path.join(root, DATA, 'tenant1'),
        'legacy-key.json',
        JSON.stringify({ legacyData: 'test' }),
      );

      const result = await provider.get('tenant1', 'legacy-key', testContext);
      expect(result).toEqual({ legacyData: 'test' });
    });
  });

  describe('Earlier layout', () => {
    let legacyRoot: string;

    beforeEach(() => {
      legacyRoot = path.join(root, 'legacy');
      warningSpy.mockClear();
    });

    it('copies each file once, byte for byte, under the tenant and key the earlier layout listed', async () => {
      const files: Record<string, string> = {
        'default/session/abc123': doc('session', 4_102_444_800_000),
        'default/config.json': doc('config'),
        // Each file migrates under the path the earlier layout gave it, whatever key wrote it.
        'default/user/2': doc('two'),
        'default/x/y': JSON.stringify({ legacy: true }),
        'default/gone': doc('expired', 1),
        'TenantA/k': doc('tenant A'),
        '_scratch/f': doc('not a tenant'),
        'notes.txt': 'not a tenant either',
      };
      for (const [relative, contents] of Object.entries(files))
        writeAt(legacyRoot, relative, contents);
      const before = snapshot(legacyRoot);

      const migrated = new FileSystemProvider(legacyRoot);

      const after = snapshot(legacyRoot);
      expect(legacyOnly(after)).toEqual(before);
      expect(new Map([...after].filter(([relative]) => relative.startsWith(`${DATA}/`)))).toEqual(
        new Map([
          ['_v2/default/session/abc123.json', files['default/session/abc123']],
          ['_v2/default/config%2ejson.json', files['default/config.json']],
          ['_v2/default/user/2.json', files['default/user/2']],
          ['_v2/default/x/y.json', files['default/x/y']],
          ['_v2/default/gone.json', files['default/gone']],
          ['_v2/%54enant%41/k.json', files['TenantA/k']],
        ]),
      );
      expect(readdirSync(legacyRoot).sort()).toEqual(
        ['TenantA', '_scratch', DATA, 'default', 'notes.txt'].sort(),
      );

      await expect(migrated.list('default', '', testContext)).resolves.toMatchObject({
        keys: ['config.json', 'session/abc123', 'user/2', 'x/y'],
      });
      await expect(
        migrated.getMany(
          'default',
          ['session/abc123', 'config.json', 'config', 'user/2', 'User/2', 'x/y', 'gone'],
          testContext,
        ),
      ).resolves.toEqual(
        new Map<string, unknown>([
          ['session/abc123', 'session'],
          ['config.json', 'config'],
          ['user/2', 'two'],
          ['x/y', { legacy: true }],
        ]),
      );

      const warnings = migrationWarnings();
      expect(warnings).toHaveLength(1);
      const [message, context] = warnings[0] ?? [];
      expect(message).toContain(`"${path.join(legacyRoot, DATA)}"`);
      expect(message).toMatch(/\((default, TenantA|TenantA, default)\)/);
      expect(context?.extra).toMatchObject({ notCopied: [] });
    });

    it('copies regular files only, following no symbolic link, as the earlier layout listed them', async () => {
      writeAt(legacyRoot, 'default/sub/f', doc('f'));
      writeAt(root, 'outside/secret', doc('outside the storage path'));
      symlinkSync(
        path.join(legacyRoot, 'default'),
        path.join(legacyRoot, 'default', 'sub', 'loop'),
      );
      symlinkSync(path.join(root, 'outside'), path.join(legacyRoot, 'default', 'outside'));
      symlinkSync(
        path.join(legacyRoot, 'default', 'sub', 'f'),
        path.join(legacyRoot, 'default', 'filelink'),
      );

      const migrated = new FileSystemProvider(legacyRoot);

      expect([...snapshot(path.join(legacyRoot, DATA)).keys()]).toEqual(['default/sub/f.json']);
      await expect(migrated.list('default', '', testContext)).resolves.toMatchObject({
        keys: ['sub/f'],
      });
    });

    it('gives a legacy tenant directory to the tenant it is named for only', async () => {
      writeAt(legacyRoot, 'TenantA/k', doc('tenant A'));

      const migrated = new FileSystemProvider(legacyRoot);

      await expect(migrated.get('TenantA', 'k', testContext)).resolves.toBe('tenant A');
      for (const variant of ['tenanta', 'TENANTA']) {
        await expect(migrated.get(variant, 'k', testContext)).resolves.toBeNull();
        await expect(migrated.list(variant, '', testContext)).resolves.toMatchObject({ keys: [] });
      }
    });

    it('copies a legacy tenant directory to the name its tenant ID now takes, past the name limit included', async () => {
      writeAt(legacyRoot, `${UPPER_86}/k`, doc('upper', 4_102_444_800_000));
      writeAt(legacyRoot, `${MIXED_128}/sub/x`, doc('mixed'));
      writeAt(legacyRoot, `${'U'.repeat(85)}/k`, doc('at the limit'));
      const before = snapshot(legacyRoot);

      const migrated = new FileSystemProvider(legacyRoot);

      const after = snapshot(legacyRoot);
      expect(legacyOnly(after)).toEqual(before);
      expect(new Map([...after].filter(([relative]) => relative.startsWith(`${DATA}/`)))).toEqual(
        new Map([
          [`_v2/${digestDir(UPPER_86)}/k.json`, before.get(`${UPPER_86}/k`)],
          [`_v2/${digestDir(MIXED_128)}/sub/x.json`, before.get(`${MIXED_128}/sub/x`)],
          [`_v2/${'%55'.repeat(85)}/k.json`, before.get(`${'U'.repeat(85)}/k`)],
        ]),
      );
      await expect(migrated.get(UPPER_86, 'k', testContext)).resolves.toBe('upper');
      await expect(migrated.list(MIXED_128, '', testContext)).resolves.toMatchObject({
        keys: ['sub/x'],
      });
      await expect(migrated.get(MIXED_128, 'sub/x', testContext)).resolves.toBe('mixed');
      await expect(migrated.get('U'.repeat(85), 'k', testContext)).resolves.toBe('at the limit');
      await expect(migrated.get('u'.repeat(86), 'k', testContext)).resolves.toBeNull();
      const [, context] = migrationWarnings()[0] ?? [];
      expect(context?.extra).toEqual({ notCopied: [] });
    });

    it('copies nothing on a later construction', async () => {
      writeAt(legacyRoot, 'default/a', doc('a'));
      new FileSystemProvider(legacyRoot);
      const dataBefore = snapshot(path.join(legacyRoot, DATA));
      writeAt(legacyRoot, 'default/late', doc('written by an earlier version afterwards'));
      warningSpy.mockClear();

      const again = new FileSystemProvider(legacyRoot);

      expect(snapshot(path.join(legacyRoot, DATA))).toEqual(dataBefore);
      await expect(again.get('default', 'late', testContext)).resolves.toBeNull();
      await expect(again.get('default', 'a', testContext)).resolves.toBe('a');
      expect(migrationWarnings()).toHaveLength(0);
    });

    it('creates the data root without a copy or a warning when no tenant directory is present', async () => {
      writeAt(legacyRoot, '_scratch/f', 'x');
      writeAt(legacyRoot, 'lost+found/f', 'x');
      writeAt(legacyRoot, 'file.txt', 'x');

      const fresh = new FileSystemProvider(legacyRoot);

      expect(readdirSync(path.join(legacyRoot, DATA))).toEqual([]);
      expect(migrationWarnings()).toHaveLength(0);
      await expect(fresh.list('default', '', testContext)).resolves.toMatchObject({ keys: [] });
    });

    it('leaves a file whose new name passes the name limit in place and names it', async () => {
      const longLeaf = `default/${'A'.repeat(84)}`;
      const longDir = `default/${'B'.repeat(86)}/f`;
      writeAt(legacyRoot, 'default/ok', doc('ok'));
      writeAt(legacyRoot, longLeaf, doc('leaf'));
      writeAt(legacyRoot, longDir, doc('dir'));
      const before = snapshot(legacyRoot);

      const migrated = new FileSystemProvider(legacyRoot);

      expect(legacyOnly(snapshot(legacyRoot))).toEqual(before);
      await expect(migrated.list('default', '', testContext)).resolves.toMatchObject({
        keys: ['ok'],
      });
      const [message, context] = migrationWarnings()[0] ?? [];
      expect(message).toContain('2 file(s), listed in notCopied, stayed behind');
      expect(context?.extra).toEqual({
        notCopied: expect.arrayContaining([longLeaf, longDir]),
      });
      expect(context?.extra?.notCopied).toHaveLength(2);
    });

    it('creates no data root when the copy fails, and copies in full on the next construction', async (testCase) => {
      writeAt(legacyRoot, 'default/a', doc('a'));
      writeAt(legacyRoot, 'default/b', doc('b'));
      const unreadable = path.join(legacyRoot, 'default', 'b');
      if (!lockFile(unreadable)) {
        testCase.skip('file modes do not bind this process (root or an ACL), so no fault occurs');
      }

      expect(() => new FileSystemProvider(legacyRoot)).toThrow(
        expect.objectContaining({ name: 'McpError', code: JsonRpcErrorCode.DatabaseError }),
      );
      expect(readdirSync(legacyRoot).sort()).toEqual(['default']);
      expect(migrationWarnings()).toHaveLength(0);

      chmodSync(unreadable, 0o644);
      const retried = new FileSystemProvider(legacyRoot);
      await expect(retried.getMany('default', ['a', 'b'], testContext)).resolves.toEqual(
        new Map([
          ['a', 'a'],
          ['b', 'b'],
        ]),
      );
    });

    it('settles two constructions racing over one earlier layout on one data root', async () => {
      writeAt(legacyRoot, 'default/a', doc('a'));
      writeAt(legacyRoot, 'default/b/c', doc('c'));
      writeAt(legacyRoot, 'TenantA/k', doc('tenant A'));
      let racer: FileSystemProvider | undefined;
      fsHooks.beforeRename = () => {
        // The first construction's copy is staged, not in place: nothing reads it yet.
        expect(existsSync(path.join(legacyRoot, DATA))).toBe(false);
        expect(
          readdirSync(legacyRoot).filter((name) => name.startsWith(`${DATA}.tmp-`)),
        ).toHaveLength(1);
        racer = new FileSystemProvider(legacyRoot);
      };

      const first = new FileSystemProvider(legacyRoot);

      expect(racer).toBeDefined();
      expect(readdirSync(legacyRoot).sort()).toEqual(['TenantA', DATA, 'default'].sort());
      expect([...snapshot(path.join(legacyRoot, DATA)).keys()].sort()).toEqual([
        '%54enant%41/k.json',
        'default/a.json',
        'default/b/c.json',
      ]);
      for (const instance of [first, racer as FileSystemProvider]) {
        await expect(instance.getMany('default', ['a', 'b/c'], testContext)).resolves.toEqual(
          new Map([
            ['a', 'a'],
            ['b/c', 'c'],
          ]),
        );
      }
      await first.set('default', 'shared', 'written by the first', testContext);
      await expect(racer?.get('default', 'shared', testContext)).resolves.toBe(
        'written by the first',
      );
      expect(migrationWarnings()).toHaveLength(1);
    });
  });
});
