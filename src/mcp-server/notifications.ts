/**
 * @fileoverview Request-scoped list-changed / resource-updated notifiers.
 *
 * Notifications fired from inside a handler are sent through the request's own
 * `ctx.mcpReq.notify`, which stamps `relatedRequestId` so the message lands on
 * that request's own response stream. The server-level `send*ListChanged()`
 * path targets the standalone GET SSE stream instead, which does not exist
 * under per-request serving (`createMcpHandler`'s modern leg and its stateless
 * legacy fallback both build one instance per request) — notifications sent
 * that way drop silently (#135).
 *
 * `notifications/resources/updated` is subscription-scoped: it is emitted only
 * for URIs the client actually subscribed to via `resources/subscribe` (#354).
 *
 * @module src/mcp-server/notifications
 */

import type { ServerNotification } from '@modelcontextprotocol/server';

import { logger } from '@/utils/internal/logger.js';

/**
 * The slice of `ctx.mcpReq` these notifiers need. Typed with an optional
 * `notify` so the runtime presence check is type-meaningful — a background or
 * test scope may pass a stand-in without one, and callers fall back to the
 * server-level notifiers there.
 */
interface NotificationSender {
  notify?: (notification: ServerNotification) => Promise<void>;
}

/** The four list-changed / resource-updated closures attached to a handler `ctx`. */
export interface RequestScopedNotifiers {
  notifyPromptListChanged: () => void;
  notifyResourceListChanged: () => void;
  notifyResourceUpdated: (uri: string) => void;
  notifyToolListChanged: () => void;
}

/** Per-connection subscription state consulted before a resource-updated emit. */
export interface ResourceSubscriptions {
  /** True when the connected client subscribed to this exact URI. */
  has: (uri: string) => boolean;
}

/**
 * Builds notifier closures bound to a single request's `ctx.mcpReq.notify`.
 *
 * Returns `undefined` when the supplied request scope exposes no sender;
 * callers fall back to the server-level notifiers in that case.
 *
 * Fire-and-forget by contract (`() => void`): the underlying promise is not
 * awaited — a notification that can't flush (client already gone, response not
 * upgraded to SSE) must not fail the handler. A flush failure is logged at
 * debug rather than swallowed silently.
 *
 * @param mcpReq - The request scope from the SDK's `ServerContext`.
 * @param subscriptions - Per-connection `resources/subscribe` registry. When
 *   supplied, `notifyResourceUpdated` emits only for subscribed URIs; when
 *   omitted (no subscription tracking available) every URI is emitted.
 */
export function buildRequestScopedNotifiers(
  mcpReq: NotificationSender,
  subscriptions?: ResourceSubscriptions,
): RequestScopedNotifiers | undefined {
  if (typeof mcpReq.notify !== 'function') return;
  const send = mcpReq.notify.bind(mcpReq);
  const emit = (notification: ServerNotification): void => {
    void send(notification).catch((error: unknown) => {
      logger.debug(
        `Notification ${notification.method} not delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };
  return {
    notifyToolListChanged: () => emit({ method: 'notifications/tools/list_changed' }),
    notifyResourceListChanged: () => emit({ method: 'notifications/resources/list_changed' }),
    notifyPromptListChanged: () => emit({ method: 'notifications/prompts/list_changed' }),
    notifyResourceUpdated: (uri: string) => {
      // Spec: `notifications/resources/updated` SHOULD only be sent for a URI
      // the client subscribed to. Emitting to a client that never subscribed is
      // noise it has no handler for.
      if (subscriptions && !subscriptions.has(uri)) {
        logger.debug(`Resource update for ${uri} not sent: no active subscription.`);
        return;
      }
      emit({ method: 'notifications/resources/updated', params: { uri } });
    },
  };
}
