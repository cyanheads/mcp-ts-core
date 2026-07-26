/**
 * @fileoverview Re-exports task-related types from the MCP SDK experimental module.
 * These types are used for implementing task-based tools that support long-running
 * async operations with the "call-now, fetch-later" pattern.
 *
 * @experimental These APIs are experimental and may change without notice.
 * @module src/mcp-server/tasks/core/taskTypes
 */

// Core task types from SDK
// Task store and queue interfaces
// Handler types for task-based tools
// Response message types for streaming task results
export type {
  CancelTaskRequest,
  CancelTaskResult,
  CreateTaskOptions,
  CreateTaskRequestHandlerExtra,
  CreateTaskResult,
  ErrorMessage,
  GetTaskPayloadRequest,
  GetTaskRequest,
  GetTaskResult,
  ListTasksRequest,
  ListTasksResult,
  QueuedMessage,
  RelatedTaskMetadata,
  ResponseMessage,
  ResultMessage,
  Task,
  TaskCreatedMessage,
  TaskCreationParams,
  TaskMessageQueue,
  TaskRequestHandlerExtra,
  TaskStatusMessage,
  TaskStatusNotification,
  TaskStatusNotificationParams,
  TaskStore,
  TaskToolExecution,
  ToolTaskHandler,
} from '@modelcontextprotocol/sdk/experimental/tasks';
// In-memory implementations (reference implementations)
// Utility functions
// Helper functions for processing task responses
export {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  isTerminal,
  takeResult,
  toArrayAsync,
} from '@modelcontextprotocol/sdk/experimental/tasks';

/**
 * TTL applied to a task when `TASK_STORE_DEFAULT_TTL_MS` is unset.
 *
 * Shared so task creation and the bookkeeping that must expire alongside it
 * (ownership rows, message queues) cannot drift onto different lifetimes.
 */
export const DEFAULT_AUTO_TASK_TTL_MS = 120_000;
