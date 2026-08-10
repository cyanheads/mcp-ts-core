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
    // `list` receives the SDK's request-handler extra, not a Context, and may be
    // async — a minimal literal is enough for a listing that ignores it.
    const extra = {
      signal: new AbortController().signal,
      requestId: 'test',
      sendNotification: () => Promise.resolve(),
      sendRequest: () => Promise.resolve({} as never),
    };
    const listing = await echoResource.list!(extra);
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'echo://hello',
      name: 'Echo Hello',
    });
  });
});
