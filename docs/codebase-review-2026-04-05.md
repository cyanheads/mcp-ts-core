# Codebase Review: Enhancement & Feature Opportunities

**Date:** 2026-04-05
**Version reviewed:** 0.2.12
**Scope:** Full framework review — architecture, handlers, storage, services, linter, testing, templates, CI

---

## Overview

Comprehensive review of `@cyanheads/mcp-ts-core` identifying 22 concrete enhancement areas across architecture, DX, observability, testing, and CI. Each item includes the problem, proposed solution, affected files, and estimated effort.

---

## High Priority

### 1. Middleware / Hook System for Tool & Resource Handlers

**Problem:** No way to inject cross-cutting concerns (per-tool rate limiting, input transformation, audit logging, caching) into the handler pipeline without framework changes per feature.

**Proposal:** Add a `middleware` field to `ToolDefinition` and `ResourceDefinition` (or a global `createApp({ middleware: [...] })` option) that composes before/after hooks around handlers.

```ts
export const myTool = tool('my_tool', {
  middleware: [rateLimitMiddleware({ rpm: 60 }), cacheMiddleware({ ttl: 300 })],
  handler: async (input, ctx) => { ... },
});
```

**Files:** `src/mcp-server/tools/utils/toolHandlerFactory.ts`, `src/mcp-server/resources/utils/resourceHandlerFactory.ts`
**Effort:** Medium

---

### 2. Redis / Valkey Storage Provider

**Problem:** 6 storage providers exist (in-memory, filesystem, supabase, cloudflare-kv/r2/d1) but no Redis — the most common production KV store for Node.js.

**Proposal:** Add `src/storage/providers/redis/redisProvider.ts` implementing `IStorageProvider` with `ioredis` as optional peer dep. Support native TTL (`SETEX`), batch ops (`MGET`/`MSET`), cursor-based `SCAN` for `list()`. Config: `STORAGE_PROVIDER_TYPE=redis`, `REDIS_URL`.

**Files:** New provider + `src/storage/core/storageFactory.ts` + `src/config/index.ts`
**Effort:** Medium

---

### 3. Tool Output Streaming

**Problem:** Tool handlers return a single result. For large outputs (file listings, search results), the client blocks until the entire result is serialized.

**Proposal:** Optional `stream` mode where the handler yields partial results via async generator. Framework accumulates `content[]` chunks and streams via SSE (HTTP) or chunked JSON-RPC.

**Files:** `toolHandlerFactory.ts`, `toolDefinition.ts`, HTTP transport
**Effort:** High

---

### 4. Linter Rule Modules Lack Individual Tests

**Problem:** The linter has 10 source files but only `validate.ts` has tests. The 6 rule modules (`name-rules.ts`, `prompt-rules.ts`, `resource-rules.ts`, `schema-rules.ts`, `server-json-rules.ts`, `tool-rules.ts`) are exercised only indirectly.

**Proposal:** Add dedicated unit tests for each rule module with edge cases (empty strings, malformed schemas, boundary conditions).

**Files:** `tests/unit/linter/rules/*.test.ts` (new)
**Effort:** Medium

---

### 5. No GitHub Actions CI Workflows

**Problem:** No `.github/workflows/` for testing, linting, coverage enforcement, or releases. Coverage thresholds (80/75/70) are defined but never enforced. Relies on pre-commit hooks and manual discipline.

**Proposal:** Add CI workflows for: test (unit + integration + fuzz), lint + typecheck, coverage tracking with threshold enforcement, and automated release/publish.

**Files:** `.github/workflows/*.yml` (new)
**Effort:** Medium

---

## Medium Priority

### 6. Graceful HTTP Session Drain on Shutdown

**Problem:** `SessionStore` is in-memory only. On restart, all active sessions are lost with no drain mechanism.

**Proposal:** Add `drain()` to `SessionStore` (stop accepting new sessions, wait for in-flight requests with timeout). Wire into `TransportManager.stop()`. Optionally define `SessionStoreProvider` interface for pluggable backends.

**Files:** `src/mcp-server/transports/http/sessionStore.ts`, `src/mcp-server/transports/manager.ts`
**Effort:** Medium

---

### 7. Declarative Rate Limiting on Tool Definitions

**Problem:** `RateLimiter` exists but is only exposed via `CoreServices`. No declarative rate limit option on definitions.

**Proposal:** Add optional `rateLimit` field:
```ts
export const apiTool = tool('call_api', {
  rateLimit: { rpm: 30, perTenant: true },
  handler: async (input, ctx) => { ... },
});
```
Wire check into `createToolHandler` using existing `RateLimiter`.

**Files:** `toolDefinition.ts`, `toolHandlerFactory.ts`
**Effort:** Low

---

### 8. Auto Empty-String Coercion for Form Clients

**Problem:** Form-based MCP clients (Inspector, web UIs) send empty strings for optional fields. Handlers must guard manually.

**Proposal:** Add automatic coercion in `createToolHandler` (before `def.input.parse(input)`) that converts empty-string values to `undefined` for optional fields.

**Files:** `src/mcp-server/tools/utils/toolHandlerFactory.ts:120`
**Effort:** Low

---

### 9. Worker `ctx.waitUntil` for Background Work

**Problem:** The worker module comment explicitly notes `ctx.waitUntil()` should be wired for background work, but it isn't. Background operations (auto-task tools, telemetry flush) can be killed when the response is sent.

**Proposal:** Pass `ctx.waitUntil` through to task manager and background operations in the Worker handler.

**Files:** `src/core/worker.ts:235-296`
**Effort:** Low

