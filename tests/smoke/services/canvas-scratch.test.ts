/**
 * @fileoverview Scratch I/O of the DuckDB canvas provider against real DuckDB
 * and the real filesystem: where spill files, stream-export staging, and
 * `importFrom` staging land, and that the canvas lifecycle leaves none of it
 * behind (#554, #561). Every provider here gets its scratch parent from a
 * throwaway `mkdtemp` directory, and the default-root case points `TMPDIR` at
 * one, so no test reads or writes the shared OS temp root.
 * @module tests/smoke/services/canvas-scratch.test
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasRegistry } from '@/services/canvas/core/CanvasRegistry.js';
import { DataCanvas } from '@/services/canvas/core/DataCanvas.js';
import { DuckdbProvider } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import type { ColumnSchema } from '@/services/canvas/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ctx: RequestContext = {
  requestId: 'smoke-canvas-scratch',
  timestamp: '2026-01-01T00:00:00.000Z',
  tenantId: 'smoke-tenant',
};

const IS_POSIX = process.platform !== 'win32';
const RUNNING_AS_ROOT = process.getuid?.() === 0;
/** What `mkdtemp(join(parent, 'mcp-canvas-'))` names a provider's private directory. */
const PRIVATE_DIR = /^mcp-canvas-[A-Za-z0-9]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Sized from the #561 reproduction: 400,000 rows of a BIGINT and a 64-char
 * string are well past a 24 MB `memory_limit`, so staging them always spills.
 * Spilling is decided by the limit, not by timing, so the size is safe under
 * full-suite load.
 */
const SPILL_MEMORY_LIMIT_MB = 24;
const SPILL_ROWS = 400_000;
const SPILL_SCHEMA: ColumnSchema[] = [
  { name: 'i', type: 'BIGINT' },
  { name: 'pad', type: 'VARCHAR' },
];
/** A canvas that read back its own rows: count, rows carrying its tag, and sum(i) over 0..N-1. */
const EXACT_READBACK = { n: '400000', own: '400000', s: '79999800000' };
/** The fixed names DuckDB gives spill files in a `temp_directory`. */
const SPILL_FILE_NAMES = [
  'duckdb_temp_storage_DEFAULT-0.tmp',
  'duckdb_temp_storage_S32K-0.tmp',
  'duckdb_temp_storage_S64K-0.tmp',
  'duckdb_temp_storage_S128K-0.tmp',
];

function* spillRows(tag: string, count = SPILL_ROWS): Generator<Record<string, unknown>> {
  for (let i = 0; i < count; i += 1) yield { i, pad: `${tag}-${i}-`.padEnd(64, 'x') };
}

/** The error `run` rejects with; fails the test when it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  return await run().then(
    () => {
      throw new Error('Expected a rejection.');
    },
    (err: unknown) => err,
  );
}

/**
 * An engine I/O fault as #565 settles it: `DatabaseError` with no caller-side
 * reason, the host directory replaced by `[path]` in the message, and the raw
 * engine error — path included — kept on `cause`.
 */
function expectRedactedIoFault(err: unknown, hostDir: string): void {
  expect(err).toBeInstanceOf(McpError);
  const mcp = err as McpError;
  expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
  expect(mcp.data?.reason).toBeUndefined();
  expect(mcp.message).not.toContain(hostDir);
  expect(mcp.message).toContain('[path]');
  expect((mcp.cause as Error).message).toContain(hostDir);
}

async function stageSpilling(provider: DuckdbProvider, canvasId: string, tag: string) {
  await provider.registerTable(canvasId, 't', spillRows(tag), ctx, { schema: SPILL_SCHEMA });
}

async function readBack(provider: DuckdbProvider, canvasId: string, tag: string) {
  const result = await provider.query(
    canvasId,
    `SELECT count(*) AS n, count(*) FILTER (WHERE starts_with(pad, '${tag}-')) AS own, sum(i) AS s FROM t`,
    ctx,
  );
  return result.rows[0];
}

