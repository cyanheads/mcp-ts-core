/**
 * @fileoverview What a filesystem storage fault puts on the wire (#645). A real
 * `FileSystemProvider` sits behind `StorageService` and the production tool
 * handler factory, and each method meets a fault the host or the caller's key
 * produces: an unreadable file, a read-only directory, an unlistable
 * subdirectory, a storage root that cannot hold a new tenant, a key segment past
 * the file-name limit. The result names the key and never the storage root, and
 * the provider's own `Error in FileSystemProvider.<op>` record keeps the raw
 * `fs` error — its `code` and path — in `causeChain`. Runs on both lanes: Bun
 * and Node raise different `fs` errors for the same fault.
 * @module tests/unit/storage/providers/fileSystem/fileSystemProvider.failureWire.test
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';

import type { Context } from '@/core/context.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createToolHandler } from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { legacyCapabilityView, makeServerContext } from '../../../../helpers/server-context.js';

/** The tenant a stdio-shaped call resolves to, and so the directory its keys live in. */
const TENANT = 'default';
const LONG_KEY = 'a'.repeat(300);

const readMessage = (key: string) => `Failed to read stored value for key "${key}".`;
const writeMessage = (key: string) => `Failed to write stored value for key "${key}".`;
const deleteMessage = (key: string) => `Failed to delete stored value for key "${key}".`;
const LIST_MESSAGE = 'Failed to list stored keys.';
const TENANT_MESSAGE = `Failed to create the storage directory for tenant "${TENANT}".`;
const tooLongMessage = (key: string) =>
  `Key "${key}" is too long for filesystem storage. Use a shorter key or shorter "/"-separated segments.`;

interface CauseNode {
  code?: string;
  message: string;
}

/** The part of an `ErrorHandler` record's context this suite reads. */
interface LoggedErrorContext {
  extra: { errorData: { causeChain?: CauseNode[] } };
}

/** A storage fault: the tree it leaves under `root`, and the call it breaks. */
interface Fault {
  /**
   * Seeds and breaks the store under `root`. Returns a probe: the raw `fs`
   * step the fault must make fail, or `undefined` when no file mode is
   * involved. A process running as root, or an ACL, can let the step succeed,
   * and the case then has no fault to observe.
   */
  arrange(
    root: string,
    setMode: (path: string, mode: number) => Promise<void>,
  ): Promise<(() => Promise<unknown>) | undefined>;
  call(ctx: Context, storage: StorageService): Promise<unknown>;
  code: JsonRpcErrorCode;
  /** The raw `fs` error's `code` on the record's `causeChain`. */
  errno: string;
  message: string;
  name: string;
  /** The provider method whose `Error in FileSystemProvider.<op>` record is checked. */
  operation: string;
}

/** Writes `keys` through the provider itself, as an earlier call would have. */
async function seed(root: string, ...keys: string[]) {
  const provider = new FileSystemProvider(root);
  const context = requestContextService.createRequestContext({ operation: 'seed' });
  for (const key of keys) await provider.set(TENANT, key, { seeded: key }, context);
}

const tenantDir = (root: string) => join(root, TENANT);

/** `item/1` unreadable and unwritable; `item/2` beside it untouched. */
async function lockItem(root: string, setMode: (path: string, mode: number) => Promise<void>) {
  await seed(root, 'item/1', 'item/2');
  const file = join(tenantDir(root), 'item', '1');
  await setMode(file, 0o000);
  return file;
}

/** `ro/a` stored in a directory nothing can be added to or removed from. */
async function lockDir(root: string, setMode: (path: string, mode: number) => Promise<void>) {
  await seed(root, 'ro/a');
  const dir = join(tenantDir(root), 'ro');
  await setMode(dir, 0o555);
  return () => writeFile(join(dir, 'probe'), '');
}

