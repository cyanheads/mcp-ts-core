/**
 * @fileoverview Public barrel for the `"."` package entry point.
 * Selectively re-exports only the public API from `app.ts` and related modules,
 * keeping internal types (`ComposedApp`, `composeServices`, `TaskManager`,
 * `DefinitionCounts`, `Database`) out of the consumer-facing surface.
 * @module src/core/index
 */

// ---------------------------------------------------------------------------
// Core app API
// ---------------------------------------------------------------------------

export type {
  ContextOptions,
  CoreServices,
  CreateAppOptions,
  ServerHandle,
} from '@/core/app.js';
export { createApp } from '@/core/app.js';

// ---------------------------------------------------------------------------
// Landing page configuration
// ---------------------------------------------------------------------------

export type { LandingConfig, LandingLink } from '@/core/serverManifest.js';

// ---------------------------------------------------------------------------
// Zod re-export (consumers use the framework's copy, no separate zod dep)
// ---------------------------------------------------------------------------

export { z } from 'zod';

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export type {
  AuthContext,
  Context,
  ContextLogger,
  ContextProgress,
  ContextState,
  HandlerContext,
  ReasonOf,
  SamplingOpts,
  TypedFail,
  TypedRecoveryFor,
} from '@/core/context.js';
export { createFail, createRecoveryFor } from '@/core/context.js';

// ---------------------------------------------------------------------------
// Definition builders & types
// ---------------------------------------------------------------------------

export { APP_RESOURCE_MIME_TYPE, appResource, appTool } from '@/mcp-server/apps/appBuilders.js';
export type {
  AnyPromptDefinition,
  PromptDefinition,
} from '@/mcp-server/prompts/utils/promptDefinition.js';
export { prompt } from '@/mcp-server/prompts/utils/promptDefinition.js';
export type {
  AnyResourceDefinition,
  ResourceDefinition,
} from '@/mcp-server/resources/utils/resourceDefinition.js';
export { resource } from '@/mcp-server/resources/utils/resourceDefinition.js';
/** Union of all accepted tool definition shapes (standard + task). */
export type { AnyToolDef } from '@/mcp-server/tools/tool-registration.js';
export type {
  AnyToolDefinition,
  DisabledMetadata,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
export { disabledTool, tool } from '@/mcp-server/tools/utils/toolDefinition.js';

// ---------------------------------------------------------------------------
// Linter
// ---------------------------------------------------------------------------

export type {
  LintDefinitionType,
  LintDiagnostic,
  LintInput,
  LintReport,
  LintSeverity,
} from '@/linter/types.js';
export { validateDefinitions } from '@/linter/validate.js';

// ---------------------------------------------------------------------------
// SDK type re-exports — saves consumers from depending on @modelcontextprotocol/sdk directly
// ---------------------------------------------------------------------------

export type {
  CallToolResult,
  ContentBlock,
  CreateMessageResult,
  ElicitResult,
  ModelPreferences,
  PromptMessage,
  SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js';