/** Every regular file (and symlink) under `dir`, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** Private scratch directories a provider made under `parent`. */
async function privateDirsUnder(parent: string): Promise<string[]> {
  return (await readdir(parent))
    .filter((name) => PRIVATE_DIR.test(name))
    .map((name) => join(parent, name));
}

/** Subdirectories of `dir` — one per canvas whose DuckDB instance has spilled. */
async function subdirsOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/**
 * Reach the provider's private resolver, which starts creating the scratch
 * directory, so a test can order its own continuation ahead of a canvas's.
 */
function scratchDirOf(provider: DuckdbProvider): Promise<string> {
  return (provider as unknown as { ensureTempRoot(): Promise<string> }).ensureTempRoot();
}

/**
 * A stream whose first write resolves `writing` and then blocks until
 * `release(fail?)`, rejecting with `fail` when one is given: a consumer
 * stalled mid-export.
 */
function stalledStream(): {
  chunks: Uint8Array[];
  release(fail?: Error): void;
  stream: WritableStream<Uint8Array>;
  writing: Promise<void>;
} {
  const chunks: Uint8Array[] = [];
  const writing = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  return {
    chunks,
    release: (fail) => (fail ? gate.reject(fail) : gate.resolve()),
    stream: new WritableStream<Uint8Array>({
      async write(chunk) {
        chunks.push(chunk);
        writing.resolve();
        await gate.promise;
      },
    }),
    writing: writing.promise,
  };
}

/** Collects everything written to it; the bytes a stream export delivered. */
function collectingStream(): { stream: WritableStream<Uint8Array>; text(): string } {
  const chunks: Uint8Array[] = [];
  return {
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Counts the lines written to it without keeping them: the rows a large CSV stream export delivered, plus its header. */
function lineCountingStream(): { lines(): number; stream: WritableStream<Uint8Array> } {
  let lines = 0;
  return {
    lines: () => lines,
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        for (const byte of chunk) if (byte === 0x0a) lines += 1;
      },
    }),
  };
}

/**
 * Holds the next DuckDB connection opened — a canvas call's own per-query
 * connection — open and idle before its first statement until `release()`:
 * a call in flight on the canvas at a moment the test chooses.
 */
function pauseNextConnection(): { reached: Promise<void>; release(): void } {
  const connect = DuckDBInstance.prototype.connect;
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  vi.spyOn(DuckDBInstance.prototype, 'connect').mockImplementationOnce(async function (
    this: DuckDBInstance,
  ) {
    const connection = await connect.call(this);
    reached.resolve();
    await gate.promise;
    return connection;
  });
  return { reached: reached.promise, release: () => gate.resolve() };
}

