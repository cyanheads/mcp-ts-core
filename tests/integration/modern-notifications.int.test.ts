/**
 * @fileoverview Wire coverage for modern-era notification routing (#193).
 *
 * On protocol revision 2026-07-28 a client opts into notification types by
 * opening a `subscriptions/listen` stream, and the spec is explicit that a
 * server MUST NOT send types the client has not requested. That filter lives in
 * the SDK's listen router, which only sees what reaches the change-event bus —
 * so a handler firing through its own request scope bypasses it entirely and
 * delivers to a client that opened no stream at all.
 * @module tests/integration/modern-notifications.int.test
 */
import {
  InMemoryServerEventBus,
  type McpRequestContext,
  type ServerEvent,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { config } from '@/config/index.js';
import { notifierFor } from '@/mcp-server/notifications.js';
import { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { installResourceSubscriptions } from '@/mcp-server/resources/resourceSubscriptions.js';
import { createMcpServerInstance } from '@/mcp-server/server.js';
import { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { type AnyToolDefinition, tool } from '@/mcp-server/tools/utils/toolDefinition.js';
import { createHttpApp } from '@/mcp-server/transports/http/httpTransport.js';
import { MODERN_PROTOCOL_REVISION } from '@/mcp-server/types.js';
import { StorageService } from '@/storage/core/StorageService.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { defaultServerManifest } from '../helpers/fixtures.js';

const touchTool = tool('touch_record', {
  description: 'Mutates a record and announces the change.',
  input: z.object({ uri: z.string().describe('The resource URI that changed.') }),
  output: z.object({ ok: z.boolean().describe('Whether the change was applied.') }),
  handler: (input, ctx) => {
    ctx.notifyToolListChanged?.();
    ctx.notifyResourceUpdated?.(input.uri);
    return { ok: true };
  },
});

const services = () => ({ logger, storage: new StorageService(new InMemoryProvider()) });

function callTouch(uri: string): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'touch_record',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'touch_record',
        arguments: { uri },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

describe('modern-era notification routing (#193)', () => {
  const teardown: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (teardown.length) await teardown.pop()?.();
  });

  it('publishes handler-time notifications to the listen bus, not the request stream', async () => {
    const bus = new InMemoryServerEventBus();
    const published: ServerEvent[] = [];
    bus.subscribe((event) => published.push(event));

    const factory = async (requestContext: McpRequestContext) =>
      await createMcpServerInstance({
        config,
        era: requestContext.era,
        notifier: notifierFor(bus),
        promptRegistry: new PromptRegistry([], logger),
        resourceRegistry: new ResourceRegistry([], services()),
        toolRegistry: new ToolRegistry([touchTool as AnyToolDefinition], services()),
      });

    const { app, close } = await createHttpApp(
      factory,
      requestContextService.createRequestContext({ operation: 'modern-notifications' }),
      defaultServerManifest,
      bus,
    );
    teardown.push(close);

    const res = await app.request(callTouch('probe://item/1'));
    const body = await res.text();
    expect(res.status, body).toBe(200);

    // The client opened no `subscriptions/listen` stream, so nothing may be
    // delivered on the call's own response stream.
    expect(body).not.toContain('notifications/tools/list_changed');
    expect(body).not.toContain('notifications/resources/updated');

    // Both reached the bus, where the SDK's listen router filters them against
    // whatever an actual subscriber asked for.
    expect(published).toEqual([
      { kind: 'tools_list_changed' },
      { kind: 'resource_updated', uri: 'probe://item/1' },
    ]);
  });

  it('lets a background emitter reach the same bus the listen streams subscribe to', async () => {
    const bus = new InMemoryServerEventBus();
    const published: ServerEvent[] = [];
    bus.subscribe((event) => published.push(event));

    // Out-of-request emission — a cron, a webhook, `createApp({ setup })`. Under
    // HTTP there is no long-lived server instance to send through, so the bus is
    // the only path that exists.
    notifierFor(bus).resourcesChanged();

    expect(published).toEqual([{ kind: 'resources_list_changed' }]);
  });

  it('leaves legacy-era handler-time delivery on the request scope', async () => {
    // The 2025 era has no listen stream to publish to: delivery rides the live
    // exchange, gated by the `resources/subscribe` registry (#354).
    const legacy = await createMcpServerInstance({
      config,
      era: 'legacy',
      notifier: notifierFor(new InMemoryServerEventBus()),
      promptRegistry: new PromptRegistry([], logger),
      resourceRegistry: new ResourceRegistry([], services()),
      toolRegistry: new ToolRegistry([touchTool as AnyToolDefinition], services()),
    });
    teardown.push(() => legacy.close());

    // Installing the 2025 registry is what a legacy instance does; a modern one
    // is handed none. Asserted through the era gate rather than the wire, since
    // the registry is the observable difference.
    expect(installResourceSubscriptions(legacy).size).toBe(0);
  });
});
