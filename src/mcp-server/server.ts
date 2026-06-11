/**
 * @fileoverview Factory for creating configured MCP server instances.
 * Creates an McpServer with identity, capabilities, and registered
 * tools/resources/prompts/roots from the provided registries.
 *
 * MCP Specification References:
 * - Lifecycle: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 * - Overview (Capabilities): https://modelcontextprotocol.io/specification/2025-06-18/basic/index
 * - Transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 * @module src/mcp-server/server
 */
import type { TaskMessageQueue, TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

import type { AppConfig } from '@/config/index.js';
import type { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import type { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import type { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/** Dependencies required to create an MCP server instance. */
export interface McpServerDeps {
  /**
   * When true, advertise the experimental `tasks` capability (SEP-1686).
   * The capability is gated on actual usage — at least one registered tool
   * must be a task tool — because the capability ships in spec revision
   * 2025-11-25 (GA) and clients pinned to 2025-06-18 fail on the unknown key.
   */
  advertiseTasks?: boolean;
  config: AppConfig;
  /**
   * One-line description forwarded to `new McpServer({ serverInfo })`.
   * Explicit option wins over `MCP_SERVER_DESCRIPTION` / `package.json`.
   */
  description?: string;
  /** SEP-2133 extensions to advertise in server capabilities. */
  extensions?: Record<string, object>;
  /** Server icon(s) forwarded to `new McpServer({ serverInfo })`. */
  icons?: Implementation['icons'];
  /**
   * Server-level orientation text. The MCP SDK includes this on every
   * `initialize` response; spec-compliant clients SHOULD forward it to the
   * model as session-level system context. Use for deployment-specific
   * guidance (configured shortcuts, regional notes, scope hints) instead of
   * leaking that text into every tool description.
   */
  instructions?: string;
  promptRegistry: PromptRegistry;
  resourceRegistry: ResourceRegistry;
  /** Task message queue for side-channel delivery via tasks/result. */
  taskMessageQueue?: TaskMessageQueue;
  /** Task store for managing task lifecycle (create, status, result). */
  taskStore?: TaskStore;
  /**
   * Human-readable display name forwarded to `new McpServer({ serverInfo })`.
   * Supplements the machine-identifier `name`.
   */
  title?: string;
  /** Tool registry. */
  toolRegistry: ToolRegistry;
  /**
   * Canonical server URL forwarded to `new McpServer({ serverInfo })`.
   * Should match `landing.repoRoot` or `mcpServerHomepage` when set.
   */
  websiteUrl?: string;
}

/**
 * Creates and configures a new instance of the `McpServer`.
 * Registries are provided directly — no DI container resolution.
 *
 * @returns A promise resolving with the configured `McpServer` instance.
 * @throws {McpError} If any resource or tool registration fails.
 */
export async function createMcpServerInstance(deps: McpServerDeps): Promise<McpServer> {
  const context = requestContextService.createRequestContext({
    operation: 'createMcpServerInstance',
  });
  logger.debug('Initializing MCP server instance', context);

  const server = new McpServer(
    {
      name: deps.config.mcpServerName,
      version: deps.config.mcpServerVersion,
      ...(deps.title && { title: deps.title }),
      ...(deps.websiteUrl && { websiteUrl: deps.websiteUrl }),
      ...(deps.description && { description: deps.description }),
      ...(deps.icons && { icons: deps.icons }),
    },
    {
      capabilities: {
        logging: {},
        resources: { listChanged: true },
        tools: { listChanged: true },
        prompts: { listChanged: true },
        // SEP-1686 (spec revision 2025-11-25, GA) — only advertised when the
        // server registers at least one task tool. Clients pinned to 2025-06-18
        // that strict-parse capabilities fail on the unknown key.
        ...(deps.advertiseTasks && {
          tasks: {
            list: {},
            cancel: {},
            requests: {
              tools: { call: {} },
            },
          },
        }),
        ...(deps.extensions && { extensions: deps.extensions }),
      },
      ...(deps.instructions && { instructions: deps.instructions }),
      ...(deps.taskStore && { taskStore: deps.taskStore }),
      ...(deps.taskMessageQueue && { taskMessageQueue: deps.taskMessageQueue }),
    },
  );

  try {
    logger.debug('Registering all MCP capabilities via registries...', context);

    await Promise.all([
      deps.toolRegistry.registerAll(server),
      deps.resourceRegistry.registerAll(server),
      deps.promptRegistry.registerAll(server),
    ]);

    logger.debug('All MCP capabilities registered successfully', context);
  } catch (err) {
    logger.error(
      'Failed to register MCP capabilities',
      err instanceof Error ? err : new Error(String(err)),
      context,
    );
    throw err;
  }

  return server;
}
