/**
 * @fileoverview Request-scoped list-changed / resource-updated notifiers.
 *
 * Under the per-request `McpServer` model (HTTP and Workers,
 * GHSA-345p-7cg4-v4c7), the server-level `server.send*ListChanged()` path emits
 * a notification with no `relatedRequestId`. `@hono/mcp` then looks for the
 * standalone GET SSE stream — which lives on a *different* transport instance —
 * and, finding none on the POST transport, drops the notification silently
 * (#135). The fix is to route handler-time notifications through the request's
 * own `extra.sendNotification`, which stamps `relatedRequestId` so the
 * notification reaches that request's SSE response stream.
 *
 * @module src/mcp-server/notifications
 */

import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';

import { logger } from '@/utils/internal/logger.js';

/**
 * The minimal shape we need off the SDK's `RequestHandlerExtra`. Typed with an
 * optional `sendNotification` (the SDK declares it required) so the runtime
 * presence check below is type-meaningful — mirroring how `wrapElicit` /
 * `wrapSample` narrow against a loose capability interface rather than the full
 * extra. A non-request scope (some test harnesses pass a bare `Request`) has no
 * sender, and we fall back to the server-level notifiers there.
 */
interface NotificationSender {
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

/** The four list-changed / resource-updated closures attached to a handler `ctx`. */
export interface RequestScopedNotifiers {
  notifyPromptListChanged: () => void;
  notifyResourceListChanged: () => void;
  notifyResourceUpdated: (uri: string) => void;
  notifyToolListChanged: () => void;
}

/**
 * Builds notifier closures bound to a single request's `extra.sendNotification`.
 * The SDK stamps `relatedRequestId` onto these sends, so `@hono/mcp` routes them
 * to that request's SSE response stream — the delivery path the server-level
 * `server.send*ListChanged()` calls miss under the per-request McpServer model,
 * where they drop silently (#135).
 *
 * Returns `undefined` when the supplied extra exposes no sender; callers fall
 * back to the server-level notifiers in that case.
 *
 * Fire-and-forget by contract (`() => void`): the underlying `sendNotification`
 * promise is not awaited — a notification that can't flush (client already gone,
 * response not upgraded to SSE) must not fail the handler. A flush failure is
 * logged at debug rather than swallowed silently.
 *
 * Handler-time only. A background task (auto-task handler, cron) has no request
 * scope; those paths keep the server-level notifiers, which deliver on stdio but
 * not under HTTP — the residual gap a session-scoped notification bus would close.
 */
export function buildRequestScopedNotifiers(
  extra: NotificationSender,
): RequestScopedNotifiers | undefined {
  if (typeof extra.sendNotification !== 'function') return;
  const send = extra.sendNotification.bind(extra);
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
    notifyResourceUpdated: (uri: string) =>
      emit({ method: 'notifications/resources/updated', params: { uri } }),
  };
}