const FAULTS: Fault[] = [
  {
    name: 'get on an unreadable file',
    async arrange(root, setMode) {
      const file = await lockItem(root, setMode);
      return () => readFile(file);
    },
    call: (ctx) => ctx.state.get('item/1'),
    operation: 'get',
    code: JsonRpcErrorCode.DatabaseError,
    message: readMessage('item/1'),
    errno: 'EACCES',
  },
  {
    name: 'getMany with one unreadable file',
    async arrange(root, setMode) {
      const file = await lockItem(root, setMode);
      return () => readFile(file);
    },
    call: (ctx) => ctx.state.getMany(['item/1', 'item/2']),
    operation: 'getMany',
    code: JsonRpcErrorCode.DatabaseError,
    message: readMessage('item/1'),
    errno: 'EACCES',
  },
  {
    name: 'set over an unwritable file',
    async arrange(root, setMode) {
      const file = await lockItem(root, setMode);
      return () => writeFile(file, 'probe');
    },
    call: (ctx) => ctx.state.set('item/1', { v: 2 }),
    operation: 'set',
    code: JsonRpcErrorCode.DatabaseError,
    message: writeMessage('item/1'),
    errno: 'EACCES',
  },
  {
    name: 'setMany over an unwritable file',
    async arrange(root, setMode) {
      const file = await lockItem(root, setMode);
      return () => writeFile(file, 'probe');
    },
    call: (ctx) => ctx.state.setMany(new Map([['item/1', { v: 2 }]])),
    operation: 'setMany',
    code: JsonRpcErrorCode.DatabaseError,
    message: writeMessage('item/1'),
    errno: 'EACCES',
  },
  {
    name: 'set of a new subdirectory under a read-only directory',
    arrange: lockDir,
    call: (ctx) => ctx.state.set('ro/sub/x', { v: 1 }),
    operation: 'set',
    code: JsonRpcErrorCode.DatabaseError,
    message: writeMessage('ro/sub/x'),
    errno: 'EACCES',
  },
  {
    name: 'delete in a read-only directory',
    arrange: lockDir,
    call: (ctx) => ctx.state.delete('ro/a'),
    operation: 'delete',
    code: JsonRpcErrorCode.DatabaseError,
    message: deleteMessage('ro/a'),
    errno: 'EACCES',
  },
  {
    name: 'deleteMany in a read-only directory',
    arrange: lockDir,
    call: (ctx) => ctx.state.deleteMany(['ro/a']),
    operation: 'deleteMany',
    code: JsonRpcErrorCode.DatabaseError,
    message: deleteMessage('ro/a'),
    errno: 'EACCES',
  },
  {
    name: 'StorageService.clear over a read-only directory',
    arrange: lockDir,
    call: (ctx, storage) => storage.clear(ctx),
    operation: 'clear',
    code: JsonRpcErrorCode.DatabaseError,
    message: deleteMessage('ro/a'),
    errno: 'EACCES',
  },
  {
    name: 'list over an unlistable subdirectory',
    async arrange(root, setMode) {
      await seed(root, 'shown/a', 'hidden/a');
      const dir = join(tenantDir(root), 'hidden');
      await setMode(dir, 0o000);
      return () => readdir(dir);
    },
    call: (ctx) => ctx.state.list(''),
    operation: 'list',
    code: JsonRpcErrorCode.DatabaseError,
    message: LIST_MESSAGE,
    errno: 'EACCES',
  },
  ...(['get', 'set', 'delete'] as const).map(
    (operation): Fault => ({
      name: `${operation} for a tenant the storage root cannot hold`,
      async arrange(root, setMode) {
        await setMode(root, 0o555);
        return () => mkdir(join(root, 'probe'));
      },
      call: (ctx) =>
        operation === 'set' ? ctx.state.set('k', { v: 1 }) : ctx.state[operation]('k'),
      operation,
      code: JsonRpcErrorCode.DatabaseError,
      message: TENANT_MESSAGE,
      errno: 'EACCES',
    }),
  ),
  ...(['get', 'set', 'delete'] as const).map(
    (operation): Fault => ({
      name: `${operation} of a key segment past the file-name limit`,
      arrange: async () => undefined,
      call: (ctx) =>
        operation === 'set' ? ctx.state.set(LONG_KEY, { v: 1 }) : ctx.state[operation](LONG_KEY),
      operation,
      code: JsonRpcErrorCode.ValidationError,
      message: tooLongMessage(LONG_KEY),
      errno: 'ENAMETOOLONG',
    }),
  ),
];

