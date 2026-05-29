/**
 * @fileoverview MCP-specific OpenTelemetry attribute keys for spans and metrics.
 * Standard OTel semantic conventions (HTTP, cloud, service, etc.) are NOT
 * re-exported here — import those directly from `@opentelemetry/semantic-conventions`
 * if needed. This module only defines attributes used internally by the framework.
 * @module src/utils/telemetry/attributes
 */

// ============================================================================
// Standard OpenTelemetry Code Attributes (actively used)
// ============================================================================

/**
 * Name of the function or method being instrumented.
 * Replaces deprecated `code.function` per upstream OTel semantic conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/general/attributes/
 */
export const ATTR_CODE_FUNCTION_NAME = 'code.function.name';

/** Fully qualified namespace or module containing the function (e.g., `com.example.MyClass`). */
export const ATTR_CODE_NAMESPACE = 'code.namespace';

// ============================================================================
// MCP Tool Execution Attributes
// ============================================================================

/**
 * Registered name of the MCP tool being invoked (e.g., `echo_message`).
 */
export const ATTR_MCP_TOOL_NAME = 'mcp.tool.name';

/** Serialized byte size of the tool's input arguments. */
export const ATTR_MCP_TOOL_INPUT_BYTES = 'mcp.tool.input_bytes';

/** Serialized byte size of the tool's output result. */
export const ATTR_MCP_TOOL_OUTPUT_BYTES = 'mcp.tool.output_bytes';

/** Wall-clock execution duration of the tool handler in milliseconds. */
export const ATTR_MCP_TOOL_DURATION_MS = 'mcp.tool.duration_ms';

/** Whether the tool handler completed successfully (`true`) or with an error (`false`). */
export const ATTR_MCP_TOOL_SUCCESS = 'mcp.tool.success';

/** JSON-RPC error code from the thrown `McpError`, present when `mcp.tool.success` is `false`. */
export const ATTR_MCP_TOOL_ERROR_CODE = 'mcp.tool.error_code';

/** Broad error category: 'upstream' (external API), 'server' (internal bug), or 'client' (bad input). */
export const ATTR_MCP_TOOL_ERROR_CATEGORY = 'mcp.tool.error_category';

/** Whether the tool returned a result containing partial failures (non-empty `failed` array). */
export const ATTR_MCP_TOOL_PARTIAL_SUCCESS = 'mcp.tool.partial_success';

/** Whether the tool populated agent-facing enrichment (`ctx.enrich`) on this call. */
export const ATTR_MCP_TOOL_ENRICHED = 'mcp.tool.enriched';

/** Number of items in the `succeeded` array of a batch tool result. */
export const ATTR_MCP_TOOL_BATCH_SUCCEEDED = 'mcp.tool.batch.succeeded_count';

/** Number of items in the `failed` array of a batch tool result. */
export const ATTR_MCP_TOOL_BATCH_FAILED = 'mcp.tool.batch.failed_count';

// ============================================================================
// MCP Resource Attributes
// ============================================================================

/**
 * Full URI identifying the MCP resource being accessed (e.g., `myscheme://items/123`).
 * Use on spans only — not on metrics, where unbounded cardinality is a concern.
 */
export const ATTR_MCP_RESOURCE_URI = 'mcp.resource.uri';

/** Bounded resource identifier (name or URI template) for metric attributes. */
export const ATTR_MCP_RESOURCE_NAME = 'mcp.resource.name';

/** MIME type of the resource content (e.g., `application/json`, `text/plain`). */
export const ATTR_MCP_RESOURCE_MIME_TYPE = 'mcp.resource.mime_type';

/** Byte size of the resource content returned by the handler. */
export const ATTR_MCP_RESOURCE_SIZE_BYTES = 'mcp.resource.size_bytes';

/** Wall-clock duration of the resource handler in milliseconds. */
export const ATTR_MCP_RESOURCE_DURATION_MS = 'mcp.resource.duration_ms';

