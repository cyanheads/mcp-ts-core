/**
 * @fileoverview Singleton service for managing MCP task state and message queues.
 * Supports both in-memory and storage-backed task stores based on configuration.
 *
 * Configure via environment variables:
 * - TASK_STORE_TYPE: 'in-memory' (default) or 'storage'
 * - TASK_STORE_TENANT_ID: Tenant ID for storage isolation (default: 'system-tasks')
 * - TASK_STORE_DEFAULT_TTL_MS: Default TTL in milliseconds (optional)
 *
 * @experimental These APIs are experimental and may change without notice.
 * @module src/mcp-server/tasks/core/taskManager
 */
import type { Request, RequestId, Result } from '@modelcontextprotocol/sdk/types.js';

import type { config as configType } from '@/config/index.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { idGenerator } from '@/utils/security/idGenerator.js';
import { ATTR_MCP_TASK_STATUS, ATTR_MCP_TASK_STORE_TYPE } from '@/utils/telemetry/attributes.js';
import { createCounter, createObservableGauge } from '@/utils/telemetry/metrics.js';
import { EvictingTaskMessageQueue } from './evictingTaskMessageQueue.js';
import { SessionAwareTaskStore } from './sessionAwareTaskStore.js';
import { StorageBackedTaskStore } from './storageBackedTaskStore.js';
import {
  type CreateTaskOptions,
  DEFAULT_AUTO_TASK_TTL_MS,
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  type Task,
  type TaskMessageQueue,
  type TaskStore,
} from './taskTypes.js';

// ---------------------------------------------------------------------------
// Task lifecycle metrics
// ---------------------------------------------------------------------------

let taskCreatedCounter: ReturnType<typeof createCounter> | undefined;
let taskStatusCounter: ReturnType<typeof createCounter> | undefined;

function getTaskMetrics() {
  taskCreatedCounter ??= createCounter('mcp.tasks.created', 'Total tasks created', '{tasks}');
  taskStatusCounter ??= createCounter(
    'mcp.tasks.status_changes',
    'Total task status transitions',
    '{transitions}',
  );
  return { taskCreatedCounter, taskStatusCounter };
}

/**
 * Wraps a TaskStore to record lifecycle metrics on create, status update,
 * and result storage. Delegates all actual logic to the inner store.
 */
class InstrumentedTaskStore implements TaskStore {
  constructor(
    private readonly inner: TaskStore,
    private readonly storeTypeLabel: string,
  ) {}

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    const task = await this.inner.createTask(taskParams, requestId, request, sessionId);
    getTaskMetrics().taskCreatedCounter.add(1, {
      [ATTR_MCP_TASK_STORE_TYPE]: this.storeTypeLabel,
    });
    return task;
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    await this.inner.storeTaskResult(taskId, status, result, sessionId);
    getTaskMetrics().taskStatusCounter.add(1, {
      [ATTR_MCP_TASK_STATUS]: status,
      [ATTR_MCP_TASK_STORE_TYPE]: this.storeTypeLabel,
    });
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.inner.updateTaskStatus(taskId, status, statusMessage, sessionId);
    getTaskMetrics().taskStatusCounter.add(1, {
      [ATTR_MCP_TASK_STATUS]: status,
      [ATTR_MCP_TASK_STORE_TYPE]: this.storeTypeLabel,
    });
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return this.inner.getTask(taskId, sessionId);
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.inner.getTaskResult(taskId, sessionId);
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.inner.listTasks(cursor, sessionId);
  }
}

/**
 * Singleton service that manages task state and message queues for the MCP server.
 *
 * The TaskManager provides:
 * - A shared TaskStore for creating, tracking, and completing tasks
 * - A shared TaskMessageQueue for side-channel message delivery
 * - Cleanup methods for graceful shutdown
 *
 * The store type is determined by configuration:
 * - `in-memory`: Fast, suitable for development (data lost on restart)
 * - `storage`: Persistent, uses configured StorageService backend
 *
 * @example
 * ```typescript
 * // Inject via DI
 * constructor(@inject(TaskManagerToken) private taskManager: TaskManager) {}
 *
 * // Access stores
 * const taskStore = this.taskManager.getTaskStore();
 * const messageQueue = this.taskManager.getMessageQueue();
 * ```
 *
 * @experimental
 */
export class TaskManager {
  private readonly taskStore: TaskStore;
  private readonly inMemoryTaskStore: InMemoryTaskStore | null = null;
  private readonly messageQueue: TaskMessageQueue;
  private readonly storeType: 'in-memory' | 'storage';
  private isShuttingDown = false;

