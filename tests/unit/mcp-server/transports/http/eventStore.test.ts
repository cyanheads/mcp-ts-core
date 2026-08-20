/**
 * @fileoverview Unit tests for the bounded session event store (#215) — the
 * replay contract and the two retention bounds that keep it from growing
 * without limit.
 * @module tests/unit/mcp-server/transports/http/eventStore.test
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { createBoundedEventStore } from '@/mcp-server/transports/http/eventStore.js';

const msg = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: {} });

/** Collects what `replayEventsAfter` sends, in order. */
function collector() {
  const sent: Array<{ eventId: string; message: JSONRPCMessage }> = [];
  return {
    sent,
    send: async (eventId: string, message: JSONRPCMessage) => {
      sent.push({ eventId, message });
    },
  };
}

describe('createBoundedEventStore', () => {
  it('replays only what follows the anchor, on the anchor’s own stream', async () => {
    const store = createBoundedEventStore();
    const first = await store.storeEvent('s1', msg(1));
    await store.storeEvent('s1', msg(2));
    await store.storeEvent('s2', msg(99));
    await store.storeEvent('s1', msg(3));

    const { sent, send } = collector();
    const streamId = await store.replayEventsAfter(first, { send });

    expect(streamId).toBe('s1');
    expect(sent.map((entry) => entry.message)).toEqual([msg(2), msg(3)]);
  });

  it('resolves an event ID back to its stream', async () => {
    const store = createBoundedEventStore();
    const eventId = await store.storeEvent('s1', msg(1));

    await expect(store.getStreamIdForEventId?.(eventId)).resolves.toBe('s1');
    await expect(store.getStreamIdForEventId?.('s1_999')).resolves.toBeUndefined();
  });

  it('replays nothing when the anchor has already been evicted', async () => {
    // Replaying from the start instead would redeliver messages the client
    // already has; the live stream carries on from here.
    const store = createBoundedEventStore({ maxEvents: 2 });
    const first = await store.storeEvent('s1', msg(1));
    await store.storeEvent('s1', msg(2));
    await store.storeEvent('s1', msg(3));

    const { sent, send } = collector();
    const streamId = await store.replayEventsAfter(first, { send });

    expect(streamId).toBe('s1');
    expect(sent).toEqual([]);
  });

  it('names the stream correctly when the stream ID itself contains `_`', async () => {
    // The SDK's standalone GET stream is `_GET_stream`, so an event ID splits
    // at its LAST separator, not its first.
    const store = createBoundedEventStore({ maxEvents: 1 });
    const evicted = await store.storeEvent('_GET_stream', msg(1));
    await store.storeEvent('_GET_stream', msg(2));

    const { sent, send } = collector();

    await expect(store.replayEventsAfter(evicted, { send })).resolves.toBe('_GET_stream');
    expect(sent).toEqual([]);
  });

  it('caps retention by event count, dropping oldest first', async () => {
    const store = createBoundedEventStore({ maxEvents: 3 });
    for (let i = 1; i <= 10; i++) await store.storeEvent('s1', msg(i));

    expect(store.size).toBe(3);

    const { sent, send } = collector();
    await store.replayEventsAfter('s1_8', { send });
    expect(sent.map((entry) => entry.message)).toEqual([msg(9), msg(10)]);
  });

  it('caps retention by TTL', async () => {
    const clock = vi.fn(() => 1_000);
    const store = createBoundedEventStore({ ttlMs: 500, now: clock });

    await store.storeEvent('s1', msg(1));
    expect(store.size).toBe(1);

    clock.mockReturnValue(2_000);
    await store.storeEvent('s1', msg(2));

    // The first event aged past the TTL and was evicted by the second write.
    expect(store.size).toBe(1);
    await expect(store.getStreamIdForEventId?.('s1_1')).resolves.toBeUndefined();
  });

  it('releases its buffer on clear', async () => {
    const store = createBoundedEventStore();
    await store.storeEvent('s1', msg(1));

    store.clear();

    expect(store.size).toBe(0);
  });
});
