/**
 * @fileoverview What a broken mirror store puts on the wire (#635). A real
 * `sqliteMirrorStore` sits behind a tool, a resource, and a prompt, then is
 * broken three ways — a store file with no permissions, a corrupted header, a
 * parent directory that cannot be created. Every surface a caller reads (the
 * `runToolContract` envelope, `tools/call` through the production tool
 * factory, `resources/read`, `prompts/get`) names the store by its basename and
 * carries a recovery hint, never the host directory. The suite runs on both
 * drivers: `bun:sqlite` on the Bun lane, `better-sqlite3` on the Node lane.
 * @module tests/unit/services/mirror/storeFailureWire
 */

import { chmod, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { MIRROR_STORE_UNAVAILABLE_HINT } from '@/services/mirror/sqlite/handle.js';
import { sqliteMirrorStore } from '@/services/mirror/sqlite/sqliteMirrorStore.js';
import type { MirrorStore } from '@/services/mirror/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { runToolContract } from '@/testing/index.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';

/** Root ignores file modes, so a `chmod` cannot make a path unreadable or unwritable. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

const STORE_FILE = 'records.db';
const MESSAGE = `Failed to open mirror store "${STORE_FILE}".`;
const RESOURCE_URI = 'mirror://records/count';

/** The tool, resource, and prompt a server would put in front of `store`. */
function definitionsFor(store: MirrorStore) {
  return {
    tool: tool('mirror_count', {
      description: 'Count mirrored rows.',
      input: z.object({}),
      output: z.object({ count: z.number().describe('Rows') }),
      handler: async () => ({ count: await store.count() }),
    }),
    resource: resource(RESOURCE_URI, {
      description: 'Mirrored row count.',
      mimeType: 'application/json',
      handler: async () => ({ count: await store.count() }),
    }),
    prompt: prompt('mirror_summary', {
      description: 'Summarize the mirror.',
      generate: async () => [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: `${await store.count()} rows` },
        },
      ],
    }),
  };
}

const storeAt = (path: string) =>
  sqliteMirrorStore({ path, table: 'records', primaryKey: 'id', columns: { id: 'TEXT' } });

/** A store breakage: given the temp dir, leaves a broken store behind and returns its path. */
interface Breakage {
  breakStore(dir: string): Promise<string>;
  /** `cause.code` the driver or `mkdir` reports. */
  causeCode: string;
  name: string;
  /** Needs file modes to bite, so it cannot run as root. */
  usesModes: boolean;
}

