/**
 * @fileoverview Encapsulates the registration of all tool definitions with an McpServer.
 * Supports ToolDefinition (standard and auto-task via `task: true`) and TaskToolDefinition
 * (escape hatch for custom task lifecycle).
 * @module src/mcp-server/tools/tool-registration
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape } from 'zod';

import { config } from '@/config/index.js';
import { attachTypedFail, createContext } from '@/core/context.js';
import {
  isTaskToolDefinition,
  type TaskToolDefinition,
} from '@/mcp-server/tasks/utils/taskToolDefinition.js';
import { getDisabledMetadata } from '@/mcp-server/tools/utils/disabled-tool.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  buildToolErrorResult,
  classifyAndBuildToolErrorResult,
  createToolHandler,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { authContext } from '@/mcp-server/transports/auth/lib/authContext.js';
import type { AuthInfo } from '@/mcp-server/transports/auth/lib/authTypes.js';
import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/** Options for background auto-task execution. */
interface AutoTaskOptions {
  callerAuth?: AuthInfo | undefined;
  taskId: string;
  taskStore: RequestTaskStore;
  ttlMs: number;
}

/** Default TTL for auto-task tools when config doesn't specify one. */
const DEFAULT_AUTO_TASK_TTL_MS = 120_000;

/** Union of all accepted tool definition shapes. */
export type AnyToolDef =
  | AnyToolDefinition
  | TaskToolDefinition<ZodObject<ZodRawShape>, ZodObject<ZodRawShape>>;

type McpServerWithToolHandlerInit = {
  setToolRequestHandlers: () => void;
};

export class ToolRegistry {
  /** Tracks registered tool names to detect duplicates at startup. */
  private readonly registeredNames = new Set<string>();

  constructor(
    private toolDefs: AnyToolDef[],
    private services?: HandlerFactoryServices,
  ) {}

