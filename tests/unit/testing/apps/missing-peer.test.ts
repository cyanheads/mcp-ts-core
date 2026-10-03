/**
 * @fileoverview Tests that `renderAppTool` loads its optional peers lazily: importing the
 * subpath needs neither, and a run without one rejects with a configuration error naming
 * the package and its install command. Each case simulates one failed peer import.
 * @module tests/unit/testing/apps/missing-peer.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode } from '@/types-global/errors.js';

const CLIENT = '@modelcontextprotocol/client';
const STDIO = '@modelcontextprotocol/client/stdio';
const APP_BRIDGE = '@modelcontextprotocol/ext-apps/app-bridge';

/**
 * A module whose import rejects with `error`. A `vi.mock` factory that throws reaches the
 * importer wrapped in Vitest's own error, so the factory returns a namespace instead: the
 * mocker reads its `then` once while registering it, and every later read is the dynamic
 * import adopting the namespace as a thenable, which rejects.
 */
function failingModule(error: Error): object {
  let reads = 0;
  return {
    // biome-ignore lint/suspicious/noThenProperty: the failed import is simulated by a thenable namespace.
    get then() {
      reads += 1;
      return reads === 1
        ? undefined
        : (_resolve: unknown, reject: (reason: unknown) => void) => reject(error);
    },
  };
}

function notFound(specifier: string, code = 'ERR_MODULE_NOT_FOUND'): Error {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from /app/dist/testing/apps/run.js`),
    { code },
  );
}

async function render(): Promise<unknown> {
  const { renderAppTool } = await import('@/testing/apps/index.js');
  return renderAppTool({ server: { command: 'unused' }, tool: 'unused' }).then(
    () => {
      throw new Error('Expected renderAppTool to reject.');
    },
    (error: unknown) => error,
  );
}

describe('renderAppTool without its optional peers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock(CLIENT);
    vi.doUnmock(STDIO);
    vi.doUnmock(APP_BRIDGE);
  });

  it('imports the subpath without loading either peer', async () => {
    vi.doMock(CLIENT, () => failingModule(notFound(CLIENT)));
    vi.doMock(APP_BRIDGE, () => failingModule(notFound('@modelcontextprotocol/ext-apps')));
    const module = await import('@/testing/apps/index.js');
    expect(Object.keys(module)).toEqual(['renderAppTool']);
  });

  it.each([
    ['the client', CLIENT, CLIENT, 'ERR_MODULE_NOT_FOUND'],
    ['the client stdio entry', STDIO, CLIENT, 'ERR_MODULE_NOT_FOUND'],
    ['the ext-apps bridge', APP_BRIDGE, '@modelcontextprotocol/ext-apps', 'MODULE_NOT_FOUND'],
  ])('names the package when %s is missing', async (_label, specifier, pkg, code) => {
    vi.doMock(specifier, () => failingModule(notFound(pkg, code)));
    // A fresh module graph has its own McpError class, so match on name and code.
    await expect(render()).resolves.toMatchObject({
      name: 'McpError',
      code: JsonRpcErrorCode.ConfigurationError,
      message: `renderAppTool needs the optional peer dependency ${pkg}, which is not installed. Install it with \`bun add -d ${pkg}\`.`,
      data: { reason: 'missing_peer', package: pkg },
    });
  });

  it('recognizes a missing package by its message when the error carries no code', async () => {
    vi.doMock(APP_BRIDGE, () =>
      failingModule(new Error("Cannot find module '@modelcontextprotocol/ext-apps/app-bridge'")),
    );
    await expect(render()).resolves.toMatchObject({
      data: { reason: 'missing_peer', package: '@modelcontextprotocol/ext-apps' },
    });
  });

  it('rethrows a failure that does not name the peer as it was', async () => {
    const transitive = notFound('cross-spawn');
    vi.doMock(CLIENT, () => failingModule(transitive));
    await expect(render()).resolves.toBe(transitive);
  });

  it('rethrows a missing dependency of an installed peer, whose importer path names the peer', async () => {
    const transitive = Object.assign(
      new Error(
        `Cannot find package 'zod' imported from /app/node_modules/${CLIENT}/dist/index.mjs`,
      ),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    vi.doMock(CLIENT, () => failingModule(transitive));
    await expect(render()).resolves.toBe(transitive);
  });

  it('recognizes Bun wording, which double-quotes the specifier', async () => {
    vi.doMock(APP_BRIDGE, () =>
      failingModule(new Error(`Cannot find package "${APP_BRIDGE}" from "/app/run.js"`)),
    );
    await expect(render()).resolves.toMatchObject({
      data: { reason: 'missing_peer', package: '@modelcontextprotocol/ext-apps' },
    });
  });

  it('rethrows a failure to load the peer that is not a missing package', async () => {
    const broken = new SyntaxError(`Unexpected token in ${CLIENT}/dist/index.mjs`);
    vi.doMock(CLIENT, () => failingModule(broken));
    await expect(render()).resolves.toBe(broken);
  });

  it('rethrows a thrown value that is not an Error', async () => {
    vi.doMock(STDIO, () => failingModule(`${CLIENT} is gone` as unknown as Error));
    await expect(render()).resolves.toBe(`${CLIENT} is gone`);
  });
});
