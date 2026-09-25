/**
 * @fileoverview Tests for the echo resource.
 * @module tests/smoke/resources/echo.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { echoResourceDefinition } from '../../../examples/mcp-server/resources/definitions/echo.resource.js';
import { makeServerContext } from '../../helpers/server-context.js';

describe('echoResourceDefinition', () => {
  it('echoes the message bound from the URI template', async () => {
    const ctx = createMockContext({ uri: new URL('echo://hello') });
    const params = echoResourceDefinition.params!.parse({ message: 'hello' });
    const result = await echoResourceDefinition.handler(params, ctx);
    expect(result.message).toBe('hello');
  });

  it('returns output matching the declared schema, timestamp included', async () => {
    const ctx = createMockContext({ uri: new URL('echo://test') });
    const params = echoResourceDefinition.params!.parse({ message: 'test' });
    const result = await echoResourceDefinition.handler(params, ctx);
    expect(result).toEqual(expect.schemaMatching(echoResourceDefinition.output!));
  });

  it('lists default resources', async () => {
    const listing = await echoResourceDefinition.list!(
      makeServerContext({ method: 'resources/list' }),
    );
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]!.uri).toBe('echo://hello');
  });
});
