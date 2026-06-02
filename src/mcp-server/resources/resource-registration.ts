/**
 * @fileoverview Encapsulates the registration of all resource definitions with an McpServer.
 * @module src/mcp-server/resources/resource-registration
 */
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AnyResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import {
  createResourceHandler,
  type ResourceHandlerFactoryServices,
  type ResourceHandlerNotifiers,
} from '@/mcp-server/resources/utils/resourceHandlerFactory.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

type McpServerWithResourceHandlerInit = {
  setResourceRequestHandlers: () => void;
};

function hasUriTemplateVariables(uriTemplate: string): boolean {
  return /\{[^}]+\}/.test(uriTemplate);
}

export class ResourceRegistry {
  /** Tracks registered resource names to detect duplicates at startup. */
  private readonly registeredNames = new Set<string>();

  constructor(
    private resourceDefs: AnyResourceDefinition[],
    private services: ResourceHandlerFactoryServices,
  ) {}

  /**
   * Registers all resolved resource definitions with the provided McpServer instance.
   */
  public async registerAll(server: McpServer): Promise<void> {
    this.registeredNames.clear();

    // Per-server notifier closures targeting `server.send*ListChanged()`. Bound
    // once per registerAll() call — never mutated on a shared services object
    // (which would race under concurrent HTTP requests). The resource handler
    // factory prefers request-scoped notifiers (#135) and falls back to these
    // only when a request has no notification sender.
    const notifiers: ResourceHandlerNotifiers = {
      notifyPromptListChanged: () => server.sendPromptListChanged(),
      notifyResourceListChanged: () => server.sendResourceListChanged(),
      notifyResourceUpdated: (uri: string) => server.server.sendResourceUpdated({ uri }),
      notifyToolListChanged: () => server.sendToolListChanged(),
    };

    const context = requestContextService.createRequestContext({
      operation: 'ResourceRegistry.registerAll',
    });

    logger.debug(`Registering ${this.resourceDefs.length} resource(s)...`, context);

    // The SDK only initializes resources/list + resources/read handlers when a
    // resource is first registered. Initialize them up front so empty servers
    // still expose truthful MCP resource behavior.
    (server as unknown as McpServerWithResourceHandlerInit).setResourceRequestHandlers();

    for (const resourceDef of this.resourceDefs) {
      await this.registerResource(server, resourceDef, notifiers);
    }
  }

  /** Throws at startup if a resource with the same name was already registered. */
  private assertUniqueName(name: string): void {
    if (this.registeredNames.has(name)) {
      throw new Error(
        `Duplicate resource name '${name}': a resource with this name is already registered. ` +
          'Each resource must have a unique name.',
      );
    }
    this.registeredNames.add(name);
  }

  private async registerResource(
    server: McpServer,
    def: AnyResourceDefinition,
    notifiers: ResourceHandlerNotifiers,
  ): Promise<void> {
    const resourceName = def.name ?? def.uriTemplate;
    const registrationContext = requestContextService.createRequestContext({
      operation: 'ResourceRegistry.registerResource',
      additionalContext: { resourceName },
    });

    logger.debug(`Registering resource: '${resourceName}'`, registrationContext);

    this.assertUniqueName(resourceName);

    await ErrorHandler.tryCatch(
      () => {
        const handler = createResourceHandler(def, this.services, notifiers);
        const title = def.title ?? resourceName;
        const mimeType = def.mimeType ?? 'application/json';
        const metadata = {
          title,
          description: def.description,
          mimeType,
          ...(def.size != null && { size: def.size }),
          ...(def.examples && { examples: def.examples }),
          ...(def.annotations && { annotations: def.annotations }),
          ...(def._meta && { _meta: def._meta }),
        };

        if (hasUriTemplateVariables(def.uriTemplate)) {
          const template = new ResourceTemplate(def.uriTemplate, {
            list: def.list,
          });

          server.resource(resourceName, template, metadata, handler);
        } else {
          server.resource(resourceName, def.uriTemplate, metadata, (uri, extra) =>
            handler(uri, {}, extra),
          );
        }

        logger.debug(`Resource '${resourceName}' registered successfully.`, registrationContext);
      },
      {
        operation: `RegisteringResource_${resourceName}`,
        context: registrationContext,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      },
    );
  }
}