  /**
   * Registers all tool definitions with the provided McpServer instance.
   * Automatically detects standard tools, auto-task tools (task: true),
   * and escape-hatch TaskToolDefinitions.
   */
  public async registerAll(server: McpServer): Promise<void> {
    // Reset per-server uniqueness tracking — registries are shared across
    // per-request McpServer instances in HTTP mode (GHSA-345p-7cg4-v4c7).
    this.registeredNames.clear();

    // Per-server notifier closures. Bound once per registerAll() call and
    // passed through to each handler factory — never mutated on a shared
    // services object (which would race under concurrent HTTP requests).
    const notifiers: HandlerNotifiers = {
      notifyResourceListChanged: () => server.sendResourceListChanged(),
      notifyResourceUpdated: (uri: string) => server.server.sendResourceUpdated({ uri }),
    };

    const context = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerAll',
    });

    const standardTools: AnyToolDefinition[] = [];
    const taskTools: TaskToolDefinition<ZodObject<ZodRawShape>, ZodObject<ZodRawShape>>[] = [];
    let disabledCount = 0;

    for (const def of this.toolDefs) {
      const disabled = getDisabledMetadata(def);
      if (disabled) {
        disabledCount++;
        logger.debug(
          `Skipping MCP registration for disabled tool '${def.name}': ${disabled.reason}`,
          context,
        );
        continue;
      }
      if (isTaskToolDefinition(def)) {
        taskTools.push(def);
      } else {
        standardTools.push(def as AnyToolDefinition);
      }
    }

    const disabledNote = disabledCount > 0 ? ` (${disabledCount} disabled, skipped)` : '';
    logger.debug(
      `Registering ${standardTools.length} regular tool(s) and ${taskTools.length} task tool(s)${disabledNote}...`,
      context,
    );

    // The SDK only installs tools/list + tools/call handlers the first time a
    // non-task tool is registered. Initialize them up front so empty servers
    // and task-only servers still expose truthful MCP tool behavior.
    (server as unknown as McpServerWithToolHandlerInit).setToolRequestHandlers();

    // Register standard tools (regular and auto-task)
    for (const toolDef of standardTools) {
      if (toolDef.task) {
        await this.registerAutoTaskTool(server, toolDef, notifiers);
      } else {
        await this.registerTool(server, toolDef, notifiers);
      }
    }

    // Register escape-hatch task tools via experimental API
    for (const toolDef of taskTools) {
      await this.registerTaskTool(server, toolDef);
    }
  }

  /** Throws at startup if a tool with the same name was already registered. */
  private assertUniqueName(name: string): void {
    if (this.registeredNames.has(name)) {
      throw new Error(
        `Duplicate tool name '${name}': a tool with this name is already registered. ` +
          'Each tool must have a unique name.',
      );
    }
    this.registeredNames.add(name);
  }

  private deriveTitleFromName(name: string): string {
    return name.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  /**
   * Registers a standard tool definition.
   * Requires `services` to have been passed to the constructor for Context creation.
   */
  private async registerTool(
    server: McpServer,
    tool: AnyToolDefinition,
    notifiers: HandlerNotifiers,
  ): Promise<void> {
    const registrationContext = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerTool',
      toolName: tool.name,
    });

    logger.debug(`Registering tool: '${tool.name}'`, registrationContext);

    this.assertUniqueName(tool.name);

    await ErrorHandler.tryCatch(
      () => {
        if (!this.services) {
          throw new Error(
            `Cannot register tool '${tool.name}': HandlerFactoryServices not provided to ToolRegistry`,
          );
        }

        const handler = createToolHandler(tool, this.services, notifiers);
        const title = tool.title ?? tool.annotations?.title ?? this.deriveTitleFromName(tool.name);

        // Type assertion required: SDK's conditional types don't resolve with erased generics
        server.registerTool(
          tool.name,
          {
            title,
            description: tool.description,
            inputSchema: tool.input,
            outputSchema: tool.output,
            ...(tool.annotations && { annotations: tool.annotations }),
            ...(tool._meta && { _meta: tool._meta }),
          },
          handler as ToolCallback<typeof tool.input>,
        );

        logger.debug(`Tool '${tool.name}' registered successfully.`, registrationContext);
      },
      {
        operation: `RegisteringTool_${tool.name}`,
        context: registrationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      },
    );
  }

  /**
   * Registers a tool with `task: true` via the experimental Tasks API.
   * Auto-generates task handlers from the definition's `handler` function.
   * The framework manages the full task lifecycle: create, background run, store result.
   */
  private async registerAutoTaskTool(
    server: McpServer,
    tool: AnyToolDefinition,
    notifiers: HandlerNotifiers,
  ): Promise<void> {
    const registrationContext = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerAutoTaskTool',
      toolName: tool.name,
    });

    logger.debug(`Registering auto-task tool (task: true): '${tool.name}'`, registrationContext);

    this.assertUniqueName(tool.name);

    await ErrorHandler.tryCatch(
      () => {
        if (!this.services) {
          throw new Error(
            `Cannot register auto-task tool '${tool.name}': HandlerFactoryServices not provided to ToolRegistry`,
          );
        }

        const services = this.services;
        const title = tool.title ?? tool.annotations?.title ?? this.deriveTitleFromName(tool.name);
        const taskTtlMs = config.tasks.defaultTtlMs ?? DEFAULT_AUTO_TASK_TTL_MS;
        const formatter = (result: unknown): ContentBlock[] =>
          tool.format
            ? tool.format(result as Record<string, unknown>)
            : [{ type: 'text', text: JSON.stringify(result, null, 2) }];

        server.experimental.tasks.registerToolTask(
          tool.name,
          {
            title,
            description: tool.description,
            inputSchema: tool.input,
            outputSchema: tool.output,
            ...(tool.annotations && { annotations: tool.annotations }),
            ...(tool._meta && { _meta: tool._meta }),
            execution: { taskSupport: 'optional' },
          },
          {
            createTask: async (args, extra) => {
              // Capture auth info from the request's ALS before firing the
              // background handler — ALS is gone once we leave this scope.
              const callerAuth = authContext.getStore()?.authInfo;

              // Check inline auth scopes in the request path (inside ALS context)
              // before creating the task — not in the background handler.
              if (tool.auth && tool.auth.length > 0) {
                withRequiredScopes(tool.auth);
              }

              const validatedInput = tool.input.parse(args);

              const task = await extra.taskStore.createTask({
                ttl: taskTtlMs,
                pollInterval: 1000,
              });

              // Fire-and-forget: run handler in background
              void this.runAutoTaskHandler(tool, validatedInput, services, notifiers, formatter, {
                taskId: task.taskId,
                taskStore: extra.taskStore,
                ttlMs: taskTtlMs,
                callerAuth,
              });

              return { task };
            },
            getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
            getTaskResult: async (_args, extra) =>
              (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
          },
        );

        logger.debug(
          `Auto-task tool '${tool.name}' registered successfully (experimental).`,
          registrationContext,
        );
      },
      {
        operation: `RegisteringAutoTaskTool_${tool.name}`,
        context: registrationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      },
    );
  }

  /**
   * Runs a tool handler as a background task.
   * Creates Context with `progress` and `signal`, stores result/error on completion.
   * Enforces a deadline matching the task entry TTL to prevent leaked resources.
   */
  private async runAutoTaskHandler(
    tool: AnyToolDefinition,
    input: unknown,
    services: HandlerFactoryServices,
    notifiers: HandlerNotifiers,
    formatter: (result: unknown) => ContentBlock[],
    opts: AutoTaskOptions,
  ): Promise<void> {
    const { taskId, taskStore, ttlMs, callerAuth } = opts;
    const abortController = new AbortController();

    // Enforce handler execution deadline matching the task entry TTL.
    // Uses setTimeout + AbortController for cross-runtime compatibility
    // (AbortSignal.timeout() can fail in Bun's stdio transport due to realm mismatch).
    const TIMEOUT_SENTINEL = Symbol.for('AUTO_TASK_TIMEOUT');
    const timeoutId = setTimeout(() => abortController.abort(TIMEOUT_SENTINEL), ttlMs);

    // Poll for cancellation every 2 seconds
    const cancelInterval = setInterval(async () => {
      try {
        const task = await taskStore.getTask(taskId);
        if (task.status === 'cancelled') {
          abortController.abort();
        }
      } catch {
        // Task may have been cleaned up — abort to unblock handler
        abortController.abort();
      }
    }, 2000);

    try {
      // Auth scopes are checked in createTask (inside the request's ALS context),
      // not here — this runs in a detached background context where ALS is gone.
      // We use the captured callerAuth to populate ctx.auth for identity access.
      const appContext = callerAuth
        ? requestContextService.withAuthInfo(callerAuth, {
            operation: 'AutoTaskHandler',
            toolName: tool.name,
            taskId,
          })
        : requestContextService.createRequestContext({
            operation: 'AutoTaskHandler',
            additionalContext: { toolName: tool.name, taskId },
          });

      // Mirror createToolHandler's ctx construction so auto-task handlers that
      // call `ctx.fail(...)` work — without `attachTypedFail` they would crash
      // with `ctx.fail is not a function` when the contract is declared.
      const ctx = attachTypedFail(
        createContext({
          appContext,
          logger: services.logger,
          storage: services.storage,
          signal: abortController.signal,
          taskCtx: { store: taskStore, taskId },
          notifyResourceListChanged: notifiers.notifyResourceListChanged,
          notifyResourceUpdated: notifiers.notifyResourceUpdated,
        }),
        tool.errors,
      );

      const result = await Promise.resolve(tool.handler(input as Record<string, unknown>, ctx));
      const validatedResult = tool.output.parse(result);

      await taskStore.storeTaskResult(taskId, 'completed', {
        content: formatter(validatedResult),
        structuredContent: validatedResult,
      });
    } catch (error: unknown) {
      // If cancelled, the SDK already set the terminal state — don't overwrite
      if (abortController.signal.aborted && abortController.signal.reason !== TIMEOUT_SENTINEL) {
        return;
      }

      // Route through ErrorHandler for OTel span, structured logging, and classification
      ErrorHandler.handleError(error, {
        operation: `auto-task:${tool.name}`,
        context: { taskId, toolName: tool.name },
        input,
      });

      try {
        const isTimeout = abortController.signal.reason === TIMEOUT_SENTINEL;
        const result = isTimeout
          ? buildToolErrorResult(
              JsonRpcErrorCode.Timeout,
              `Task timed out after ${ttlMs}ms`,
              undefined,
            )
          : classifyAndBuildToolErrorResult(error);
        await taskStore.storeTaskResult(taskId, 'failed', result);
      } catch {
        // Task may already be in terminal state
      }
    } finally {
      clearTimeout(timeoutId);
      clearInterval(cancelInterval);
      // Ensure abort controller is released — signals any lingering listeners
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }
  }

  /**
   * Registers a task-based tool with the MCP server via the experimental Tasks API.
   * Task tools support long-running async operations with polling for status and results.
   *
   * @experimental
   */
  private async registerTaskTool<
    TInputSchema extends ZodObject<ZodRawShape>,
    TOutputSchema extends ZodObject<ZodRawShape>,
  >(server: McpServer, tool: TaskToolDefinition<TInputSchema, TOutputSchema>): Promise<void> {
    const registrationContext = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerTaskTool',
      toolName: tool.name,
    });

    logger.debug(`Registering task tool: '${tool.name}' (experimental)`, registrationContext);

    this.assertUniqueName(tool.name);

    await ErrorHandler.tryCatch(
      () => {
        const title = tool.title ?? tool.annotations?.title ?? this.deriveTitleFromName(tool.name);

        // TaskToolDefinition is the escape hatch for fully-custom task lifecycle
        // and does not declare an `errors[]` contract — `_meta` flows through unchanged.
        server.experimental.tasks.registerToolTask(
          tool.name,
          {
            title,
            description: tool.description,
            inputSchema: tool.input,
            ...(tool.output && { outputSchema: tool.output }),
            ...(tool.annotations && { annotations: tool.annotations }),
            ...(tool._meta && { _meta: tool._meta }),
            execution: tool.execution,
          },
          tool.taskHandlers,
        );

        logger.debug(
          `Task tool '${tool.name}' registered successfully (experimental).`,
          registrationContext,
        );
      },
      {
        operation: `RegisteringTaskTool_${tool.name}`,
        context: registrationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      },
    );
  }
}
