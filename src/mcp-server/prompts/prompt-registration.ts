/**
 * @fileoverview Service for registering MCP prompts on a server instance.
 *
 * MCP Prompts Specification:
 * @see {@link https://modelcontextprotocol.io/specification/2025-06-18/basic/prompts | MCP Prompts}
 * @module src/mcp-server/prompts/prompt-registration
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { logger as defaultLogger } from '@/utils/internal/logger.js';
import { measurePromptGeneration } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

type McpServerWithPromptHandlerInit = {
  setPromptRequestHandlers: () => void;
};

export class PromptRegistry {
  /** Tracks registered prompt names to detect duplicates at startup. */
  private readonly registeredNames = new Set<string>();

  constructor(
    private promptDefs: AnyPromptDefinition[],
    private logger: typeof defaultLogger,
  ) {}

  /**
   * Registers all prompts on the given MCP server.
   */
  async registerAll(server: McpServer): Promise<void> {
    this.registeredNames.clear();

    const context = requestContextService.createRequestContext({
      operation: 'PromptRegistry.registerAll',
    });

    this.logger.debug(`Registering ${this.promptDefs.length} prompt(s)...`, context);

    // The SDK only initializes prompts/list + prompts/get handlers when a
    // prompt is first registered. Initialize them up front so empty servers
    // still expose truthful MCP prompt behavior.
    (server as unknown as McpServerWithPromptHandlerInit).setPromptRequestHandlers();

    for (const promptDef of this.promptDefs) {
      await this.registerPrompt(server, promptDef, context);
    }

    this.logger.debug(`Successfully registered ${this.promptDefs.length} prompts`, context);
  }

  /** Throws at startup if a prompt with the same name was already registered. */
  private assertUniqueName(name: string): void {
    if (this.registeredNames.has(name)) {
      throw new Error(
        `Duplicate prompt name '${name}': a prompt with this name is already registered. ` +
          'Each prompt must have a unique name.',
      );
    }
    this.registeredNames.add(name);
  }

  private async registerPrompt(
    server: McpServer,
    promptDef: AnyPromptDefinition,
    context: ReturnType<typeof requestContextService.createRequestContext>,
  ): Promise<void> {
    this.logger.debug(`Registering prompt: ${promptDef.name}`, context);

    this.assertUniqueName(promptDef.name);

    await ErrorHandler.tryCatch(
      () => {
        server.registerPrompt(
          promptDef.name,
          {
            ...(promptDef.title && { title: promptDef.title }),
            description: promptDef.description,
            ...(promptDef.args && {
              argsSchema: promptDef.args.shape,
            }),
          },
          async (args: Record<string, unknown>) => {
            try {
              const validatedArgs = promptDef.args ? promptDef.args.parse(args) : args;
              const messages = await measurePromptGeneration(
                () =>
                  Promise.resolve(
                    promptDef.generate(validatedArgs as Parameters<typeof promptDef.generate>[0]),
                  ),
                { ...context, promptName: promptDef.name },
                validatedArgs,
              );
              return { messages };
            } catch (error: unknown) {
              const handled = ErrorHandler.handleError(error, {
                operation: `prompt:${promptDef.name}`,
                context,
              });
              throw handled instanceof McpError
                ? handled
                : new McpError(JsonRpcErrorCode.InternalError, handled.message);
            }
          },
        );

        this.logger.debug(`Registered prompt: ${promptDef.name}`, context);
      },
      {
        operation: `RegisteringPrompt_${promptDef.name}`,
        context,
        errorCode: JsonRpcErrorCode.InitializationFailed,
        critical: true,
      },
    );
  }
}