/** Whether the resource handler completed successfully. */
export const ATTR_MCP_RESOURCE_SUCCESS = 'mcp.resource.success';

/** JSON-RPC error code from the thrown error, present when `mcp.resource.success` is `false`. */
export const ATTR_MCP_RESOURCE_ERROR_CODE = 'mcp.resource.error_code';

// ============================================================================
// MCP Prompt Attributes
// ============================================================================

/** Registered name of the MCP prompt being generated (e.g., `code_review`). */
export const ATTR_MCP_PROMPT_NAME = 'mcp.prompt.name';

/** Serialized byte size of the prompt's argument payload. */
export const ATTR_MCP_PROMPT_INPUT_BYTES = 'mcp.prompt.input_bytes';

/** Serialized byte size of the generated prompt messages. */
export const ATTR_MCP_PROMPT_OUTPUT_BYTES = 'mcp.prompt.output_bytes';

/** Number of messages returned by the prompt's `generate` function. */
export const ATTR_MCP_PROMPT_MESSAGE_COUNT = 'mcp.prompt.message_count';

/** Wall-clock execution duration of the prompt's `generate` function in milliseconds. */
export const ATTR_MCP_PROMPT_DURATION_MS = 'mcp.prompt.duration_ms';

/** Whether the prompt generate function completed successfully. */
export const ATTR_MCP_PROMPT_SUCCESS = 'mcp.prompt.success';

/** JSON-RPC error code from the thrown error, present when `mcp.prompt.success` is `false`. */
export const ATTR_MCP_PROMPT_ERROR_CODE = 'mcp.prompt.error_code';

/** Broad error category: 'upstream', 'server', or 'client'. */
export const ATTR_MCP_PROMPT_ERROR_CATEGORY = 'mcp.prompt.error_category';

// ============================================================================
// MCP Request Context Attributes
// ============================================================================

/** Tenant identifier from the JWT `tid` claim, used for multi-tenant storage scoping. */
export const ATTR_MCP_TENANT_ID = 'mcp.tenant.id';

/** OAuth client identifier from the JWT `cid` or `client_id` claim. */
export const ATTR_MCP_CLIENT_ID = 'mcp.client.id';

// ============================================================================
// MCP Session Lifecycle Attributes
// ============================================================================

/** Session lifecycle event type: `created`, `terminated`, `rejected`, `stale_cleanup`. */
export const ATTR_MCP_SESSION_EVENT = 'mcp.session.event';

// ============================================================================
// MCP Storage Attributes
// ============================================================================

/** Storage operation name (e.g., `get`, `set`, `delete`, `list`, `getMany`, `setMany`). */
export const ATTR_MCP_STORAGE_OPERATION = 'mcp.storage.operation';

/** Number of keys involved in batch storage operations (getMany, setMany, deleteMany). */
export const ATTR_MCP_STORAGE_KEY_COUNT = 'mcp.storage.key_count';

/** Wall-clock duration of the storage operation in milliseconds. */
export const ATTR_MCP_STORAGE_DURATION_MS = 'mcp.storage.duration_ms';

/** Whether the storage operation completed successfully. */
export const ATTR_MCP_STORAGE_SUCCESS = 'mcp.storage.success';

// ============================================================================
// OpenTelemetry Generative AI Semantic Conventions
// @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
// ============================================================================

/** Name of the GenAI system/provider (e.g., `openrouter`, `openai`, `anthropic`). */
export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';

/** Model name requested in the API call (e.g., `openai/gpt-4o`). */
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';

/** Maximum number of tokens the model can generate. */
export const ATTR_GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';

/** Sampling temperature requested. */
export const ATTR_GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';

/** Top-p (nucleus) sampling parameter. */
export const ATTR_GEN_AI_REQUEST_TOP_P = 'gen_ai.request.top_p';

/** Whether the request is a streaming completion. */
export const ATTR_GEN_AI_REQUEST_STREAMING = 'gen_ai.request.streaming';

