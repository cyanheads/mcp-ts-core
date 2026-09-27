/**
 * @fileoverview Service for registering MCP prompts on a server instance.
 *
 * MCP Prompts Specification:
 * @see {@link https://modelcontextprotocol.io/specification/2026-07-28/server/prompts | MCP Prompts}
 * @module src/mcp-server/prompts/prompt-registration
 */
import type {
  GetPromptResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';

import { handlerParentContext } from '@/mcp-server/handlerContext.js';
import {
  isInputRequiredSignal,
  type RequestStateSealer,
  sealThrown,
} from '@/mcp-server/inputRequired.js';
import type { AnyPromptDefinition } from '@/mcp-server/prompts/utils/promptDefinition.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import type { logger as defaultLogger } from '@/utils/internal/logger.js';
import { measurePromptGeneration } from '@/utils/internal/performance.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

export class PromptRegistry {
  /** Tracks registered prompt names to detect duplicates at startup. */
  private readonly registeredNames = new Set<string>();

  /**
   * @param requestState - The process's `requestState` sealer, present when
   *   `MCP_REQUEST_STATE_KEY` is set; an `input_required` result leaves with
   *   its state sealed, as a tool's and a resource's do.
   */
  constructor(
    private promptDefs: AnyPromptDefinition[],
    private logger: typeof defaultLogger,
    private requestState?: RequestStateSealer,
  ) {}

  /**
   * Registers all prompts on the given MCP server. Registration logs under one
   * context; each `prompts/get` call logs under its own.
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
          async (...params: unknown[]): Promise<GetPromptResult | InputRequiredResult> => {
            // The SDK calls a prompt registered with `argsSchema` as
            // `(args, ctx)` and one without as `(ctx)` alone (#581).
            const [args, serverContext] = (promptDef.args ? params : [undefined, params[0]]) as [
              unknown,
              ServerContext,
            ];
            // Per call, as for tools and resources, not the registration `context`:
            // its `requestId` is the one the call's records carry and its error
            // `data` returns (#576).
            const requestContext = requestContextService.createRequestContext({
              parentContext: handlerParentContext(serverContext),
              operation: 'HandlePromptGet',
              additionalContext: { promptName: promptDef.name },
            });
            try {
              // An argless prompt's `generate` is typed to receive `{}`; its
              // input measures as nothing.
              const validatedArgs = promptDef.args ? promptDef.args.parse(args) : {};
              const messages = await measurePromptGeneration(
                async () => {
                  try {
                    return await promptDef.generate(
                      validatedArgs as Parameters<typeof promptDef.generate>[0],
                    );
                  } catch (error) {
                    // Inside the measurement, as for tools and resources: an
                    // input-required signal leaves with its `requestState`
                    // sealed when a key is configured, so a sealing failure
                    // is a failed call like any other.
                    throw await sealThrown(error, this.requestState, serverContext);
                  }
                },
                { ...requestContext, promptName: promptDef.name },
                promptDef.args ? validatedArgs : undefined,
              );
              return { messages };
            } catch (error: unknown) {
              // `ctx.requestInput(...)` is protocol control flow, not a failure
              // — `prompts/get` honors `input_required` on the 2026-07-28
              // revision.
              if (isInputRequiredSignal(error)) return error.result;

              /**
               * `handleError` writes the call's one `error` record, with the
               * stack and cause chain; the completion record stays at `info`
               * (#582). The client gets the classified code and message, plus
               * only the `data` a thrown `McpError` declared and the call's
               * `requestId` (#576) — the same wire shape as tools and resources.
               */
              const handled = ErrorHandler.handleError(error, {
                operation: `prompt:${promptDef.name}`,
                context: requestContext,
              });
              throw new McpError(
                handled instanceof McpError ? handled.code : JsonRpcErrorCode.InternalError,
                handled.message,
                {
                  ...(error instanceof McpError ? error.data : undefined),
                  requestId: requestContext.requestId,
                },
                { cause: error },
              );
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
