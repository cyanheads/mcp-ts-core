/**
 * @fileoverview Tests for EvictingTaskMessageQueue. The SDK queue deletes a
 * task's queue only in `dequeueAll`, so a task the client abandons — never
 * fetching its result, never cancelling — strands its queue for the life of
 * the process. (#276)
 * @module tests/mcp-server/tasks/core/evictingTaskMessageQueue.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvictingTaskMessageQueue } from '@/mcp-server/tasks/core/evictingTaskMessageQueue.js';
import { InMemoryTaskMessageQueue, type QueuedMessage } from '@/mcp-server/tasks/core/taskTypes.js';

const TTL = 120_000;

function makeMessage(id: number): QueuedMessage {
  return {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { data: `message-${id}` },
  } as unknown as QueuedMessage;
}

/** Reach the SDK queue's internal map to assert on real retention. */
function queueCount(inner: InMemoryTaskMessageQueue): number {
  return (inner as unknown as { queues: Map<string, unknown[]> }).queues.size;
}

describe('EvictingTaskMessageQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops an abandoned task queue once the TTL elapses', async () => {
    vi.useFakeTimers();
    const inner = new InMemoryTaskMessageQueue();
    const queue = new EvictingTaskMessageQueue(inner, TTL);

    // A task that enqueues, is never collected, and is never cancelled.
    await queue.enqueue('abandoned', makeMessage(1));
    expect(queueCount(inner)).toBe(1);

    vi.advanceTimersByTime(TTL + 1);

    // Any later operation sweeps the stranded queue.
    await queue.enqueue('other', makeMessage(2));
    expect(queueCount(inner)).toBe(1);
    expect(queue.trackedCount).toBe(1);
  });

  it('keeps a queue alive while the task is still being worked', async () => {
    vi.useFakeTimers();
    const inner = new InMemoryTaskMessageQueue();
    const queue = new EvictingTaskMessageQueue(inner, TTL);

    await queue.enqueue('busy', makeMessage(1));
    // Activity inside the window refreshes the deadline, twice over.
    vi.advanceTimersByTime(TTL - 1);
    await queue.enqueue('busy', makeMessage(2));
    vi.advanceTimersByTime(TTL - 1);

    await expect(queue.dequeue('busy')).resolves.toMatchObject({
      params: { data: 'message-1' },
    });
  });

  it('releases the deadline when dequeueAll drains a task', async () => {
    const inner = new InMemoryTaskMessageQueue();
    const queue = new EvictingTaskMessageQueue(inner, TTL);

    await queue.enqueue('collected', makeMessage(1));
    expect(queue.trackedCount).toBe(1);

    await expect(queue.dequeueAll('collected')).resolves.toHaveLength(1);
    expect(queue.trackedCount).toBe(0);
    expect(queueCount(inner)).toBe(0);
  });

  it('does not evict when the TTL is disabled', async () => {
    vi.useFakeTimers();
    const inner = new InMemoryTaskMessageQueue();
    const queue = new EvictingTaskMessageQueue(inner, 0);

    await queue.enqueue('forever', makeMessage(1));
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
    await queue.enqueue('other', makeMessage(2));

    expect(queueCount(inner)).toBe(2);
    expect(queue.trackedCount).toBe(0);
  });

  it('passes maxSize through so overflow still throws', async () => {
    const inner = new InMemoryTaskMessageQueue();
    const queue = new EvictingTaskMessageQueue(inner, TTL);

    await queue.enqueue('bounded', makeMessage(1), undefined, 1);
    await expect(queue.enqueue('bounded', makeMessage(2), undefined, 1)).rejects.toThrow(
      /overflow/i,
    );
  });
});
