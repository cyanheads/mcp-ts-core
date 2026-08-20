/**
 * @fileoverview Builders for the SDK v2 `ServerContext` handler factories receive.
 *
 * The v1 `RequestHandlerExtra` was a flat bag; v2 nests the per-request surface
 * under `ctx.mcpReq` and moves HTTP details under `ctx.http`. Tests build the
 * shape through {@link makeServerContext} so a future SDK field addition is one
 * edit here rather than one per test file.
 * @module tests/helpers/server-context
 */
import type { AuthInfo, RequestId, ServerContext } from '@modelcontextprotocol/server';
import { vi } from 'vitest';

/** Overrides accepted by {@link makeServerContext}, flattened for convenience. */
export interface ServerContextOverrides {
  authInfo?: AuthInfo;
  droppedInputResponseKeys?: string[];
  /** Multi-round-trip responses carried by a retried request. */
  inputResponses?: Record<string, unknown>;
  /** `notifications/message` sink — `ctx.mcpReq.log`. */
  log?: ServerContext['mcpReq']['log'];
  /** Request `_meta`, envelope keys already lifted out. */
  meta?: Record<string, unknown>;
  method?: string;
  /** Related-notification sink — `ctx.mcpReq.notify`. */
  notify?: ServerContext['mcpReq']['notify'];
  requestId?: RequestId;
  /** Value `ctx.mcpReq.requestState()` resolves to. */
  requestState?: unknown;
  /** Server-to-client request sink — `ctx.mcpReq.send`. */
  send?: ServerContext['mcpReq']['send'];
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * Builds a `ServerContext` with inert defaults for every sink.
 *
 * `notify` defaults to a resolved-promise `vi.fn()` so the request-scoped
 * notifier path (rather than the server-level fallback) is exercised by
 * default — that is what a real request always takes.
 */
export function makeServerContext(overrides: ServerContextOverrides = {}): ServerContext {
  const requestState = overrides.requestState;
  const mcpReq = {
    id: overrides.requestId ?? 'test-request-id',
    method: overrides.method ?? 'tools/call',
    ...(overrides.meta !== undefined && { _meta: overrides.meta }),
    ...(overrides.inputResponses !== undefined && { inputResponses: overrides.inputResponses }),
    ...(overrides.droppedInputResponseKeys !== undefined && {
      droppedInputResponseKeys: overrides.droppedInputResponseKeys,
    }),
    requestState: (<T>(): T | undefined =>
      requestState as T | undefined) as ServerContext['mcpReq']['requestState'],
    signal: overrides.signal ?? new AbortController().signal,
    send: overrides.send ?? (vi.fn(async () => ({})) as unknown as ServerContext['mcpReq']['send']),
    notify: overrides.notify ?? vi.fn(async () => {}),
    log: overrides.log ?? vi.fn(async () => {}),
    elicitInput: vi.fn(async () => ({ action: 'cancel' as const })),
    requestSampling: vi.fn(async () => {
      throw new Error('sampling not stubbed');
    }),
  } as unknown as ServerContext['mcpReq'];

  return {
    mcpReq,
    ...(overrides.sessionId !== undefined && { sessionId: overrides.sessionId }),
    ...(overrides.authInfo !== undefined && { http: { authInfo: overrides.authInfo } }),
  } as ServerContext;
}

/**
 * A `ServerContext` with no `notify` sink — the shape a non-request scope hands
 * a handler, where the factory falls back to the server-level notifiers.
 */
export function makeSenderlessServerContext(overrides: ServerContextOverrides = {}): ServerContext {
  const ctx = makeServerContext(overrides);
  delete (ctx.mcpReq as { notify?: unknown }).notify;
  return ctx;
}
