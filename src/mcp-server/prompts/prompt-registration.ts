/**
 * @fileoverview Service for registering MCP prompts on a server instance.
 *
 * MCP Prompts Specification:
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/server/prompts | MCP Prompts}
 * @module src/mcp-server/prompts/prompt-registration
 */
import type { GetPromptResult, InputRequiredResult, McpServer } from '@modelcontextprotocol/server';

import { isInputRequiredSignal } from '@/mcp-server/inputRequired.js';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { logger as defaultLogger } from '@/utils/internal/logger.js';
import { measurePromptGeneration } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

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

    // `prompts/list` and `prompts/get` are installed by the SDK from the
    // declared `prompts` capability, so a server with no prompts still answers
    // `prompts/list` with an empty array rather than `-32601`.
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
            // The ZodObject itself, not `.shape`: the raw-shape overload
            // rebuilds a fresh non-strict object (dropping `.strict()` and any
            // object-level refinement), and requiredness is derived from the
            // emitted JSON Schema, so a `.default()`ed argument correctly
            // advertises as optional (#258).
            ...(promptDef.args && {
              argsSchema: promptDef.args,
            }),
          },
          async (args: Record<string, unknown>): Promise<GetPromptResult | InputRequiredResult> => {
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
              // `ctx.requestInput(...)` is protocol control flow, not a failure
              // — `prompts/get` honors `input_required` on the 2026-07-28
              // revision.
              if (isInputRequiredSignal(error)) return error.result;

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