  constructor(config: typeof configType, storageService: StorageService) {
    this.storeType = config.tasks.storeType;
    // The SDK's queue only ever deletes on `dequeueAll`, so a task the client
    // abandons strands its queue for the life of the process. Wrapping it
    // bounds queue lifetime by the same TTL the task store applies.
    this.messageQueue = new EvictingTaskMessageQueue(
      new InMemoryTaskMessageQueue(),
      config.tasks.defaultTtlMs ?? DEFAULT_AUTO_TASK_TTL_MS,
    );

    let baseStore: TaskStore;
    if (this.storeType === 'storage') {
      baseStore = new StorageBackedTaskStore(storageService, {
        tenantId: config.tasks.tenantId,
        defaultTtl: config.tasks.defaultTtlMs ?? null,
      });
    } else {
      this.inMemoryTaskStore = new InMemoryTaskStore();
      // Wrap with session ownership enforcement — the SDK's InMemoryTaskStore
      // ignores sessionId parameters, so SessionAwareTaskStore adds that layer.
      baseStore = new SessionAwareTaskStore(this.inMemoryTaskStore);
    }

    // Wrap with lifecycle metrics (outermost layer)
    this.taskStore = new InstrumentedTaskStore(baseStore, this.storeType);

    logger.info(`TaskManager initialized with ${this.storeType} task store`, {
      operation: 'TaskManager.constructor',
      requestId: idGenerator.generate('req'),
      timestamp: new Date().toISOString(),
      storeType: this.storeType,
      ...(this.storeType === 'storage' && { tenantId: config.tasks.tenantId }),
    });

    // Wire task count to OTel observable gauge
    if (this.inMemoryTaskStore) {
      const store = this.inMemoryTaskStore;
      createObservableGauge(
        'mcp.tasks.active',
        'Number of active tasks in the in-memory store',
        () => store.getAllTasks().length,
        '{tasks}',
      );
    }
  }

  /**
   * Returns the TaskStore instance for managing task lifecycle.
   *
   * The TaskStore handles:
   * - Task creation with TTL and poll intervals
   * - Status updates (working, input_required, completed, failed, cancelled)
   * - Result storage and retrieval
   * - Task listing with pagination
   *
   * @returns The singleton TaskStore instance
   */
  public getTaskStore(): TaskStore {
    return this.taskStore;
  }

  /**
   * Returns the TaskMessageQueue instance for side-channel messaging.
   *
   * The message queue enables:
   * - Queuing requests/notifications for delivery via tasks/result
   * - FIFO ordering per task
   * - Atomic enqueue with size limits
   *
   * @returns The singleton TaskMessageQueue instance
   */
  public getMessageQueue(): TaskMessageQueue {
    return this.messageQueue;
  }

  /**
   * Returns the store type currently in use.
   *
   * @returns 'in-memory' or 'storage'
   */
  public getStoreType(): 'in-memory' | 'storage' {
    return this.storeType;
  }

  /**
   * Performs cleanup of task resources.
   *
   * Should be called during graceful server shutdown to:
   * - Cancel cleanup timers in the in-memory task store
   * - Clear any pending message queues
   *
   * Note: Storage-backed task stores don't require cleanup as data persists.
   *
   * @param context - Request context for logging
   */
  public cleanup(context?: RequestContext): void {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    const logContext = context ?? {
      operation: 'TaskManager.cleanup',
      requestId: idGenerator.generate('req'),
      timestamp: new Date().toISOString(),
    };

    logger.info('Cleaning up TaskManager resources...', logContext);

    // Only InMemoryTaskStore has cleanup timers
    if (this.inMemoryTaskStore) {
      this.inMemoryTaskStore.cleanup();
    }

    logger.info('TaskManager cleanup complete', logContext);
  }

  /**
   * Returns the current task count (for debugging/monitoring).
   * Only available for in-memory store; returns `null` for storage-backed store.
   *
   * @returns The number of tasks currently tracked, or `null` if unavailable
   */
  public getTaskCount(): number | null {
    if (this.inMemoryTaskStore) {
      return this.inMemoryTaskStore.getAllTasks().length;
    }
    // Storage-backed store doesn't have getAllTasks - would require listing
    return null;
  }

  /**
   * Checks if the TaskManager is shutting down.
   *
   * @returns True if cleanup has been initiated
   */
  public isCleaningUp(): boolean {
    return this.isShuttingDown;
  }
}
