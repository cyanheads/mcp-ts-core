/**
 * @fileoverview A TaskMessageQueue wrapper that expires a task's queue on the
 * same schedule as the task itself.
 *
 * The SDK's `InMemoryTaskMessageQueue` deletes a queue only in `dequeueAll`,
 * which the SDK calls on `tasks/result` retrieval and `tasks/cancel`. Both
 * `enqueue` and `dequeue` allocate-and-keep a queue for any taskId they touch,
 * so a client that abandons a task — never fetching its result, never
 * cancelling — strands that queue and any messages in it for the life of the
 * process. Nothing in the SDK parallels the task store's TTL.
 *
 * @experimental These APIs are experimental and may change without notice.
 * @module src/mcp-server/tasks/core/evictingTaskMessageQueue
 */
import type { QueuedMessage, TaskMessageQueue } from './taskTypes.js';

/**
 * Wraps a {@link TaskMessageQueue} so each task's queue is reclaimed once its
 * TTL elapses.
 *
 * Eviction is lazy and traffic-driven rather than timer-based: a deadline is
 * refreshed whenever a task's queue is touched, expired queues are dropped on
 * the next operation, and `dequeueAll` releases the deadline outright. That
 * keeps the wrapper free of per-task timers and correct on runtimes where a
 * timer would never fire.
 *
 * @experimental
 */
export class EvictingTaskMessageQueue implements TaskMessageQueue {
  private readonly deadlines = new Map<string, number>();

  /**
   * @param inner - Queue to delegate to.
   * @param ttlMs - Lifetime of an untouched queue. A non-positive value
   *   disables eviction, matching a task store configured without a TTL.
   */
  constructor(
    private readonly inner: TaskMessageQueue,
    private readonly ttlMs: number,
  ) {}

  private get evicts(): boolean {
    return this.ttlMs > 0;
  }

  /**
   * Drain queues whose deadline has passed, then extend `taskId`'s.
   *
   * `dequeueAll` is the inner queue's only delete path, so it doubles as the
   * eviction primitive here — dropping the messages and the map entry in one
   * call.
   */
  private async expireAndTouch(taskId: string): Promise<void> {
    if (!this.evicts) return;

    const now = Date.now();
    for (const [id, deadline] of this.deadlines) {
      if (now < deadline) continue;
      this.deadlines.delete(id);
      await this.inner.dequeueAll(id);
    }

    this.deadlines.set(taskId, now + this.ttlMs);
  }

  async enqueue(
    taskId: string,
    message: QueuedMessage,
    sessionId?: string,
    maxSize?: number,
  ): Promise<void> {
    await this.expireAndTouch(taskId);
    await this.inner.enqueue(taskId, message, sessionId, maxSize);
  }

  async dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined> {
    await this.expireAndTouch(taskId);
    return await this.inner.dequeue(taskId, sessionId);
  }

  async dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]> {
    this.deadlines.delete(taskId);
    return await this.inner.dequeueAll(taskId, sessionId);
  }

  /** Number of queues currently tracked for eviction. Exposed for tests. */
  get trackedCount(): number {
    return this.deadlines.size;
  }
}
