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
 * That request-scoped path is the **2025-era** one. On 2026-07-28 delivery
 * belongs to the client's `subscriptions/listen` stream, so a modern instance
 * publishes to the handler's event bus instead — see {@link buildBusNotifiers}
 * (#193).
 *
 * @module src/mcp-server/notifications
 */

import type {
  ServerEventBus,
  ServerNotification,
  ServerNotifier,
} from '@modelcontextprotocol/server';

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
 * The same four closures, each optional — what a server-level notifier set
 * offers and what {@link selectNotifiers} returns, since a fallback set may not
 * carry all four.
 */
export interface OptionalNotifiers {
  notifyPromptListChanged?: () => void;
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
  notifyToolListChanged?: () => void;
}

/** Every delivery path a handler factory can offer, in one bag. */
export interface NotifierSources extends OptionalNotifiers {
  /** Modern-era publish facade. Present only on `modern` instances. */
  bus?: ServerNotifier;
  /** Legacy-era `resources/subscribe` registry. */
  subscriptions?: ResourceSubscriptions;
}

/**
 * Picks the delivery path a handler's `ctx.notify*` should take, era-ordered.
 *
 * A modern instance publishes to the listen bus, where the SDK applies the
 * client's subscription filter and an out-of-request emit still reaches open
 * streams (#193). A legacy instance sends through the request's own scope so
 * the message carries `relatedRequestId` (#135). The server-level closures are
 * the fallback for scopes with no sender at all — stdio and test harnesses.
 *
 * Both handler factories route through here so the ordering is one decision
 * rather than two copies that can drift apart.
 */
export function selectNotifiers(
  sources: NotifierSources,
  mcpReq: NotificationSender | undefined,
): OptionalNotifiers {
  return (
    (sources.bus ? buildBusNotifiers(sources.bus) : undefined) ??
    buildRequestScopedNotifiers(mcpReq ?? {}, sources.subscriptions) ??
    sources
  );
}

/**
 * A {@link ServerNotifier} over an arbitrary {@link ServerEventBus}.
 *
 * `createMcpHandler` returns one bound to its own bus, but the framework builds
 * the bus first — before any transport exists — so `setup()` can capture a
 * publish handle that stays valid once serving starts. The names mirror the
 * wire methods.
 */
export function notifierFor(bus: ServerEventBus): ServerNotifier {
  return {
    toolsChanged: () => bus.publish({ kind: 'tools_list_changed' }),
    promptsChanged: () => bus.publish({ kind: 'prompts_list_changed' }),
    resourcesChanged: () => bus.publish({ kind: 'resources_list_changed' }),
    resourceUpdated: (uri: string) => bus.publish({ kind: 'resource_updated', uri }),
  };
}

/**
 * Builds notifier closures that publish onto the modern era's
 * `subscriptions/listen` bus.
 *
 * On protocol revision 2026-07-28 a client opts into notification types by
 * opening a `subscriptions/listen` stream, and the spec is explicit that a
 * server MUST NOT send types the client has not requested. That filter lives in
 * the SDK's listen router, which only sees what reaches the bus — so a modern
 * handler firing through its own request scope bypasses it and delivers to
 * clients that opened no stream at all.
 *
 * Publishing is also what makes *out-of-request* emission work: the bus is not
 * request-scoped, so a background emitter reaches every open stream rather than
 * dropping into a closed exchange.
 *
 * No subscription registry is consulted here — including for
 * `resources/updated`. Per-URI routing is the listen filter's
 * `resourceSubscriptions` field, which the SDK applies on publish; the
 * `resources/subscribe` registry is the 2025-era mechanism and does not exist
 * on this era.
 */
export function buildBusNotifiers(notify: ServerNotifier): RequestScopedNotifiers {
  return {
    notifyToolListChanged: () => notify.toolsChanged(),
    notifyResourceListChanged: () => notify.resourcesChanged(),
    notifyPromptListChanged: () => notify.promptsChanged(),
    notifyResourceUpdated: (uri: string) => notify.resourceUpdated(uri),
  };
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
