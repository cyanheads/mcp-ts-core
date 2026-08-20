/**
 * @fileoverview Per-connection `resources/subscribe` registry.
 *
 * The framework advertises `resources: { subscribe: true }`, and a declared
 * capability is a promise: `resources/subscribe` and `resources/unsubscribe`
 * must resolve, and `notifications/resources/updated` must only reach clients
 * that actually subscribed to the URI (#354).
 *
 * This is the **2025-era** mechanism, and it is installed only on instances
 * serving that era. The 2026-07-28 revision has no `resources/subscribe` RPC —
 * a client opts in through `subscriptions/listen`'s `resourceSubscriptions`
 * filter, and the SDK's listen router owns delivery. Handing a modern instance
 * this registry would leave it permanently empty and silently drop every
 * `ctx.notifyResourceUpdated(uri)`, so `createMcpServerInstance` passes none
 * and the notifiers emit unconditionally there.
 *
 * Scope is the `McpServer` instance, which is also the connection: a persistent
 * instance per session on the sessionful legacy arm, one per request under
 * per-request serving. On the per-request arm a subscription cannot outlive the
 * request that created it, so a handler-time `ctx.notifyResourceUpdated(uri)`
 * only delivers when the same exchange subscribed first.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/server/resources | MCP Resources}
 * @module src/mcp-server/resources/resourceSubscriptions
 */

import type { McpServer } from '@modelcontextprotocol/server';

import type { ResourceSubscriptions } from '@/mcp-server/notifications.js';

/**
 * Read-only view of one connection's subscription set. The set is mutated only
 * by the `resources/subscribe` / `resources/unsubscribe` handlers installed
 * alongside it.
 */
export interface ResourceSubscriptionRegistry extends ResourceSubscriptions {
  readonly size: number;
}

/**
 * Installs `resources/subscribe` / `resources/unsubscribe` on a server instance
 * and returns the registry the notifiers read.
 *
 * Both handlers are idempotent and never fail: re-subscribing is a no-op, and
 * unsubscribing from a URI that was never subscribed succeeds (the spec
 * defines no error for it, and clients tear down optimistically).
 */
export function installResourceSubscriptions(server: McpServer): ResourceSubscriptionRegistry {
  const subscribed = new Set<string>();

  server.server.setRequestHandler('resources/subscribe', (request) => {
    subscribed.add(request.params.uri);
    return {};
  });

  server.server.setRequestHandler('resources/unsubscribe', (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });

  return {
    has: (uri) => subscribed.has(uri),
    get size() {
      return subscribed.size;
    },
  };
}
