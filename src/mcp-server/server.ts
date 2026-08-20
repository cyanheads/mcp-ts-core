/**
 * @fileoverview Factory for creating configured MCP server instances.
 * Creates an McpServer with identity, capabilities, and registered
 * tools/resources/prompts from the provided registries.
 *
 * MCP Specification References:
 * - Lifecycle: https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle
 * - Overview (Capabilities): https://modelcontextprotocol.io/specification/2026-07-28/basic/index
 * - Transports: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
 * @module src/mcp-server/server
 */
import {
  type Implementation,
  McpServer,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';

import type { AppConfig } from '@/config/index.js';
import type { PromptRegistry } from '@/mcp-server/prompts/prompt-registration.js';
import type { ResourceRegistry } from '@/mcp-server/resources/resource-registration.js';
import { installResourceSubscriptions } from '@/mcp-server/resources/resourceSubscriptions.js';
import type { ToolRegistry } from '@/mcp-server/tools/tool-registration.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/** Dependencies required to create an MCP server instance. */
export interface McpServerDeps {
  config: AppConfig;
  /**
   * One-line description forwarded to `new McpServer({ serverInfo })`.
   * Explicit option wins over `MCP_SERVER_DESCRIPTION` / `package.json`.
   */
  description?: string;
  /**
   * The protocol era this instance will serve, from the factory's
   * {@link McpRequestContext}. Selects the resource-subscription mechanism —
   * see {@link installResourceSubscriptions}. Defaults to `legacy` for direct
   * callers that construct an instance outside the serving factories.
   */
  era?: 'legacy' | 'modern';
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
        // Declaring `logging` installs the SDK's `logging/setLevel` handler and
        // gates `notifications/message` on the client's chosen level; `ctx.log`
        // mirrors onto that stream.
        logging: {},
        // `subscribe: true` promises resource-specific update notifications
        // in both eras (#354). A 2025 client opts in through
        // `resources/subscribe`, installed below; a 2026 client through
        // `subscriptions/listen`'s `resourceSubscriptions` filter, which the
        // SDK's listen router owns.
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
        prompts: { listChanged: true },
        ...(deps.extensions && {
          extensions: deps.extensions as ServerCapabilities['extensions'],
        }),
      },
      ...(deps.instructions && { instructions: deps.instructions }),
      // Multi-round-trip serving: `ctx.requestInput(...)` returns are fulfilled
      // by the client on 2026-era requests and by the SDK's legacy shim (real
      // `elicitation/create` round trips over the live session) on 2025-era
      // ones, so handlers are written once.
      inputRequired: { legacyShim: true },
    },
  );

  // The `resources/subscribe` registry is a 2025-era mechanism: the method
  // does not exist on 2026-07-28, where the client opts in through
  // `subscriptions/listen` and the SDK filters delivery. Installing it on a
  // modern instance would leave the registry permanently empty and silently
  // drop every `ctx.notifyResourceUpdated(uri)` — the notifiers read `undefined`
  // as "no subscription tracking on this connection" and emit unconditionally.
  const subscriptions =
    (deps.era ?? 'legacy') === 'legacy' ? installResourceSubscriptions(server) : undefined;

  try {
    logger.debug('Registering all MCP capabilities via registries...', context);

    await Promise.all([
      deps.toolRegistry.registerAll(server, subscriptions),
      deps.resourceRegistry.registerAll(server, subscriptions),
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
