/**
 * @fileoverview Tests for the echo resource.
 * @module tests/resources/echo.resource.test
 */

import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { echoResource } from '@/mcp-server/resources/definitions/echo.resource.js';

describe('echoResource', () => {
  it('echoes the message from params', async () => {
    const ctx = createMockContext();
    const params = echoResource.params!.parse({ message: 'hello world' });
    const result = await echoResource.handler(params, ctx);
    expect(result).toEqual({ message: 'hello world' });
  });

  it('lists available resources', async () => {
    // `list` receives the SDK's `ServerContext`, not a handler `Context`, and
    // may be async — a minimal literal is enough for a listing that ignores it.
    const serverContext = {
      mcpReq: {
        id: 'test',
        method: 'resources/list',
        signal: new AbortController().signal,
        requestState: () => undefined,
        send: () => Promise.resolve({} as never),
        notify: () => Promise.resolve(),
        log: () => Promise.resolve(),
        elicitInput: () => Promise.resolve({ action: 'cancel' as const }),
        requestSampling: () => Promise.reject(new Error('not supported')),
      },
    } as unknown as Parameters<NonNullable<typeof echoResource.list>>[0];
    const listing = await echoResource.list!(serverContext);
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'echo://hello',
      name: 'Echo Hello',
    });
  });
});
