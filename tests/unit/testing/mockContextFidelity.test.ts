/**
 * @fileoverview Fidelity tests comparing createMockContext() against real createContext().
 * Ensures the mock context used in consumer tests behaves equivalently to the
 * production context. Documents known divergences.
 * @module tests/testing/mockContextFidelity.test
 */

import { describe, expect, it, vi } from 'vitest';
import { McpError } from '@/types-global/errors.js';

// ---------------------------------------------------------------------------
// Mocks (for createContext path) — see context.test.ts for the hoisting note.
// ---------------------------------------------------------------------------

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    crit: vi.fn(),
    emerg: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('@/config/index.js', () => ({
  config: {
    environment: 'testing',
    mcpServerVersion: '1.0.0-test',
    mcpAuthMode: 'none',
  },
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: mockLogger,
  Logger: { getInstance: () => mockLogger },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import type { ContextDeps } from '@/core/context.js';
import { createContext } from '@/core/context.js';
import { createMockContext } from '@/testing/index.js';
import type { Logger } from '@/utils/internal/logger.js';
import { createFakeStorage, makeRequestContext } from '../../helpers/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRealContext(overrides: Partial<ContextDeps> = {}) {
  return createContext({
    appContext: makeRequestContext((overrides as any).appContextOverrides),
    logger: mockLogger as unknown as Logger,
    storage: createFakeStorage() as unknown as ContextDeps['storage'],
    signal: new AbortController().signal,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMockContext fidelity', () => {
  // -----------------------------------------------------------------------
  // Interface shape parity
  // -----------------------------------------------------------------------

  describe('Interface shape', () => {
    it('should have the same set of top-level fields', () => {
      const real = makeRealContext();
      const mock = createMockContext({ tenantId: 'test' });

      const realKeys = new Set(Object.keys(real));
      const mockKeys = new Set(Object.keys(mock));

      // Both should have the same core fields
      for (const key of ['requestId', 'timestamp', 'log', 'state', 'signal']) {
        expect(realKeys.has(key), `real missing ${key}`).toBe(true);
        expect(mockKeys.has(key), `mock missing ${key}`).toBe(true);
      }
    });

    it('should expose the same ContextLogger methods', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      const logMethods = ['debug', 'info', 'notice', 'warning', 'error'] as const;
      for (const method of logMethods) {
        expect(typeof real.log[method], `real.log.${method}`).toBe('function');
        expect(typeof mock.log[method], `mock.log.${method}`).toBe('function');
      }
    });

    it('should expose the same ContextState methods', () => {
      const real = makeRealContext();
      const mock = createMockContext({ tenantId: 'test' });

      const stateMethods = ['get', 'set', 'delete', 'list'] as const;
      for (const method of stateMethods) {
        expect(typeof real.state[method], `real.state.${method}`).toBe('function');
        expect(typeof mock.state[method], `mock.state.${method}`).toBe('function');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Documented divergences
  // -----------------------------------------------------------------------

  describe('Documented divergences', () => {
    it('DIVERGENCE: real defaults tenantId to "default", mock leaves it undefined', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      // Real createContext defaults tenantId to 'default' for stdio mode
      expect(real.tenantId).toBe('default');
      // Mock leaves it undefined when not provided
      expect(mock.tenantId).toBeUndefined();
    });

    it('DIVERGENCE: real state throws McpError, mock throws plain Error when tenantId missing', async () => {
      const mock = createMockContext(); // no tenantId

      // Mock throws plain Error
      try {
        await mock.state.get('key');
        expect.fail('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(McpError);
      }

      // Real with tenantId=undefined defaults to 'default', so it DOESN'T throw.
      // This means the error path diverges: real context never reaches the
      // "tenantId required" guard because of the default.
      const real = makeRealContext();
      // Should NOT throw — tenantId is defaulted
      const result = await real.state.get('nonexistent');
      expect(result).toBeNull();
    });

    it('DIVERGENCE: real logger includes requestId in log calls, mock logger does not', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      // Real ctx.log passes full RequestContext to Logger
      real.log.info('test');
      const realCall = mockLogger.info.mock.calls[0];
      expect(realCall).toBeDefined();
      expect(realCall![1]).toHaveProperty('requestId');

      // Mock ctx.log just stores {level, msg, data} — no requestId injection
      mock.log.info('test');
      // The mock logger is a simple array — it doesn't inject requestId
      // (This is fine for unit tests but means log correlation isn't verified)
    });
  });

  // -----------------------------------------------------------------------
  // Behavioral parity (things that SHOULD match)
  // -----------------------------------------------------------------------

  describe('Behavioral parity', () => {
    it('state get/set/delete should work the same with tenant provided', async () => {
      const real = makeRealContext({
        appContext: {
          requestId: 'r1',
          timestamp: 'ts',
          operation: 'test',
          tenantId: 'tenant-x',
        },
      } as any);
      const mock = createMockContext({ tenantId: 'tenant-x' });

      // Both set + get
      await real.state.set('key1', 'value1');
      await mock.state.set('key1', 'value1');

      expect(await real.state.get('key1')).toBe('value1');
      expect(await mock.state.get('key1')).toBe('value1');

      // Both delete
      await real.state.delete('key1');
      await mock.state.delete('key1');

      expect(await real.state.get('key1')).toBeNull();
      expect(await mock.state.get('key1')).toBeNull();
    });

    it('signal should work the same', () => {
      const controller = new AbortController();
      const real = makeRealContext({ signal: controller.signal });
      const mock = createMockContext({ signal: controller.signal });

      expect(real.signal.aborted).toBe(false);
      expect(mock.signal.aborted).toBe(false);

      controller.abort();

      expect(real.signal.aborted).toBe(true);
      expect(mock.signal.aborted).toBe(true);
    });

    it('elicit should pass through when provided', () => {
      const elicit = vi.fn();

      const real = makeRealContext({
        elicit: elicit as any,
      });
      const mock = createMockContext({
        elicit: elicit as any,
      });

      expect(real.elicit).toBe(elicit);
      expect(mock.elicit).toBe(elicit);
    });

    it('uri should pass through when provided', () => {
      const uri = new URL('scheme://test');
      const real = makeRealContext({ uri });
      const mock = createMockContext({ uri });

      expect(real.uri).toBe(uri);
      expect(mock.uri).toBe(uri);
    });

    it('notifyResourceUpdated should pass through when provided', () => {
      const notifyResourceUpdated = vi.fn();
      const real = makeRealContext({ notifyResourceUpdated });
      const mock = createMockContext({ notifyResourceUpdated });

      expect(real.notifyResourceUpdated).toBe(notifyResourceUpdated);
      expect(mock.notifyResourceUpdated).toBe(notifyResourceUpdated);
    });

    it('notifyResourceListChanged should pass through when provided', () => {
      const notifyResourceListChanged = vi.fn();
      const real = makeRealContext({ notifyResourceListChanged });
      const mock = createMockContext({ notifyResourceListChanged });

      expect(real.notifyResourceListChanged).toBe(notifyResourceListChanged);
      expect(mock.notifyResourceListChanged).toBe(notifyResourceListChanged);
    });

    it('progress should be available when requested', async () => {
      const mockStore = { updateTaskStatus: vi.fn() };
      const real = makeRealContext({
        taskCtx: { store: mockStore as any, taskId: 'task-1' },
      });
      const mock = createMockContext({ progress: true });

      expect(real.progress).toBeDefined();
      expect(mock.progress).toBeDefined();

      // Both should support the same methods
      const progressMethods = ['setTotal', 'increment', 'update'] as const;
      for (const method of progressMethods) {
        expect(typeof real.progress![method]).toBe('function');
        expect(typeof mock.progress![method]).toBe('function');
      }
    });
  });
});