---

### 10. In-Memory Graph Provider Implementation

**Problem:** `GraphService` and `IGraphProvider` exist but no concrete provider ships with the framework — it's an interface-only stub.

**Proposal:** Ship an in-memory graph provider using adjacency lists. Useful for testing and lightweight use cases.

**Files:** `src/services/graph/providers/inMemory/inMemoryGraphProvider.ts` (new)
**Effort:** Medium

---

### 11. Resource Handlers Lack Timeout Enforcement

**Problem:** Unlike tools (auto-task TTL, AbortSignal), resource handlers have no explicit timeout. A slow resource read blocks indefinitely.

**Proposal:** Add optional `timeout` field to `ResourceDefinition` with framework-enforced deadline in `createResourceHandler`.

**Files:** `src/mcp-server/resources/utils/resourceDefinition.ts`, `resourceHandlerFactory.ts`
**Effort:** Low

---

### 12. Template Gaps: No Service/Auth/Task Examples

**Problem:** Scaffolded template includes echo tool/resource/prompt but lacks: service with `ctx.state`, auth-scoped tool, `task: true` tool, `ctx.elicit`/`ctx.sample` usage.

**Proposal:** Expand templates with these patterns.

**Files:** `templates/src/mcp-server/tools/definitions/`, `templates/src/services/`
**Effort:** Medium

---

### 13. Core `context.ts` and `worker.ts` Lack Direct Tests

**Problem:** Only `core/app.ts` has dedicated tests. Context construction, tenant isolation, signal propagation, progress tracking, and Worker env injection are untested directly.

**Proposal:** Add unit tests for `createContext`, `createContextLogger`, `createContextState`, `createContextProgress`, and `createWorkerHandler`.

**Files:** `tests/unit/core/context.test.ts`, `tests/unit/core/worker.test.ts` (new/expand)
**Effort:** Medium

---

## Low Priority

### 14. Extract Duplicated `wrapElicit` / `wrapSample`

**Problem:** These functions are copy-pasted identically in `toolHandlerFactory.ts:59-71` and `resourceHandlerFactory.ts:67-79`.

**Proposal:** Extract to `src/mcp-server/shared/capabilityWrappers.ts`.

**Effort:** Trivial

---

### 15. Add `fatal` / `crit` to ContextLogger

**Problem:** `ContextLogger` exposes 5 levels but the underlying Logger supports 8. Handlers can't signal unrecoverable conditions at the correct severity.

**Proposal:** Add `fatal` and `crit` methods.

**Files:** `src/core/context.ts:34-39`
**Effort:** Trivial

---

### 16. Health Endpoint for HTTP Transport

**Problem:** `getHealthSnapshot()` exists but isn't wired to an HTTP endpoint. No `/healthz` or `/readyz` for container deployments.

**Proposal:** Add routes in `createHttpApp()`.

**Files:** `src/mcp-server/transports/http/httpTransport.ts`
**Effort:** Low

---

### 17. Lint Rule for Missing `format()`

**Problem:** Linter doesn't warn when a tool has `output` but no `format()`. Most clients only read `content[]`, so missing `format()` makes tools blind to LLMs.

**Proposal:** Add warning in `tool-rules.ts`.

**Files:** `src/linter/rules/tool-rules.ts`
**Effort:** Low

---

### 18. `traceId` / `spanId` in MockContext

**Problem:** `MockContextOptions` doesn't allow setting `traceId`/`spanId`. Tests verifying trace correlation can't set these.

**Proposal:** Add optional fields and wire into returned Context.

**Files:** `src/testing/index.ts`
**Effort:** Trivial

---

### 19. Storage `exists()` Method

**Problem:** Checking key existence requires `get()` which fetches and deserializes the full value.

**Proposal:** Add `exists(tenantId, key, context): Promise<boolean>` to `IStorageProvider` and `StorageService`. Most backends can implement more efficiently.

**Files:** `src/storage/core/IStorageProvider.ts`, `StorageService.ts`, all providers
**Effort:** Low

---

### 20. Type-Safe `extensions` via Generics

**Problem:** `extensions` in `CreateAppOptions` is `Record<string, object>` — no type safety.

**Proposal:** Make `CreateAppOptions` generic: `CreateAppOptions<TExt extends Record<string, object>>`.

**Files:** `src/core/app.ts`
**Effort:** Trivial

---

### 21. Formatter Error Diagnostics

**Problem:** Formatter failures produce generic "Output formatting failed" message without surfacing which field/data caused the issue.

**Proposal:** Enrich error with formatter context (tool name, output shape, original error chain).

**Files:** `src/mcp-server/tools/utils/toolHandlerFactory.ts:146-151`
**Effort:** Trivial

---

### 22. OTEL Shutdown Flush Timeout

**Problem:** `shutdownOpenTelemetry()` in `core/app.ts:400-407` silently catches errors but has no timeout — could hang indefinitely if OTEL collector is unreachable.

**Proposal:** Add configurable timeout (default 5s) via `Promise.race` with deadline.

**Files:** `src/core/app.ts`, `src/utils/telemetry/instrumentation.ts`
**Effort:** Low

---

## Summary

| Priority | Count | Key themes |
|:---------|:------|:-----------|
| **High** | 5 | Middleware system, Redis provider, streaming, linter tests, CI |
| **Medium** | 8 | Session drain, rate limits, form coercion, Workers, graph provider, resource timeouts, templates, context tests |
| **Low** | 9 | Code dedup, log levels, health endpoint, lint rules, mock context, storage exists, type safety, error diagnostics, OTEL timeout |
