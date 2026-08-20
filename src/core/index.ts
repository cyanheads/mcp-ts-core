/**
 * @fileoverview Public barrel for the `"."` package entry point.
 * Selectively re-exports only the public API from `app.ts` and related modules,
 * keeping internal types (`ComposedApp`, `composeServices`,
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
  SupabaseClientHandle,
} from '@/core/app.js';
export { createApp } from '@/core/app.js';

// ---------------------------------------------------------------------------
// Landing page configuration
// ---------------------------------------------------------------------------

export type { LandingConfig, LandingLink } from '@/core/serverManifest.js';

// ---------------------------------------------------------------------------
// Cache hints (MCP 2026-07-28)
// ---------------------------------------------------------------------------

export type { CacheableResultMethod, CacheHints } from '@/mcp-server/cacheHints.js';

// ---------------------------------------------------------------------------
// Zod re-export (consumers use the framework's copy, no separate zod dep)
// ---------------------------------------------------------------------------

export { z } from 'zod';

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export type {
  AuthContext,
  ContentCollect,
  Context,
  ContextInputs,
  ContextLogger,
  ContextState,
  Enrich,
  EnrichHelpers,
  HandlerContext,
  ReasonOf,
  TypedEnrich,
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
/** The accepted tool definition shape. */
export type { AnyToolDef } from '@/mcp-server/tools/tool-registration.js';
export type {
  AnyToolDefinition,
  DisabledMetadata,
  ToolAnnotations,
  ToolDefinition,
} from '@/mcp-server/tools/utils/toolDefinition.js';
export { disabledTool, headerParam, tool } from '@/mcp-server/tools/utils/toolDefinition.js';

// ---------------------------------------------------------------------------
// Multi-round-trip input (MCP 2026-07-28)
// ---------------------------------------------------------------------------

export { InputRequiredSignal, isInputRequiredSignal } from '@/mcp-server/inputRequired.js';

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
// SDK re-exports — saves consumers from depending on @modelcontextprotocol/server
// directly.
// ---------------------------------------------------------------------------

export type {
  CacheHint,
  CacheScope,
  CallToolResult,
  CompleteCallback,
  CompleteResourceTemplateCallback,
  ContentBlock,
  ElicitResult,
  InputRequest,
  InputRequests,
  InputRequiredResult,
  InputRequiredSpec,
  InputResponseView,
  ModelPreferences,
  PromptMessage,
} from '@modelcontextprotocol/server';
// `completable()` wraps prompt args or resource template variables so the SDK
// auto-installs `completion/complete` handling and advertises the `completions`
// capability. `inputRequired` builds the embedded requests a handler passes to
// `ctx.requestInput(...)` (multi-round-trip, MCP 2026-07-28).
export {
  completable,
  inputRequired,
  isCompletable,
} from '@modelcontextprotocol/server';
