/**
 * @fileoverview Black-box coverage for the `createApp` `sessionMode` option
 * (#376): a server that declares its posture in code serves and advertises that
 * mode with nothing in the environment, and an explicit `MCP_SESSION_MODE`
 * still wins over it.
 * @module tests/integration/session-mode-option.int.test
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeBody, MCP_HEADERS } from '../helpers/http-helpers.js';
import { type ServerHandle, startServerFromEntrypoint } from '../helpers/server-process.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/session-mode-server.js');

/** The `/mcp` status JSON and the `Mcp-Session-Id` an initialize does or does not carry. */
async function probe(handle: ServerHandle) {
  const status = (await (await fetch(`http://127.0.0.1:${handle.port}/mcp`)).json()) as {
    server: { sessionMode: string };
  };

  const initialize = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    body: initializeBody(),
    headers: { ...MCP_HEADERS },
    method: 'POST',
  });

  return {
    advertised: status.server.sessionMode,
    sessionId: initialize.headers.get('mcp-session-id'),
  };
}

describe('createApp sessionMode option over HTTP', () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    await handle?.kill();
    handle = undefined;
  });

  it('serves and advertises the declared mode when the environment sets none', async () => {
    handle = await startServerFromEntrypoint(FIXTURE, 'http', { MCP_SESSION_MODE: '' });

    const { advertised, sessionId } = await probe(handle);

    expect(advertised).toBe('stateless');
    expect(sessionId).toBeNull();
  });

  it('yields to an explicit MCP_SESSION_MODE', async () => {
    handle = await startServerFromEntrypoint(FIXTURE, 'http', { MCP_SESSION_MODE: 'stateful' });

    const { advertised, sessionId } = await probe(handle);

    expect(advertised).toBe('stateful');
    expect(sessionId).toBeTruthy();
  });
});
