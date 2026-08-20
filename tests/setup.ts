/**
 * @fileoverview Global test setup for Vitest.
 * Configures environment, pre-mocks heavy external modules, and registers
 * custom matchers. Only referenced by `vitest.config.ts` (unit suite) — the
 * integration suite has no setupFiles, so these mocks never apply there.
 * @module tests/setup
 */
import { vi } from 'vitest';

// Register MCP-specific matchers (toBeMcpError, toHaveJsonRpcCode).
import './helpers/matchers.js';

// Ensure test env so logger suppresses noisy warnings.
if (typeof process !== 'undefined' && process.env && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

// Pre-mock heavy external modules imported before individual tests call vi.mock.
// NOTE: vi.mock calls must be at the top level — Vitest hoists them regardless
// of nesting, and nested calls produce warnings (future errors).
//
// If you encounter "getStore is not a function" errors with AsyncLocalStorage,
// ensure poolOptions.forks.isolate = true in vitest.config.ts.
// See: https://github.com/vitest-dev/vitest/issues/5858

// The SDK is no longer globally mocked. v2 collapses the server surface onto a
// single `@modelcontextprotocol/server` entry, so a whole-module stub would also
// replace `createMcpHandler`, `inputRequired`, the error classes, and the wire
// codecs that the framework depends on for real behavior. Constructing a real
// `McpServer` is cheap (no I/O until `connect`); tests that need a stub mock the
// entry locally with `importOriginal` and override only what they assert on.

vi.mock('chrono-node', () => ({
  parseDate: vi.fn(() => null),
  parse: vi.fn(() => []),
}));
