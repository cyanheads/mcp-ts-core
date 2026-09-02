/**
 * @fileoverview Integration test for the identity a stdio client actually sees.
 * A client spawns the server from whatever directory it happens to be in, so
 * the built server is launched from a temp project with its own manifest and
 * `initialize` is checked for the server's own version.
 * @module tests/integration/server-identity.int.test
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST_INDEX = resolve(process.cwd(), 'dist/index.js');

/** A manifest whose values could not be mistaken for the server's own. */
const FOREIGN_MANIFEST = {
  name: 'my-unrelated-app',
  version: '9.9.9-totally-not-the-server',
  description: "An unrelated project that happens to be the client's cwd.",
  keywords: ['unrelated'],
};

describe('server identity over stdio', () => {
  let foreignCwd: string;
  let ownVersion: string;
  let ownName: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    const pkg = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    ownName = pkg.name;
    ownVersion = pkg.version;

    foreignCwd = await mkdtemp(join(tmpdir(), 'mcp-foreign-cwd-'));
    await writeFile(
      join(foreignCwd, 'package.json'),
      `${JSON.stringify(FOREIGN_MANIFEST, null, 2)}\n`,
    );

    transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX],
      cwd: foreignCwd,
      env: {
        ...process.env,
        MCP_LOG_LEVEL: 'error',
        MCP_TRANSPORT_TYPE: 'stdio',
      },
    });
    client = new Client({ name: 'identity-integration', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      // Transport already torn down.
    }
    await rm(foreignCwd, { force: true, recursive: true });
  });

  it('reports its own version, not the manifest in the launching directory', () => {
    const info = client.getServerVersion();

    expect(info?.version).toBe(ownVersion);
    expect(info?.version).not.toBe(FOREIGN_MANIFEST.version);
    expect(info?.name).toBe(ownName);
  });
});
