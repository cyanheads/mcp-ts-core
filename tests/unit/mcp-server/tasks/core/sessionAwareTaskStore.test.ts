/**
 * @fileoverview Tests for the SessionAwareTaskStore.
 * @module tests/mcp-server/tasks/core/sessionAwareTaskStore.test
 */

import type { Request, RequestId, Result } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { SessionAwareTaskStore } from '@/mcp-server/tasks/core/sessionAwareTaskStore.js';
import type { Task, TaskStore } from '@/mcp-server/tasks/core/taskTypes.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

function makeTask(taskId: string, status: Task['status'] = 'working'): Task {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-01-01T00:00:00.000Z',
    pollInterval: 1000,
    status,
    taskId,
    ttl: 60_000,
  };
}

describe('SessionAwareTaskStore', () => {
  const testRequest: Request = {
    method: 'tools/call',
    params: { arguments: { foo: 'bar' }, name: 'test_tool' },
  };
  const testRequestId: RequestId = 1;
  const testResult: Result = {
    content: [{ text: 'done', type: 'text' }],
  };

  it('enforces ownership for session-bound tasks', async () => {
    const task = makeTask('task-owned');
    const innerCreateTask = vi.fn().mockResolvedValue(task);
    const innerGetTask = vi.fn().mockResolvedValue(task);
    const store = new SessionAwareTaskStore({
      createTask: innerCreateTask,
      getTask: innerGetTask,
    } as unknown as TaskStore);

    await expect(
      store.createTask({ ttl: 30_000 }, testRequestId, testRequest, 'session-a'),
    ).resolves.toEqual(task);
    await expect(store.getTask(task.taskId, 'session-a')).resolves.toEqual(task);
    await expect(store.getTask(task.taskId, 'session-b')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message: `Access denied to task ${task.taskId}`,
    });

    expect(innerCreateTask).toHaveBeenCalledWith(
      { ttl: 30_000 },
      testRequestId,
      testRequest,
      'session-a',
    );
    expect(innerGetTask).toHaveBeenCalledTimes(1);
  });

  it('allows unowned tasks to be accessed by any session', async () => {
    const task = makeTask('task-unowned');
    const innerGetTask = vi.fn().mockResolvedValue(task);
    const store = new SessionAwareTaskStore({
      createTask: vi.fn().mockResolvedValue(task),
      getTask: innerGetTask,
    } as unknown as TaskStore);

    await store.createTask({ ttl: 30_000 }, testRequestId, testRequest);

    await expect(store.getTask(task.taskId, 'session-any')).resolves.toEqual(task);
    expect(innerGetTask).toHaveBeenCalledWith(task.taskId, 'session-any');
  });

  it('retains ownership after a terminal result is stored', async () => {
    const task = makeTask('task-result');
    const innerGetTaskResult = vi.fn().mockResolvedValue(testResult);
    const innerStoreTaskResult = vi.fn().mockResolvedValue(undefined);
    const store = new SessionAwareTaskStore({
      createTask: vi.fn().mockResolvedValue(task),
      getTaskResult: innerGetTaskResult,
      storeTaskResult: innerStoreTaskResult,
    } as unknown as TaskStore);

    await store.createTask({ ttl: 30_000 }, testRequestId, testRequest, 'session-a');
    await store.storeTaskResult(task.taskId, 'completed', testResult, 'session-a');

    // Ownership persists — session-b is still denied
    await expect(store.getTaskResult(task.taskId, 'session-b')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    // Owner can still access
    await expect(store.getTaskResult(task.taskId, 'session-a')).resolves.toEqual(testResult);
    expect(innerStoreTaskResult).toHaveBeenCalledWith(
      task.taskId,
      'completed',
      testResult,
      'session-a',
    );
  });

  it('retains ownership through non-terminal and terminal status updates', async () => {
    const task = makeTask('task-status');
    const innerGetTask = vi.fn().mockResolvedValue(task);
    const innerUpdateTaskStatus = vi.fn().mockResolvedValue(undefined);
    const store = new SessionAwareTaskStore({
      createTask: vi.fn().mockResolvedValue(task),
      getTask: innerGetTask,
      updateTaskStatus: innerUpdateTaskStatus,
    } as unknown as TaskStore);

    await store.createTask({ ttl: 30_000 }, testRequestId, testRequest, 'session-a');
    await store.updateTaskStatus(task.taskId, 'working', 'still processing', 'session-a');

    // Non-terminal: session-b still blocked
    await expect(store.getTask(task.taskId, 'session-b')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });

    await store.updateTaskStatus(task.taskId, 'completed', 'done', 'session-a');

    // Terminal: session-b still blocked (ownership persists)
    await expect(store.getTask(task.taskId, 'session-b')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    // Owner can still access
    await expect(store.getTask(task.taskId, 'session-a')).resolves.toEqual(task);
  });

  it('filters task listings to the caller session while preserving unowned tasks and cursors', async () => {
    const taskA = makeTask('task-a');
    const taskB = makeTask('task-b');
    const taskC = makeTask('task-c');
    const innerListTasks = vi.fn().mockResolvedValue({
      nextCursor: 'cursor-2',
      tasks: [taskA, taskB, taskC],
    });
    const store = new SessionAwareTaskStore({
      createTask: vi
        .fn()
        .mockResolvedValueOnce(taskA)
        .mockResolvedValueOnce(taskB)
        .mockResolvedValueOnce(taskC),
      listTasks: innerListTasks,
    } as unknown as TaskStore);

    await store.createTask({ ttl: 30_000 }, testRequestId, testRequest, 'session-a');
    await store.createTask({ ttl: 30_000 }, testRequestId, testRequest, 'session-b');
    await store.createTask({ ttl: 30_000 }, testRequestId, testRequest);

    // session-a sees own tasks + unowned
    await expect(store.listTasks('cursor-1', 'session-a')).resolves.toEqual({
      nextCursor: 'cursor-2',
      tasks: [taskA, taskC],
    });
    // Sessionless caller sees only unowned tasks (session-bound tasks hidden)
    await expect(store.listTasks('cursor-1')).resolves.toEqual({
      nextCursor: 'cursor-2',
      tasks: [taskC],
    });

    expect(innerListTasks).toHaveBeenNthCalledWith(1, 'cursor-1', 'session-a');
    expect(innerListTasks).toHaveBeenNthCalledWith(2, 'cursor-1', undefined);
  });

  // The inner store drops the task at TTL, so an ownership row that outlives
  // it leaks one permanent entry per task call under HTTP. (#276)
  describe('ownership eviction', () => {
    /** Reach the private map — there is no public accessor for bookkeeping. */
    function ownershipOf(store: SessionAwareTaskStore): Map<string, unknown> {
      return (store as unknown as { ownership: Map<string, unknown> }).ownership;
    }

    it('reclaims a row once the task TTL has elapsed', async () => {
      vi.useFakeTimers();
      try {
        const task = makeTask('task-expiring');
        const store = new SessionAwareTaskStore({
          createTask: vi.fn().mockResolvedValue(task),
          getTask: vi.fn().mockResolvedValue(null),
        } as unknown as TaskStore);

        await store.createTask({ ttl: task.ttl }, testRequestId, testRequest, 'session-a');
        expect(ownershipOf(store).size).toBe(1);

        vi.advanceTimersByTime(60_001);

        // A read past the deadline prunes the row on the way through.
        await store.getTask(task.taskId, 'session-a');
        expect(ownershipOf(store).size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls through to not-found instead of Forbidden once the row expires', async () => {
      vi.useFakeTimers();
      try {
        const task = makeTask('task-evicted');
        const innerGetTask = vi.fn().mockResolvedValue(null);
        const store = new SessionAwareTaskStore({
          createTask: vi.fn().mockResolvedValue(task),
          getTask: innerGetTask,
        } as unknown as TaskStore);

        await store.createTask({ ttl: task.ttl }, testRequestId, testRequest, 'session-a');
        vi.advanceTimersByTime(60_001);

        // A stale Forbidden would confirm to a stranger that the id existed.
        await expect(store.getTask(task.taskId, 'session-b')).resolves.toBeNull();
        expect(innerGetTask).toHaveBeenCalledWith(task.taskId, 'session-b');
      } finally {
        vi.useRealTimers();
      }
    });

    it('sweeps expired rows as new tasks are created', async () => {
      vi.useFakeTimers();
      try {
        const first = makeTask('task-1');
        const second = makeTask('task-2');
        const store = new SessionAwareTaskStore({
          createTask: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
        } as unknown as TaskStore);

        await store.createTask({ ttl: first.ttl }, testRequestId, testRequest, 'session-a');
        vi.advanceTimersByTime(60_001);
        await store.createTask({ ttl: second.ttl }, testRequestId, testRequest, 'session-a');

        expect([...ownershipOf(store).keys()]).toEqual(['task-2']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('extends the deadline when a terminal status resets the inner TTL', async () => {
      vi.useFakeTimers();
      try {
        const task = makeTask('task-terminal');
        const store = new SessionAwareTaskStore({
          createTask: vi.fn().mockResolvedValue(task),
          getTask: vi.fn().mockResolvedValue(task),
          updateTaskStatus: vi.fn().mockResolvedValue(undefined),
        } as unknown as TaskStore);

        await store.createTask({ ttl: task.ttl }, testRequestId, testRequest, 'session-a');

        // Just shy of the original deadline, go terminal — the inner store
        // restarts its cleanup timer, so ownership must not expire first.
        vi.advanceTimersByTime(59_999);
        await store.updateTaskStatus(task.taskId, 'completed', undefined, 'session-a');
        vi.advanceTimersByTime(59_999);

        await expect(store.getTask(task.taskId, 'session-b')).rejects.toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('never expires a task created without a TTL', async () => {
      vi.useFakeTimers();
      try {
        const task = { ...makeTask('task-forever'), ttl: undefined } as unknown as Task;
        const store = new SessionAwareTaskStore({
          createTask: vi.fn().mockResolvedValue(task),
          getTask: vi.fn().mockResolvedValue(task),
        } as unknown as TaskStore);

        await store.createTask({}, testRequestId, testRequest, 'session-a');
        vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);

        await expect(store.getTask(task.taskId, 'session-b')).rejects.toMatchObject({
          code: JsonRpcErrorCode.Forbidden,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