describe('a filesystem storage fault on the wire (#645)', () => {
  let root: string;
  /** Every spelling of `root` a message could carry — `tmpdir()` is a symlink on macOS. */
  let rootSpellings: string[];
  const restores: Array<() => Promise<void>> = [];
  let errorSpy: MockInstance<typeof logger.error>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-storage-wire-test-'));
    rootSpellings = [...new Set([root, await realpath(root)])];
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const restore of restores.splice(0).reverse()) await restore();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function setMode(path: string, mode: number) {
    await chmod(path, mode);
    restores.push(() => chmod(path, 0o755));
  }

  /** `call` run by a tool whose `ctx.state` is backed by the provider at `root`. */
  async function callTool(
    call: (ctx: Context, storage: StorageService) => Promise<unknown>,
  ): Promise<CallToolResult> {
    const storage = new StorageService(new FileSystemProvider(root));
    const definition = tool('state_op', {
      description: 'Runs one storage operation.',
      input: z.object({}),
      output: z.object({ ok: z.boolean().describe('Always true') }),
      async handler(_input, ctx) {
        await call(ctx, storage);
        return { ok: true };
      },
    });
    const handler = createToolHandler(
      definition as AnyToolDefinition,
      { logger: logger as never, storage } as never,
      {},
      legacyCapabilityView({}),
    );
    return (await handler({}, makeServerContext({}))) as CallToolResult;
  }

  function expectNoStorageRoot(text: string) {
    for (const spelling of rootSpellings) expect(text).not.toContain(spelling);
  }

  /** The raw `fs` errors on the provider's `Error in FileSystemProvider.<operation>` record. */
  function loggedCauseChain(operation: string): CauseNode[] | undefined {
    const record = errorSpy.mock.calls.find(([message]) =>
      String(message).startsWith(`Error in FileSystemProvider.${operation}: `),
    );
    expect(record, `an Error in FileSystemProvider.${operation} record`).toBeDefined();
    return (record?.[1] as LoggedErrorContext | undefined)?.extra.errorData.causeChain;
  }

  it.for(FAULTS)('$name rejects without the storage root', async (fault, testContext) => {
    const probe = await fault.arrange(root, setMode);
    const faultHolds = probe
      ? await probe().then(
          () => false,
          () => true,
        )
      : true;
    if (!faultHolds) {
      testContext.skip('file modes do not bind this process (root or an ACL), so no fault occurs');
    }

    const result = await callTool(fault.call);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data?: Record<string, unknown>; message: string };
    };
    expect(error.code).toBe(fault.code);
    expect(error.message).toBe(fault.message);
    expect(error.data?.originalMessage).toBe(fault.message);
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain(`Error: ${fault.message}`);
    expectNoStorageRoot(error.message);
    expectNoStorageRoot(text);
    // Every `data` value, the raw cause's message never among them (#644).
    expect(error.data).not.toHaveProperty('rootCause');
    expectNoStorageRoot(JSON.stringify(error.data));

    // The provider's own record keeps the raw fs error for the operator.
    const raw = loggedCauseChain(fault.operation)?.find((node) => node.code === fault.errno);
    expect(raw, `a ${fault.errno} node on causeChain`).toBeDefined();
    expect(raw?.message).toContain(root);
  });

  it('a stored key beside the fault still reads', async () => {
    await lockItem(root, setMode);

    const result = await callTool(async (ctx) => {
      expect(await ctx.state.get('item/2')).toEqual({ seeded: 'item/2' });
    });

    expect(result.isError).toBeFalsy();
  });
});
