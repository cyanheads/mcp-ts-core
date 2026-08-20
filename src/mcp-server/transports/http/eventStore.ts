/**
 * @fileoverview Bounded in-memory `EventStore` for stateful HTTP session
 * resumability.
 *
 * Stateful HTTP survives a dropped connection but not the in-flight stream: the
 * session is still there on reconnect, and everything the server emitted while
 * the socket was down is gone. The SDK's transport closes that gap when it is
 * given an `EventStore` — it stamps each SSE frame with an event ID, and a
 * client reconnecting with `Last-Event-ID` gets the missed frames replayed
 * before the live stream resumes.
 *
 * The store is framework-owned rather than a dependency's memory store because
 * the bounds are the feature. Retention is capped two ways — a total event count
 * and a per-event TTL — and one store belongs to one session, so eviction
 * releases its buffer with it. Without both, a long-lived session on a busy
 * server retains every frame it ever sent.
 *
 * **Legacy arm only.** Protocol revision 2026-07-28 is per-request and has no
 * session to resume, so nothing here applies to it (#215).
 *
 * @module src/mcp-server/transports/http/eventStore
 */

import type { EventStore, JSONRPCMessage } from '@modelcontextprotocol/server';

/** Retention bounds. Both apply; whichever binds first evicts. */
export interface BoundedEventStoreOptions {
  /**
   * Maximum events retained across every stream in the session. The oldest are
   * dropped first, which is also the safe direction: a client far enough behind
   * that its resume point was evicted starts a fresh stream instead.
   */
  maxEvents?: number;
  /** Injectable clock. Present for tests; production uses `Date.now`. */
  now?: () => number;
  /** How long an event stays replayable, in milliseconds. */
  ttlMs?: number;
}

/** A session-scoped event store, plus the handles the transport layer needs. */
export interface BoundedEventStore extends EventStore {
  /**
   * Drops every retained event, releasing the buffer at an explicit DELETE
   * rather than leaving it to the collector. A session that ends any other way
   * (stale eviction, shutdown) discards the store with the transport that
   * holds it, so this is promptness, not the only release path.
   */
  clear(): void;
  /** Events currently retained. */
  readonly size: number;
}

/**
 * Retained events, capped at 512 by default.
 *
 * Sized for the gap a reconnect actually has to cover — a dropped socket, not a
 * disconnected weekend — rather than for a full session transcript. Each entry
 * holds one JSON-RPC message, so the memory cost scales with payload size;
 * lower it on a server whose tools return large results.
 */
const DEFAULT_MAX_EVENTS = 512;

/** How long a retained event stays replayable. Five minutes by default. */
const DEFAULT_TTL_MS = 300_000;

/**
 * The stream an event ID belongs to, read back off the ID itself.
 *
 * Only the sequence suffix has a fixed shape — a stream ID may itself contain
 * `_`, as the SDK's standalone GET stream (`_GET_stream`) does — so the split
 * is at the last separator, not the first.
 */
const streamIdOf = (eventId: string): string => {
  const separator = eventId.lastIndexOf('_');
  return separator === -1 ? '' : eventId.slice(0, separator);
};

interface StoredEvent {
  message: JSONRPCMessage;
  storedAt: number;
  streamId: string;
}

/**
 * Creates a bounded in-memory event store for one session.
 *
 * Event IDs are `<streamId>_<sequence>` with a monotonic per-store counter, so
 * insertion order is replay order and an ID identifies its own stream without a
 * second index.
 */
export function createBoundedEventStore(options: BoundedEventStoreOptions = {}): BoundedEventStore {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  // Insertion-ordered, which is what makes both the replay walk and the
  // oldest-first eviction a plain iteration.
  const events = new Map<string, StoredEvent>();
  let sequence = 0;

  const evict = (): void => {
    const cutoff = now() - ttlMs;
    for (const [eventId, event] of events) {
      if (event.storedAt > cutoff) break; // insertion-ordered: the rest are newer
      events.delete(eventId);
    }
    while (events.size > maxEvents) {
      const oldest = events.keys().next();
      if (oldest.done) break;
      events.delete(oldest.value);
    }
  };

  return {
    storeEvent(streamId, message) {
      const eventId = `${streamId}_${++sequence}`;
      events.set(eventId, { message, storedAt: now(), streamId });
      evict();
      return Promise.resolve(eventId);
    },

    getStreamIdForEventId(eventId) {
      return Promise.resolve(events.get(eventId)?.streamId);
    },

    async replayEventsAfter(lastEventId, { send }) {
      const anchor = events.get(lastEventId);
      // An unknown anchor means the client's resume point aged out or was
      // evicted. Replaying from the start would deliver messages it already
      // has, so send nothing and let the live stream carry on from here. An
      // SDK-driven reconnect never gets this far — `getStreamIdForEventId`
      // answers first, and an unknown ID is rejected there.
      if (!anchor) return streamIdOf(lastEventId);

      const { streamId } = anchor;
      let past = false;
      for (const [eventId, event] of events) {
        if (!past) {
          past = eventId === lastEventId;
          continue;
        }
        if (event.streamId !== streamId) continue;
        await send(eventId, event.message);
      }
      return streamId;
    },

    clear() {
      events.clear();
    },

    get size() {
      return events.size;
    },
  };
}
