/**
 * @fileoverview Tests for the echo resource.
 * @module tests/examples/resources/echo.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { echoResourceDefinition } from '../../../examples/mcp-server/resources/definitions/echo.resource.js';
import { makeServerContext } from '../../helpers/server-context.js';

describe('echoResourceDefinition', () => {
  it('echoes message from URI hostname', async () => {
    const ctx = createMockContext({ uri: new URL('echo://hello') });
    const params = echoResourceDefinition.params!.parse({});
    const result = await echoResourceDefinition.handler(params, ctx);
    expect(result.message).toBe('hello');
    expect(result.requestUri).toBe('echo://hello');
  });

  it('uses params.message over URI', async () => {
    const ctx = createMockContext({ uri: new URL('echo://fallback') });
    const params = echoResourceDefinition.params!.parse({ message: 'override' });
    const result = await echoResourceDefinition.handler(params, ctx);
    expect(result.message).toBe('override');
  });

  it('includes timestamp', async () => {
    const ctx = createMockContext({ uri: new URL('echo://test') });
    const params = echoResourceDefinition.params!.parse({});
    const result = await echoResourceDefinition.handler(params, ctx);
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });

  it('lists default resources', async () => {
    const listing = await echoResourceDefinition.list!(
      makeServerContext({ method: 'resources/list' }),
    );
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]!.uri).toBe('echo://hello');
  });
});
