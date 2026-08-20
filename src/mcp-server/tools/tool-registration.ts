/**
 * @fileoverview Encapsulates the registration of all tool definitions with an McpServer.
 * @module src/mcp-server/tools/tool-registration
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/server';

import type { ResourceSubscriptions } from '@/mcp-server/notifications.js';
import { getDisabledMetadata } from '@/mcp-server/tools/utils/disabled-tool.js';
import type { AnyToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import {
  advertisedOutputSchema,
  createToolHandler,
  type HandlerFactoryServices,
  type HandlerNotifiers,
} from '@/mcp-server/tools/utils/toolHandlerFactory.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/**
 * Union of all accepted tool definition shapes.
 *
 * A single shape since 0.12.0 — the experimental tasks surface (SEP-1686) was
 * removed from the SDK in v2, taking `TaskToolDefinition` with it.
 */
export type AnyToolDef = AnyToolDefinition;

export class ToolRegistry {
  /** Tracks registered tool names to detect duplicates at startup. */
  private readonly registeredNames = new Set<string>();

  constructor(
    private toolDefs: AnyToolDef[],
    private services?: HandlerFactoryServices,
  ) {}

  /** Registers all tool definitions with the provided McpServer instance. */
  public async registerAll(
    server: McpServer,
    subscriptions?: ResourceSubscriptions,
  ): Promise<void> {
    // Reset per-server uniqueness tracking — registries are shared across
    // per-request McpServer instances under HTTP serving.
    this.registeredNames.clear();

    // Per-server notifier closures targeting `server.send*ListChanged()`. Bound
    // once per registerAll() call — never mutated on a shared services object
    // (which would race under concurrent HTTP requests). The handler factory
    // prefers request-scoped notifiers (#135) and falls back to these.
    const notifiers: HandlerNotifiers = {
      notifyPromptListChanged: () => server.sendPromptListChanged(),
      notifyResourceListChanged: () => server.sendResourceListChanged(),
      notifyToolListChanged: () => server.sendToolListChanged(),
      ...(subscriptions && { subscriptions }),
    };

    const context = requestContextService.createRequestContext({
      operation: 'ToolRegistry.registerAll',
    });

    const tools: AnyToolDefinition[] = [];
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
      tools.push(def);
    }

    const disabledNote = disabledCount > 0 ? ` (${disabledCount} disabled, skipped)` : '';
    logger.debug(`Registering ${tools.length} tool(s)${disabledNote}...`, context);

    // `tools/list` and `tools/call` are installed by the SDK from the declared
    // `tools` capability, so a server with every tool disabled still answers
    // `tools/list` with an empty array rather than `-32601`.
    for (const toolDef of tools) {
      await this.registerTool(server, toolDef, notifiers);
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
            outputSchema: advertisedOutputSchema(tool),
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
}