/** Model name returned in the API response (may differ from request). */
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';

/** Number of input/prompt tokens consumed. */
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';

/** Number of output/completion tokens generated. */
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

/** Total tokens (input + output). */
export const ATTR_GEN_AI_USAGE_TOTAL_TOKENS = 'gen_ai.usage.total_tokens';

/** Token type dimension: `input` or `output`. */
export const ATTR_GEN_AI_TOKEN_TYPE = 'gen_ai.token.type';

// ============================================================================
// MCP Speech Attributes
// ============================================================================

/** Speech provider name (e.g., `elevenlabs`, `openai-whisper`). */
export const ATTR_MCP_SPEECH_PROVIDER = 'mcp.speech.provider';

/** Speech operation type: `tts` or `stt`. */
export const ATTR_MCP_SPEECH_OPERATION = 'mcp.speech.operation';

/** Wall-clock duration of the speech operation in milliseconds. */
export const ATTR_MCP_SPEECH_DURATION_MS = 'mcp.speech.duration_ms';

/** Whether the speech operation completed successfully. */
export const ATTR_MCP_SPEECH_SUCCESS = 'mcp.speech.success';

/** Input size in bytes (audio bytes for STT, text bytes for TTS). */
export const ATTR_MCP_SPEECH_INPUT_BYTES = 'mcp.speech.input_bytes';

/** Output size in bytes (audio bytes for TTS, text bytes for STT). */
export const ATTR_MCP_SPEECH_OUTPUT_BYTES = 'mcp.speech.output_bytes';

// ============================================================================
// MCP Graph Attributes
// ============================================================================

/** Graph operation name (e.g., `relate`, `unrelate`, `traverse`, `shortestPath`). */
export const ATTR_MCP_GRAPH_OPERATION = 'mcp.graph.operation';

/** Wall-clock duration of the graph operation in milliseconds. */
export const ATTR_MCP_GRAPH_DURATION_MS = 'mcp.graph.duration_ms';

/** Whether the graph operation completed successfully. */
export const ATTR_MCP_GRAPH_SUCCESS = 'mcp.graph.success';

// ============================================================================
// MCP Auth Attributes
// ============================================================================

/** Authentication method used (e.g., `bearer`, `none`). */
export const ATTR_MCP_AUTH_METHOD = 'mcp.auth.method';

/** Authentication outcome: `success`, `failure`, or `missing`. */
export const ATTR_MCP_AUTH_OUTCOME = 'mcp.auth.outcome';

/** Reason for authentication failure (e.g., `expired_token`, `invalid_token`, `missing_header`). */
export const ATTR_MCP_AUTH_FAILURE_REASON = 'mcp.auth.failure_reason';

/** Comma-separated OAuth/JWT scopes associated with the authenticated request. */
export const ATTR_MCP_AUTH_SCOPES = 'mcp.auth.scopes';

/** Authenticated subject identifier from the JWT `sub` claim. */
export const ATTR_MCP_AUTH_SUBJECT = 'mcp.auth.subject';

// ============================================================================
// MCP Task Attributes
// ============================================================================

/** Task status (e.g., `working`, `completed`, `failed`, `cancelled`). */
export const ATTR_MCP_TASK_STATUS = 'mcp.task.status';

/** Task store type: `in-memory` or `storage`. */
export const ATTR_MCP_TASK_STORE_TYPE = 'mcp.task.store_type';

// ============================================================================
// MCP Heartbeat / Connection Attributes
// ============================================================================

/** Transport type for heartbeat and connection metrics: `stdio`, `http`. */
export const ATTR_MCP_CONNECTION_TRANSPORT = 'mcp.connection.transport';

// ============================================================================
// MCP Error Classification Attributes
// ============================================================================

/** Classified JSON-RPC error code from ErrorHandler (e.g., `-32001`, `-32602`). */
export const ATTR_MCP_ERROR_CLASSIFIED_CODE = 'mcp.error.classified_code';