describe('a broken mirror store on the wire (#635)', () => {
  let dir: string;
  /** Every spelling of `dir` a message could carry — `tmpdir()` is a symlink on macOS. */
  let dirSpellings: string[];
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mirror-wire-test-'));
    dirSpellings = [...new Set([dir, await realpath(dir)])];
  });

  afterEach(async () => {
    // Reverse order of setup: the client closes before the store it serves,
    // and every mode is restored before the temp dir is removed.
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  /** Sets `path`'s mode for the test body; cleanup puts `restore` back. */
  async function setMode(path: string, mode: number, restore: number) {
    await chmod(path, mode);
    cleanups.push(() => chmod(path, restore));
  }

  /** A store at `path` holding one row, closed again so the next open starts cold. */
  async function seed(path: string) {
    const store = storeAt(path);
    await store.applyBatch([{ id: '1' }], []);
    await store.close();
  }

  /** A store the test closes on cleanup. */
  function track(store: MirrorStore): MirrorStore {
    cleanups.push(() => store.close());
    return store;
  }

  /** `store`'s tool, resource, and prompt served by the production registries over an in-memory pair. */
  async function connect(store: MirrorStore): Promise<Client> {
    const { tool: countTool, resource: countResource, prompt: summary } = definitionsFor(store);
    const services = { logger, storage: new StorageService(new InMemoryProvider()) };
    const server = new McpServer(
      { name: 'mirror-wire-test', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    await new ToolRegistry([countTool], services).registerAll(server);
    await new ResourceRegistry([countResource], services).registerAll(server);
    await new PromptRegistry([summary], logger).registerAll(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'mirror-wire-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  /** Nothing anywhere in `value`, serialized, names the temp dir. */
  function expectNoHostDirectory(value: unknown) {
    const serialized = JSON.stringify(value);
    for (const spelling of dirSpellings) expect(serialized).not.toContain(spelling);
  }

  /** The tool error envelope a broken store produces, on both client surfaces. */
  function expectToolEnvelope(result: CallToolResult, { requestId }: { requestId: boolean }) {
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data?: Record<string, unknown>; message: string };
    };
    expect(error.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(error.message).toBe(MESSAGE);
    expect(error.data).toEqual({
      recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT },
      ...(requestId && { requestId: expect.any(String) }),
    });
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain(`Error: ${MESSAGE}`);
    expect(text).toContain(`Recovery: ${MIRROR_STORE_UNAVAILABLE_HINT}`);
    expectNoHostDirectory(result);
  }

  /** A JSON-RPC error a broken store produces on `resources/read` or `prompts/get`. */
  function expectJsonRpcError(error: unknown) {
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      message: expect.stringContaining(MESSAGE),
    });
    expect((error as { data?: unknown }).data).toEqual({
      recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT },
      requestId: expect.any(String),
    });
    expectNoHostDirectory({
      message: (error as Error).message,
      data: (error as { data?: unknown }).data,
    });
  }

  const BREAKAGES: Breakage[] = [
    {
      name: 'no permissions on the store file',
      causeCode: 'SQLITE_CANTOPEN',
      usesModes: true,
      async breakStore(root) {
        const path = join(root, 'data', STORE_FILE);
        await seed(path);
        await setMode(path, 0o000, 0o644);
        return path;
      },
    },
    {
      name: 'a corrupted header',
      causeCode: 'SQLITE_NOTADB',
      usesModes: false,
      async breakStore(root) {
        const path = join(root, 'data', STORE_FILE);
        await seed(path);
        // Overwrite the 16-byte "SQLite format 3\0" magic string.
        const file = await open(path, 'r+');
        try {
          await file.write(Buffer.alloc(16, 'x'), 0, 16, 0);
        } finally {
          await file.close();
        }
        return path;
      },
    },
    {
      name: 'a parent directory that cannot be created',
      causeCode: 'EACCES',
      usesModes: true,
      async breakStore(root) {
        const locked = join(root, 'locked');
        await mkdir(locked);
        await setMode(locked, 0o555, 0o755);
        return join(locked, 'data', STORE_FILE);
      },
    },
  ];

  describe.each(BREAKAGES)('a store with $name', (breakage) => {
    const test = RUNNING_AS_ROOT && breakage.usesModes ? it.skip : it;

    test('rejects with DatabaseError, the underlying error unchanged on cause', async () => {
      const store = track(storeAt(await breakage.breakStore(dir)));

      const error = await store.count().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
        message: MESSAGE,
        cause: { code: breakage.causeCode },
      });
      expect((error as McpError).data).toEqual({
        recovery: { hint: MIRROR_STORE_UNAVAILABLE_HINT },
      });
    });

    test('runToolContract returns -32010 naming the store by basename, with a Recovery line', async () => {
      const store = track(storeAt(await breakage.breakStore(dir)));

      const result = await runToolContract(definitionsFor(store).tool, {});

      expectToolEnvelope(result, { requestId: false });
    });

    test('tools/call through the production tool factory returns the same envelope', async () => {
      const client = await connect(track(storeAt(await breakage.breakStore(dir))));

      const result = (await client.callTool({
        name: 'mirror_count',
        arguments: {},
      })) as CallToolResult;

      expectToolEnvelope(result, { requestId: true });
    });

    test('resources/read rejects with no directory and no path in message or data', async () => {
      const client = await connect(track(storeAt(await breakage.breakStore(dir))));

      const error = await client.readResource({ uri: RESOURCE_URI }).then(
        () => expect.unreachable('expected resources/read to reject'),
        (err: unknown) => err,
      );

      expectJsonRpcError(error);
    });

    test('prompts/get rejects with no directory and no path in message or data', async () => {
      const client = await connect(track(storeAt(await breakage.breakStore(dir))));

      const error = await client.getPrompt({ name: 'mirror_summary' }).then(
        () => expect.unreachable('expected prompts/get to reject'),
        (err: unknown) => err,
      );

      expectJsonRpcError(error);
    });
  });

  it('serves a valid store in WAL mode through every surface', async () => {
    const path = join(dir, 'data', STORE_FILE);
    await seed(path);
    const store = track(storeAt(path));
    const client = await connect(store);

    const called = (await client.callTool({
      name: 'mirror_count',
      arguments: {},
    })) as CallToolResult;
    const read = await client.readResource({ uri: RESOURCE_URI });
    const generated = await client.getPrompt({ name: 'mirror_summary' });

    expect(called.isError).toBeFalsy();
    expect(called.structuredContent).toEqual({ count: 1 });
    expect(read.contents[0]).toMatchObject({
      uri: RESOURCE_URI,
      text: expect.stringContaining('1'),
    });
    expect(generated.messages[0]?.content).toEqual({ type: 'text', text: '1 rows' });
    const journal = (await store.raw())
      .prepare<{ journal_mode: string }>('PRAGMA journal_mode')
      .get();
    expect(journal?.journal_mode).toBe('wal');
  });
});
