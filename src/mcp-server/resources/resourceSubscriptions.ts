/**
 * @fileoverview Per-connection `resources/subscribe` registry.
 *
 * The framework advertises `resources: { subscribe: true }`, and a declared
 * capability is a promise: `resources/subscribe` and `resources/unsubscribe`
 * must resolve, and `notifications/resources/updated` must only reach clients
 * that actually subscribed to the URI (#354).
 *
 * Scope is the `McpServer` instance, which is also the connection: a persistent
 * instance per session on the sessionful legacy arm, one per request under
 * per-request serving. On the per-request arm a subscription cannot outlive the
 * request that created it, so a handler-time `ctx.notifyResourceUpdated(uri)`
 * only delivers when the same exchange subscribed first — background delivery
 * over the 2026-era `subscriptions/listen` bus is the durable path.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/server/resources | MCP Resources}
 * @module src/mcp-server/resources/resourceSubscriptions
 */

import type { McpServer } from '@modelcontextprotocol/server';

import type { ResourceSubscriptions } from '@/mcp-server/notifications.js';

/** Subscription set for one connection, with the mutations the handlers need. */
export interface ResourceSubscriptionRegistry extends ResourceSubscriptions {
  add: (uri: string) => void;
  remove: (uri: string) => void;
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
    add: (uri) => void subscribed.add(uri),
    has: (uri) => subscribed.has(uri),
    remove: (uri) => void subscribed.delete(uri),
    get size() {
      return subscribed.size;
    },
  };
}