describe('canvas · DuckDB scratch I/O', () => {
  const parents: string[] = [];
  const providers: DuckdbProvider[] = [];

  async function throwaway(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-scratch-smoke-'));
    parents.push(dir);
    return dir;
  }

  /** A provider whose scratch parent (`CANVAS_TEMP_PATH`) is `parent`, or a fresh throwaway directory. */
  async function makeProvider(
    options: { memoryLimitMb?: number; parent?: string } = {},
  ): Promise<{ parent: string; provider: DuckdbProvider }> {
    const parent = options.parent ?? (await throwaway());
    const provider = new DuckdbProvider({
      defaultRowLimit: 1000,
      exportRootPath: join(parent, 'exports'),
      memoryLimitMb: options.memoryLimitMb ?? 256,
      schemaSniffRows: 100,
      tempRootPath: parent,
    });
    providers.push(provider);
    return { parent, provider };
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.allSettled(providers.splice(0).map((p) => p.shutdown()));
    for (const dir of parents.splice(0)) {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a stream export delivers the table and leaves no scratch file behind', async () => {
    const { parent, provider } = await makeProvider();
    await provider.initCanvas('streamexp1', ctx);
    await provider.registerTable(
      'streamexp1',
      'export_me',
      [
        { id: 1, label: 'alpha' },
        { id: 2, label: 'beta' },
      ],
      ctx,
    );

    const sink = collectingStream();
    const result = await provider.export(
      'streamexp1',
      'export_me',
      { format: 'csv', stream: sink.stream },
      ctx,
    );

    expect(sink.text()).toBe('id,label\n1,alpha\n2,beta\n');
    expect(result).toEqual({ format: 'csv', rowCount: 2, sizeBytes: 24 });
    expect(await filesUnder(parent)).toEqual([]);
  });

  it('importFrom round-trips a table and leaves no scratch file behind', async () => {
    const { parent, provider } = await makeProvider();
    await provider.initCanvas('importsrc1', ctx);
    await provider.initCanvas('importdst1', ctx);
    await provider.registerTable(
      'importsrc1',
      'orders',
      [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
      ctx,
    );

    const imported = await provider.importFrom('importdst1', 'importsrc1', 'orders', 'copy', ctx);

    expect(imported).toEqual({ tableName: 'copy', rowCount: 2, columns: ['id', 'name'] });
    const rows = await provider.query('importdst1', 'SELECT id, name FROM copy ORDER BY id', ctx);
    expect(rows.rows).toEqual([
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ]);
    expect(await filesUnder(parent)).toEqual([]);
  });

  // #561 — DuckDB names spill files by block size alone, so two instances
  // sharing a temp_directory overwrite each other's evicted blocks. Two rounds
  // also cover destroy-then-re-create on the same provider.
  it('#561 — two canvases spilling past memory_limit each read back their own rows exactly', async () => {
    const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });

    for (const round of [1, 2]) {
      const one = `round${round}one`;
      const two = `round${round}two`;
      await provider.initCanvas(one, ctx);
      await provider.initCanvas(two, ctx);
      await stageSpilling(provider, one, 'AAA');
      await stageSpilling(provider, two, 'BBB');
      // Listed before reading back, while both tables' evicted blocks are on disk.
      const [scratch = '', ...otherScratch] = await privateDirsUnder(parent);
      const spillDirs = scratch ? await subdirsOf(scratch) : [];

      expect(await readBack(provider, one, 'AAA')).toEqual(EXACT_READBACK);
      expect(await readBack(provider, two, 'BBB')).toEqual(EXACT_READBACK);

      // Both spilled, each into a directory of its own inside the private one.
      expect(otherScratch).toEqual([]);
      expect(spillDirs).toHaveLength(2);
      for (const dir of spillDirs) {
        expect(dir).toMatch(UUID);
        const names = await readdir(join(scratch, dir));
        expect(names.some((name) => name.startsWith('duckdb_temp_storage_'))).toBe(true);
      }

      await provider.destroyCanvas(one, ctx);
      await provider.destroyCanvas(two, ctx);
      expect(await subdirsOf(scratch)).toEqual([]);
    }
  }, 60_000);

  it('#561 — providers sharing one CANVAS_TEMP_PATH never share a spill file', async () => {
    const parent = await throwaway();
    const { provider: first } = await makeProvider({
      memoryLimitMb: SPILL_MEMORY_LIMIT_MB,
      parent,
    });
    const { provider: second } = await makeProvider({
      memoryLimitMb: SPILL_MEMORY_LIMIT_MB,
      parent,
    });
    await first.initCanvas('provfirst1', ctx);
    await second.initCanvas('provsecnd2', ctx);
    await stageSpilling(first, 'provfirst1', 'AAA');
    await stageSpilling(second, 'provsecnd2', 'BBB');

    expect(await readBack(first, 'provfirst1', 'AAA')).toEqual(EXACT_READBACK);
    expect(await readBack(second, 'provsecnd2', 'BBB')).toEqual(EXACT_READBACK);
    expect(await privateDirsUnder(parent)).toHaveLength(2);

    // Shutting one provider down leaves the other's directory and data alone.
    await first.shutdown();
    expect(await privateDirsUnder(parent)).toHaveLength(1);
    expect(await readBack(second, 'provsecnd2', 'BBB')).toEqual(EXACT_READBACK);
    await second.shutdown();
    expect(await readdir(parent)).toEqual([]);
  }, 60_000);

  // #554 — the old default root was a fixed `<tmpdir>/mcp-canvas` accepted
  // whatever its owner or mode, and DuckDB followed links planted at its spill
  // names. "Another user" is simulated by pre-creating the root world-writable.
  it.skipIf(!IS_POSIX)(
    '#554 — with CANVAS_TEMP_PATH unset, spills never touch a planted <tmpdir>/mcp-canvas',
    async () => {
      const fakeTmp = await throwaway();
      const shared = join(fakeTmp, 'mcp-canvas');
      const victims = join(fakeTmp, 'victims');
      await mkdir(shared);
      await chmod(shared, 0o777);
      await mkdir(victims);
      for (const name of SPILL_FILE_NAMES) {
        await writeFile(join(victims, name), 'VICTIM-CONTENT\n');
        await symlink(join(victims, name), join(shared, name));
      }
      vi.stubEnv('TMPDIR', fakeTmp);
      const provider = new DuckdbProvider({
        defaultRowLimit: 1000,
        exportRootPath: join(fakeTmp, 'exports'),
        memoryLimitMb: SPILL_MEMORY_LIMIT_MB,
        schemaSniffRows: 100,
      });
      providers.push(provider);

      await provider.initCanvas('defaultrt1', ctx);
      await stageSpilling(provider, 'defaultrt1', 'AAA');

      expect(await readBack(provider, 'defaultrt1', 'AAA')).toEqual(EXACT_READBACK);
      for (const name of SPILL_FILE_NAMES) {
        expect(await readFile(join(victims, name), 'utf8')).toBe('VICTIM-CONTENT\n');
      }
      expect(await modeOf(shared)).toBe(0o777);
      expect((await readdir(shared)).sort()).toEqual([...SPILL_FILE_NAMES].sort());
      const [scratch = '', ...others] = await privateDirsUnder(fakeTmp);
      expect(others).toEqual([]);
      expect(await modeOf(scratch)).toBe(0o700);
      const spilled = await filesUnder(scratch);
      expect(spilled.some((file) => basename(file).startsWith('duckdb_temp_storage_'))).toBe(true);

      await provider.shutdown();
      expect((await readdir(fakeTmp)).sort()).toEqual(['mcp-canvas', 'victims']);
    },
    60_000,
  );

  it('drop, TTL eviction, and shutdown leave no per-canvas or private directory behind', async () => {
    const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });
    let now = 1_000_000;
    const registry = new CanvasRegistry(
      provider,
      { ttlMs: 60_000, absoluteCapMs: 600_000, maxCanvasesPerTenant: 10, sweeperIntervalMs: 0 },
      () => now,
    );
    const canvas = new DataCanvas(provider, registry);

    const dropped = await canvas.acquire(undefined, ctx);
    await dropped.registerTable('t', spillRows('AAA'), { schema: SPILL_SCHEMA });
    const [scratch = ''] = await privateDirsUnder(parent);
    const [firstSpillDir, ...moreAfterFirst] = await subdirsOf(scratch);
    expect(firstSpillDir).toMatch(UUID);
    expect(moreAfterFirst).toEqual([]);
    expect(await canvas.drop(dropped.canvasId, ctx)).toBe(true);
    expect(await subdirsOf(scratch)).toEqual([]);

    const expiring = await canvas.acquire(undefined, ctx);
    await expiring.registerTable('t', spillRows('BBB'), { schema: SPILL_SCHEMA });
    const [secondSpillDir, ...moreAfterSecond] = await subdirsOf(scratch);
    expect(secondSpillDir).toMatch(UUID);
    expect(secondSpillDir).not.toBe(firstSpillDir);
    expect(moreAfterSecond).toEqual([]);
    now += 60_001;
    await registry.sweep();
    expect(await subdirsOf(scratch)).toEqual([]);
    expect(await filesUnder(scratch)).toEqual([]);

    await canvas.acquire(undefined, ctx);
    await canvas.shutdown(ctx);
    expect(await readdir(parent)).toEqual([]);
  }, 60_000);

  it('stages a stream export in the private directory under a random UUID name', async () => {
    const { parent, provider } = await makeProvider();
    await provider.initCanvas('streamname', ctx);
    await provider.registerTable('streamname', 'export_me', [{ id: 1, label: 'alpha' }], ctx);

    let staged: string[] | undefined;
    const stream = new WritableStream<Uint8Array>({
      async write() {
        staged ??= await filesUnder(parent);
      },
    });
    await provider.export('streamname', 'export_me', { format: 'csv', stream }, ctx);

    expect(staged).toHaveLength(1);
    const [file = ''] = staged ?? [];
    expect(dirname(file)).toMatch(PRIVATE_DIR);
    expect(basename(file, '.csv')).toMatch(UUID);
    expect(basename(file).endsWith('.csv')).toBe(true);
    if (IS_POSIX) expect(await modeOf(join(parent, dirname(file)))).toBe(0o700);
    expect(await filesUnder(parent)).toEqual([]);
  });

  // #554 — once shutdown frees the private directory's name, any local user can
  // re-create it in a shared parent, and DuckDB creates only the leaf of its
  // temp_directory, so it would spill into whatever sits there. A stream export
  // still piping its scratch file is work that must finish inside the private
  // directory: shutdown returns without waiting on the stalled consumer, the
  // directory stays (its name cannot be taken), and it goes once the export
  // settles, whichever way it settles.
  describe('#554 — shutdown with a stream export in flight', () => {
    async function exportInFlight() {
      const { parent, provider } = await makeProvider();
      await provider.initCanvas('inflight01', ctx);
      await provider.registerTable(
        'inflight01',
        'export_me',
        [
          { id: 1, label: 'alpha' },
          { id: 2, label: 'beta' },
        ],
        ctx,
      );
      const [scratch = ''] = await privateDirsUnder(parent);
      const consumer = stalledStream();
      const exporting = provider.export(
        'inflight01',
        'export_me',
        { format: 'csv', stream: consumer.stream },
        ctx,
      );
      await consumer.writing;
      await provider.shutdown();
      return { consumer, exporting, parent, provider, scratch };
    }

    it.skipIf(!IS_POSIX)(
      'keeps the private directory until the export completes, then removes it',
      async () => {
        const { consumer, exporting, parent, provider, scratch } = await exportInFlight();

        expect(await readdir(parent)).toEqual([basename(scratch)]);
        expect(await modeOf(scratch)).toBe(0o700);
        await expect(mkdir(scratch)).rejects.toMatchObject({ code: 'EEXIST' });
        // The canvas itself is gone; only the export already running continues.
        expect(
          await rejectionOf(() => provider.query('inflight01', 'SELECT 1 AS x', ctx)),
        ).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'canvas_not_found' } });

        consumer.release();
        await expect(exporting).resolves.toEqual({ format: 'csv', rowCount: 2, sizeBytes: 24 });
        expect(Buffer.concat(consumer.chunks).toString('utf8')).toBe('id,label\n1,alpha\n2,beta\n');
        await vi.waitFor(async () => expect(await readdir(parent)).toEqual([]));
      },
    );

    it.skipIf(!IS_POSIX)(
      'removes the private directory once an export that fails settles',
      async () => {
        const { consumer, exporting, parent, scratch } = await exportInFlight();
        expect(await readdir(parent)).toEqual([basename(scratch)]);

        const consumerFault = new Error('consumer went away');
        consumer.release(consumerFault);
        await expect(exporting).rejects.toMatchObject({ message: 'consumer went away' });
        await vi.waitFor(async () => expect(await readdir(parent)).toEqual([]));
      },
    );
  });

  // A call's own connection keeps the canvas's database open past drop, TTL
  // eviction, and shutdown, and reads the blocks the canvas spilled back from
  // its spill directory. Removing that directory under the call fails it with
  // an IO Error on a missing spill file, so the directory stays until every
  // call on the canvas settles, and neither teardown waits for them.
  describe('a spilling export in flight when its canvas is torn down', () => {
    async function spillingExportInFlight() {
      const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });
      await provider.initCanvas('spillexp01', ctx);
      await stageSpilling(provider, 'spillexp01', 'AAA');
      await provider.registerView('spillexp01', 'v', 'SELECT i, pad FROM t', ctx);
      // The staged table's evicted blocks are on disk before the export starts.
      const [scratch = ''] = await privateDirsUnder(parent);
      const [spillDir = '', ...otherSpillDirs] = await subdirsOf(scratch);
      expect(otherSpillDirs).toEqual([]);
      const spilled = await readdir(join(scratch, spillDir));
      expect(spilled.some((name) => name.startsWith('duckdb_temp_storage_'))).toBe(true);

      const paused = pauseNextConnection();
      const sink = lineCountingStream();
      const exporting = provider.export(
        'spillexp01',
        'v',
        { format: 'csv', stream: sink.stream },
        ctx,
      );
      await paused.reached;
      return { exporting, parent, paused, provider, scratch, sink, spillDir };
    }

    it('destroyCanvas returns at once; the export reads back every row and the spill directory goes after it', async () => {
      const { exporting, paused, provider, scratch, sink, spillDir } =
        await spillingExportInFlight();

      await provider.destroyCanvas('spillexp01', ctx);
      const whileRunning = await subdirsOf(scratch);
      paused.release();

      await expect(exporting).resolves.toMatchObject({ format: 'csv', rowCount: SPILL_ROWS });
      expect(sink.lines()).toBe(SPILL_ROWS + 1);
      expect(whileRunning).toEqual([spillDir]);
      await vi.waitFor(async () => expect(await subdirsOf(scratch)).toEqual([]));
    }, 60_000);

    it('shutdown returns at once; the export reads back every row and the private directory goes after it', async () => {
      const { exporting, parent, paused, provider, scratch, sink, spillDir } =
        await spillingExportInFlight();

      await provider.shutdown();
      const whileRunning = await subdirsOf(scratch);
      paused.release();

      await expect(exporting).resolves.toMatchObject({ format: 'csv', rowCount: SPILL_ROWS });
      expect(sink.lines()).toBe(SPILL_ROWS + 1);
      expect(whileRunning).toEqual([spillDir]);
      await vi.waitFor(async () => expect(await readdir(parent)).toEqual([]));
    }, 60_000);
  });

  // #554 — a canvas whose creation straddles shutdown would come up bound to
  // the removed private directory and spill into whatever another local user
  // re-created under its name. It is refused instead.
  it.skipIf(!IS_POSIX)(
    'refuses a canvas created across shutdown, and nothing reaches a re-created private directory',
    async () => {
      const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });
      // Loads @duckdb/node-api, so initCanvas reaches the scratch directory
      // with no dynamic import in between.
      await provider.healthCheck();
      const root = scratchDirOf(provider);
      const init = provider.initCanvas('straddle01', ctx);
      // This continuation was queued on the directory before initCanvas's, so
      // shutdown begins before the canvas's DuckDB instance is created.
      const scratch = await root;
      const shuttingDown = provider.shutdown();

      const refused = await rejectionOf(() => init);
      await shuttingDown;

      expect(refused).toBeInstanceOf(McpError);
      expect(refused).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'Canvas provider shut down while the canvas was being created.',
      });
      expect(await readdir(parent)).toEqual([]);

      // "Another local user" re-creates the freed name, open to everyone.
      await mkdir(scratch);
      await chmod(scratch, 0o777);
      const notFound = { code: JsonRpcErrorCode.NotFound, data: { reason: 'canvas_not_found' } };
      expect(await rejectionOf(() => stageSpilling(provider, 'straddle01', 'AAA'))).toMatchObject(
        notFound,
      );
      expect(
        await rejectionOf(() =>
          provider.export(
            'straddle01',
            't',
            { format: 'csv', stream: collectingStream().stream },
            ctx,
          ),
        ),
      ).toMatchObject(notFound);
      expect(await readdir(scratch, { recursive: true })).toEqual([]);
    },
    60_000,
  );

  // With write access to the parent taken away once the private directory
  // exists, any staging that reached for the parent would fail — so these
  // succeeding shows export and importFrom staging stay inside the private one.
  it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
    'keeps stream-export and importFrom staging inside the private directory',
    async () => {
      const { parent, provider } = await makeProvider();
      await provider.initCanvas('rosource01', ctx);
      await provider.initCanvas('rotarget02', ctx);
      await provider.registerTable(
        'rosource01',
        'orders',
        [
          { id: 1, name: 'a' },
          { id: 2, name: 'b' },
        ],
        ctx,
      );

      await chmod(parent, 0o500);
      try {
        const sink = collectingStream();
        await provider.export('rosource01', 'orders', { format: 'csv', stream: sink.stream }, ctx);
        expect(sink.text()).toBe('id,name\n1,a\n2,b\n');

        const imported = await provider.importFrom(
          'rotarget02',
          'rosource01',
          'orders',
          'copy',
          ctx,
        );
        expect(imported.rowCount).toBe(2);
      } finally {
        await chmod(parent, 0o700);
      }
      const [scratch = ''] = await privateDirsUnder(parent);
      expect(await filesUnder(scratch)).toEqual([]);
    },
  );

  // #565 — an engine failure on the export, import, query, or staging path is
  // an I/O fault the caller cannot act on: DatabaseError, never a caller-side
  // reason such as sql_read_only, and never the export root or the scratch
  // directory in the message.
  describe('#565 — engine I/O faults', () => {
    it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
      'an export into a directory the server cannot write is a DatabaseError naming no host path',
      async () => {
        const { parent, provider } = await makeProvider();
        const exportRoot = join(parent, 'exports');
        await provider.initCanvas('permprobe1', ctx);
        await provider.registerTable('permprobe1', 't', [{ x: 1 }], ctx);
        await provider.export('permprobe1', 't', { format: 'csv', path: 'first.csv' }, ctx);
        await chmod(exportRoot, 0o500);
        try {
          const err = await rejectionOf(() =>
            provider.export('permprobe1', 't', { format: 'csv', path: 'out.csv' }, ctx),
          );
          expectRedactedIoFault(err, exportRoot);
          expect((err as McpError).message).toBe(
            'IO Error: Cannot open file "[path]/out.csv": Permission denied',
          );
        } finally {
          await chmod(exportRoot, 0o700);
        }
      },
    );

    // The export root is reached through a link, as a symlinked
    // CANVAS_EXPORT_PATH is and as /tmp and /var are on macOS. A fault in the
    // sandbox walk must quote the root as configured, the path the provider
    // redacts, never its realpath.
    it.skipIf(!IS_POSIX)(
      'an export fault under a symlinked export root names no host path',
      async () => {
        const parent = await throwaway();
        const realRoot = join(parent, 'real-exports');
        await mkdir(realRoot);
        await symlink(realRoot, join(parent, 'exports'));
        await writeFile(join(realRoot, 'sub'), 'a file, not a directory');
        const { provider } = await makeProvider({ parent });
        await provider.initCanvas('linkroot01', ctx);
        await provider.registerTable('linkroot01', 't', [{ x: 1 }], ctx);

        const err = await rejectionOf(() =>
          provider.export('linkroot01', 't', { format: 'csv', path: 'sub/out.csv' }, ctx),
        );

        expectRedactedIoFault(err, parent);
        expect((err as McpError).message).toBe(
          "ENOTDIR: not a directory, lstat '[path]/sub/out.csv'",
        );
      },
    );

    it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
      'stream-export and importFrom staging failures name no scratch path',
      async () => {
        const { parent, provider } = await makeProvider();
        await provider.initCanvas('stagesrc01', ctx);
        await provider.initCanvas('stagedst02', ctx);
        await provider.registerTable('stagesrc01', 'orders', [{ id: 1 }], ctx);
        const [scratch = ''] = await privateDirsUnder(parent);
        await chmod(scratch, 0o500);
        try {
          const exportErr = await rejectionOf(() =>
            provider.export(
              'stagesrc01',
              'orders',
              { format: 'csv', stream: collectingStream().stream },
              ctx,
            ),
          );
          expectRedactedIoFault(exportErr, scratch);

          const importErr = await rejectionOf(() =>
            provider.importFrom('stagedst02', 'stagesrc01', 'orders', 'copy', ctx),
          );
          expectRedactedIoFault(importErr, scratch);
        } finally {
          await chmod(scratch, 0o700);
        }
      },
    );

    // 150,000 rows stage inside the 24 MB limit; materializing a doubled copy
    // of them does not fit, so the query has to open a spill directory.
    it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
      'a query whose spill cannot start is a DatabaseError naming no scratch path',
      async () => {
        const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });
        await provider.initCanvas('queryspill', ctx);
        await provider.registerTable('queryspill', 't', spillRows('AAA', 150_000), ctx, {
          schema: SPILL_SCHEMA,
        });
        const [scratch = ''] = await privateDirsUnder(parent);
        expect(await subdirsOf(scratch)).toEqual([]);
        await chmod(scratch, 0o500);
        try {
          const err = await rejectionOf(() =>
            provider.query('queryspill', 'SELECT i, pad || pad AS p FROM t', ctx, {
              registerAs: 'doubled',
            }),
          );
          expectRedactedIoFault(err, scratch);
        } finally {
          await chmod(scratch, 0o700);
        }
      },
      60_000,
    );

    it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
      'a staging spill that cannot start is a DatabaseError naming no scratch path',
      async () => {
        const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });
        await provider.initCanvas('stagespill', ctx);
        const [scratch = ''] = await privateDirsUnder(parent);
        await chmod(scratch, 0o500);
        try {
          const err = await rejectionOf(() => stageSpilling(provider, 'stagespill', 'AAA'));
          expectRedactedIoFault(err, scratch);
        } finally {
          await chmod(scratch, 0o700);
        }
      },
      60_000,
    );

    // describe() counts a view's rows by running it, so a view too large for
    // the memory limit spills there too.
    it.skipIf(!IS_POSIX || RUNNING_AS_ROOT)(
      'describe counting a view whose spill cannot start names no scratch path',
      async () => {
        const { parent, provider } = await makeProvider({ memoryLimitMb: SPILL_MEMORY_LIMIT_MB });
        await provider.initCanvas('descspill1', ctx);
        await provider.registerTable('descspill1', 't', spillRows('AAA', 150_000), ctx, {
          schema: SPILL_SCHEMA,
        });
        await provider.registerView(
          'descspill1',
          'v',
          'SELECT i, pad || pad || pad AS p FROM t ORDER BY p DESC',
          ctx,
        );
        const [scratch = ''] = await privateDirsUnder(parent);
        await chmod(scratch, 0o500);
        try {
          expectRedactedIoFault(
            await rejectionOf(() => provider.describe('descspill1', ctx)),
            scratch,
          );
        } finally {
          await chmod(scratch, 0o700);
        }
      },
      60_000,
    );

    // Only engine errors naming a host path are rewritten; a failure raised by
    // the caller's own rows, or a cancellation, reaches the caller as thrown.
    it('passes a row source failure and a cancellation through registerTable untouched', async () => {
      const { provider } = await makeProvider();
      await provider.initCanvas('passthru01', ctx);

      const upstream = new TypeError('upstream fetch failed');
      function* failingRows(): Generator<Record<string, unknown>> {
        yield { id: 1 };
        throw upstream;
      }
      await expect(
        provider.registerTable('passthru01', 'rows', failingRows(), ctx, {
          schema: [{ name: 'id', type: 'INTEGER' }],
        }),
      ).rejects.toBe(upstream);

      const controller = new AbortController();
      controller.abort();
      const aborted = await rejectionOf(() =>
        provider.registerTable('passthru01', 'rows', [{ id: 1 }], ctx, {
          signal: controller.signal,
        }),
      );
      expect((aborted as Error).name).toBe('AbortError');
    });
  });
});
