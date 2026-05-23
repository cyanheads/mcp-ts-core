/**
 * @fileoverview Unified barrel export for all utility modules.
 * @module utils
 */

// Formatting
export {
  type Alignment,
  type DiffFormat,
  DiffFormatter,
  type DiffFormatterOptions,
  diffFormatter,
  escapeHtml,
  failureEntrySchema,
  type HtmlInterpolation,
  html,
  MarkdownBuilder,
  markdown,
  partialResult,
  partialResultSchema,
  SafeHtml,
  TableFormatter,
  type TableFormatterOptions,
  type TableStyle,
  TreeFormatter,
  type TreeFormatterOptions,
  type TreeNode,
  type TreeStyle,
  tableFormatter,
  treeFormatter,
  unsafeRaw,
} from './formatting/index.js';
// Encoding
export { arrayBufferToBase64, base64ToString, stringToBase64 } from './internal/encoding.js';
// Error handler
export { ErrorHandler } from './internal/error-handler/errorHandler.js';
export type {
  BaseErrorMapping,
  ErrorContext,
  ErrorHandlerOptions,
  ErrorMapping,
} from './internal/error-handler/types.js';
// Logger
export { Logger, logger, type McpLogLevel } from './internal/logger.js';
// Request context
export {
  type AuthContext,
  type CreateRequestContextParams,
  type RequestContext,
  type RequestContextLike,
  requestContextService,
} from './internal/requestContext.js';
// Runtime
export { type RuntimeCapabilities, runtimeCaps } from './internal/runtime.js';
// Token counting
export {
  type ChatMessage,
  countChatTokens,
  countTokens,
  type ModelHeuristics,
} from './metrics/tokenCounter.js';
// Network
export { type FetchWithTimeoutOptions, fetchWithTimeout } from './network/fetchWithTimeout.js';
export {
  type HttpErrorFromResponseOptions,
  httpErrorFromResponse,
  httpStatusToErrorCode,
} from './network/httpError.js';
export { type RetryOptions, withRetry } from './network/retry.js';
// Pagination
export {
  DEFAULT_PAGINATION_CONFIG,
  decodeCursor,
  encodeCursor,
  extractCursor,
  type PaginatedResult,
  type PaginationState,
  paginateArray,
} from './pagination/pagination.js';
// Parsing
export {
  type AddPageOptions,
  Allow,
  CsvParser,
  csvParser,
  type DrawImageOptions,
  type DrawTextOptions,
  dateParser,
  type EmbedImageOptions,
  type ExtractArticleOptions,
  type ExtractArticleResult,
  type ExtractTextOptions,
  type ExtractTextResult,
  type FillFormOptions,
  FrontmatterParser,
  type FrontmatterResult,
  frontmatterParser,
  HtmlExtractor,
  htmlExtractor,
  JsonParser,
  jsonParser,
  type PageRange,
  type PdfMetadata,
  PdfParser,
  parseDateString,
  parseDateStringDetailed,
  pdfParser,
  type SetMetadataOptions,
  thinkBlockRegex,
  XmlParser,
  xmlParser,
  YamlParser,
  yamlParser,
} from './parsing/index.js';
// Scheduling
export { type Job, SchedulerService, schedulerService } from './scheduling/scheduler.js';
// Security
export {
  type EntityPrefixConfig,
  generateRequestContextId,
  generateUUID,
  type HtmlSanitizeConfig,
  type IdGenerationOptions,
  IdGenerator,
  idGenerator,
  type PathSanitizeOptions,
  type RateLimitConfig,
  type RateLimitEntry,
  RateLimiter,
  Sanitization,
  type SanitizedPathInfo,
  type SanitizeStringOptions,
  sanitization,
  sanitizeInputForLogging,
} from './security/index.js';
// Telemetry — MCP attribute keys
export {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_CODE_NAMESPACE,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAMING,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_TOTAL_TOKENS,
  ATTR_MCP_AUTH_FAILURE_REASON,
  ATTR_MCP_AUTH_METHOD,
  ATTR_MCP_AUTH_OUTCOME,
  ATTR_MCP_AUTH_SCOPES,
  ATTR_MCP_AUTH_SUBJECT,
  ATTR_MCP_CLIENT_ID,
  ATTR_MCP_ERROR_CLASSIFIED_CODE,
  ATTR_MCP_GRAPH_DURATION_MS,
  ATTR_MCP_GRAPH_OPERATION,
  ATTR_MCP_GRAPH_SUCCESS,
  ATTR_MCP_RESOURCE_DURATION_MS,
  ATTR_MCP_RESOURCE_ERROR_CODE,
  ATTR_MCP_RESOURCE_MIME_TYPE,
  ATTR_MCP_RESOURCE_SIZE_BYTES,
  ATTR_MCP_RESOURCE_SUCCESS,
  ATTR_MCP_RESOURCE_URI,
  ATTR_MCP_SESSION_EVENT,
  ATTR_MCP_SPEECH_DURATION_MS,
  ATTR_MCP_SPEECH_INPUT_BYTES,
  ATTR_MCP_SPEECH_OPERATION,
  ATTR_MCP_SPEECH_OUTPUT_BYTES,
  ATTR_MCP_SPEECH_PROVIDER,
  ATTR_MCP_SPEECH_SUCCESS,
  ATTR_MCP_STORAGE_DURATION_MS,
  ATTR_MCP_STORAGE_KEY_COUNT,
  ATTR_MCP_STORAGE_OPERATION,
  ATTR_MCP_STORAGE_SUCCESS,
  ATTR_MCP_TASK_STATUS,
  ATTR_MCP_TASK_STORE_TYPE,
  ATTR_MCP_TENANT_ID,
  ATTR_MCP_TOOL_BATCH_FAILED,
  ATTR_MCP_TOOL_BATCH_SUCCEEDED,
  ATTR_MCP_TOOL_DURATION_MS,
  ATTR_MCP_TOOL_ERROR_CATEGORY,
  ATTR_MCP_TOOL_ERROR_CODE,
  ATTR_MCP_TOOL_INPUT_BYTES,
  ATTR_MCP_TOOL_NAME,
  ATTR_MCP_TOOL_OUTPUT_BYTES,
  ATTR_MCP_TOOL_PARTIAL_SUCCESS,
  ATTR_MCP_TOOL_SUCCESS,
} from './telemetry/attributes.js';
// Telemetry — instrumentation
export {
  initializeOpenTelemetry,
  sdk,
  shutdownOpenTelemetry,
} from './telemetry/instrumentation.js';
// Telemetry — metrics
export {
  createCounter,
  createHistogram,
  createUpDownCounter,
  getMeter,
} from './telemetry/metrics.js';
// Telemetry — trace
export {
  buildTraceparent,
  createContextWithParentTrace,
  extractTraceparent,
  injectCurrentContextInto,
  runInContext,
  type TraceparentInfo,
  withSpan,
} from './telemetry/trace.js';
// Type guards
export { isErrorWithCode, isRecord } from './types/index.js';
