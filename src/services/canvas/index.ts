/**
 * @fileoverview Public barrel for the DataCanvas primitive. Servers import
 * from `@cyanheads/mcp-ts-core/canvas` to interact with `core.canvas` —
 * either via tool handlers (acquire → register → query → export) or directly
 * for advanced lifecycle work.
 *
 * The DuckDB provider is lazy-loaded; pulling this barrel does not pull in
 * `@duckdb/node-api` until {@link DataCanvas.acquire} runs against an active
 * canvas configuration.
 *
 * @module src/services/canvas/index
 */

export { CanvasInstance } from './core/CanvasInstance.js';
export {
  type AcquireResult,
  CanvasRegistry,
  type CanvasRegistryOptions,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
} from './core/CanvasRegistry.js';
export { createCanvasService } from './core/canvasFactory.js';
export { DataCanvas } from './core/DataCanvas.js';
export type { IDataCanvasProvider } from './core/IDataCanvasProvider.js';
export { inferSchemaFromRows } from './core/schemaSniffer.js';
export {
  ALLOWED_PLAN_OPERATORS,
  ALLOWED_STATEMENT_TYPES,
  assertNoDeniedFunctions,
  assertReadOnlyQuery,
  assertValidIdentifier,
  CANVAS_IDENTIFIER_REGEX,
  collectDisallowedOperators,
  collectPlanViolations,
  DENIED_TABLE_FUNCTIONS,
  type DuckdbStatementType,
  quoteIdentifier,
  SQL_GATE_REASONS,
  type SqlGateReason,
} from './core/sqlGate.js';
export {
  DuckdbProvider,
  type DuckdbProviderOptions,
} from './providers/duckdb/DuckdbProvider.js';
export {
  type SpilloverFitResult,
  type SpilloverOptions,
  type SpilloverResult,
  type SpilloverSpillResult,
  spillover,
} from './spillover.js';
export type {
  AcquireOptions,
  CanvasObjectKind,
  ColumnSchema,
  ColumnType,
  DescribeOptions,
  ExportFormat,
  ExportOptions,
  ExportResult,
  ExportTarget,
  ImportFromOptions,
  QueryOptions,
  QueryResult,
  RegisterRows,
  RegisterTableOptions,
  RegisterTableResult,
  RegisterViewOptions,
  RegisterViewResult,
  TableInfo,
} from './types.js';
