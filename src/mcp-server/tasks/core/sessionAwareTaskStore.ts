/**
 * @fileoverview A TaskStore wrapper that enforces session ownership on top of
 * the SDK's InMemoryTaskStore (which ignores sessionId parameters).
 *
 * This ensures that in HTTP mode, tasks created by one session cannot be
 * accessed by another session, even when using the in-memory store.
 *
 * @experimental These APIs are experimental and may change without notice.
 * @module src/mcp-server/tasks/core/sessionAwareTaskStore
 */
import type { Request, RequestId, Result } from '@modelcontextprotocol/sdk/types.js';

import { forbidden } from '@/types-global/errors.js';
import { type CreateTaskOptions, isTerminal, type Task, type TaskStore } from './taskTypes.js';

/**
 * Wraps an InMemoryTaskStore to add session ownership enforcement.
 *
 * Tracks which session created each task and rejects access from
 * non-owning sessions. Tasks created without a sessionId are accessible
 * by any session (backwards-compatible with stdio/unauth flows).
 *
 * @experimental
 */
export class SessionAwareTaskStore implements TaskStore {
  /**
   * Maps taskId -> owning sessionId and the deadline past which the row is
   * reclaimable.
   *
   * The inner store drops a task once its TTL elapses, so an ownership row
   * that outlives it is pure leak — one permanent entry per task call, since
   * every HTTP request transport carries a sessionId. Mirroring the inner
   * store's own expiry keeps this map's lifetime bounded by the tasks it
   * describes. `Infinity` covers a task created without a TTL, which the
   * inner store likewise never evicts.
   */
  private readonly ownership = new Map<
    string,
    { sessionId: string; ttl: number | null; expiresAt: number }
  >();

  constructor(private readonly inner: TaskStore) {}

  /**
   * Owning session for a task, or `undefined` when unowned or expired.
   * Prunes the row on the way past — a lazy sweep costs one comparison on a
   * path that is already touching the entry.
   */
  private ownerOf(taskId: string): string | undefined {
    const record = this.ownership.get(taskId);
    if (!record) return;
    if (Date.now() >= record.expiresAt) {
      this.ownership.delete(taskId);
      return;
    }
    return record.sessionId;
  }

  /**
   * Refresh a row's deadline, mirroring the inner store's TTL reset. The TTL
   * is fixed when the task is created, so this needs no read of the inner
   * store.
   */
  private touch(taskId: string): void {
    const record = this.ownership.get(taskId);
    if (!record) return;
    record.expiresAt = record.ttl ? Date.now() + record.ttl : Number.POSITIVE_INFINITY;
  }

  /** Drop every expired row. Runs on task creation, where the map grows. */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [taskId, record] of this.ownership) {
      if (now >= record.expiresAt) this.ownership.delete(taskId);
    }
  }

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    const task = await this.inner.createTask(taskParams, requestId, request, sessionId);
    if (sessionId) {
      this.sweepExpired();
      const ttl = task.ttl ?? null;
      this.ownership.set(task.taskId, {
        sessionId,
        ttl,
        expiresAt: ttl ? Date.now() + ttl : Number.POSITIVE_INFINITY,
      });
    }
    return task;
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    this.assertOwnership(taskId, sessionId);
    return await this.inner.getTask(taskId, sessionId);
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    this.assertOwnership(taskId, sessionId);
    await this.inner.storeTaskResult(taskId, status, result, sessionId);
    // The inner store restarts the task's cleanup timer here; keep the
    // ownership row alive exactly as long as the task it describes.
    this.touch(taskId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    this.assertOwnership(taskId, sessionId);
    return await this.inner.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    this.assertOwnership(taskId, sessionId);
    await this.inner.updateTaskStatus(taskId, status, statusMessage, sessionId);
    // Terminal status starts the inner store's TTL countdown afresh.
    if (isTerminal(status)) this.touch(taskId);
  }

  async listTasks(
    cursor?: string,
    sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const result = await this.inner.listTasks(cursor, sessionId);
    // Filter: session-bound tasks are only visible to their owning session.
    // Sessionless callers see only unowned tasks (consistent with StorageBackedTaskStore).
    const filtered = result.tasks.filter((task) => {
      const owner = this.ownerOf(task.taskId);
      if (!owner) return true; // Unowned — visible to everyone
      return owner === sessionId; // Session-bound — visible only to owner
    });
    const out: { tasks: Task[]; nextCursor?: string } = { tasks: filtered };
    if (result.nextCursor) out.nextCursor = result.nextCursor;
    return out;
  }

  /**
   * Validates that the caller's session matches the task's owner.
   * Tasks created without a sessionId are accessible by any session.
   *
   * Once the row expires this falls through rather than throwing, so a probe
   * for an evicted taskId gets the inner store's uniform not-found instead of
   * a `Forbidden` that would confirm the id had once existed.
   */
  private assertOwnership(taskId: string, callerSessionId: string | undefined): void {
    const owner = this.ownerOf(taskId);
    if (!owner) return; // No owner recorded — accessible by anyone
    if (owner !== callerSessionId) {
      throw forbidden(`Access denied to task ${taskId}`);
    }
  }
}
