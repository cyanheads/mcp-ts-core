/**
 * @fileoverview Fidelity tests comparing createMockContext() against real createContext().
 * Ensures the mock context used in consumer tests behaves equivalently to the
 * production context. Documents known divergences.
 * @module tests/testing/mockContextFidelity.test
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
    // The mock context's state runs on a real StorageService, which opens an
    // OTel span per operation and reads the service identity from config.
    openTelemetry: {
      enabled: false,
      serviceName: 'mcp-ts-core-test',
      serviceVersion: '1.0.0-test',
      samplingRatio: 1,
    },
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
import {
  createContextInputs,
  createRequestInput,
  isInputRequiredSignal,
} from '@/mcp-server/inputRequired.js';
import { createMockContext } from '@/testing/index.js';
import type { Logger } from '@/utils/internal/logger.js';
import { createFakeStorage, makeRequestContext } from '../../helpers/index.js';
import { makeServerContext } from '../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRealContext(overrides: Partial<ContextDeps> = {}) {
  return createContext({
    appContext: makeRequestContext((overrides as any).appContextOverrides),
    inputs: createContextInputs(undefined),
    logger: mockLogger as unknown as Logger,
    requestInput: createRequestInput(),
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
      for (const key of [
        'requestId',
        'timestamp',
        'log',
        'state',
        'signal',
        'inputs',
        'requestInput',
        'content',
        'enrich',
        'recoveryFor',
      ]) {
        expect(realKeys.has(key), `real missing ${key}`).toBe(true);
        expect(mockKeys.has(key), `mock missing ${key}`).toBe(true);
      }
    });

    it('should carry neither of the removed elicit/progress fields', () => {
      const real = makeRealContext();
      const mock = createMockContext({ tenantId: 'test' });

      for (const key of ['elicit', 'progress']) {
        expect(real, `real still has ${key}`).not.toHaveProperty(key);
        expect(mock, `mock still has ${key}`).not.toHaveProperty(key);
      }
    });

    it('should expose the same ContextInputs methods', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      for (const method of ['accepted', 'state', 'view'] as const) {
        expect(typeof real.inputs[method], `real.inputs.${method}`).toBe('function');
        expect(typeof mock.inputs[method], `mock.inputs.${method}`).toBe('function');
      }
      expect(Array.isArray(real.inputs.dropped)).toBe(true);
      expect(Array.isArray(mock.inputs.dropped)).toBe(true);
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
    it('both default tenantId to "default" when none is supplied', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      expect(real.tenantId).toBe('default');
      expect(mock.tenantId).toBe('default');
    });

    it('both serve state on the default tenant instead of throwing', async () => {
      const real = makeRealContext();
      const mock = createMockContext();

      await expect(real.state.get('nonexistent')).resolves.toBeNull();
      await expect(mock.state.get('nonexistent')).resolves.toBeNull();
    });

    it('mock state rejects an invalid key with the same McpError the real service throws', async () => {
      const mock = createMockContext();

      await expect(mock.state.set('cache:v1:abc', 'value')).rejects.toBeInstanceOf(McpError);
    });

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

    it('mock ctx.inputs reads a seeded round exactly as the production reader does', () => {
      const inputResponses = {
        confirm: { action: 'accept', content: { ok: true } },
        declined: { action: 'decline' },
        malformed: { action: 'accept', content: { ok: 'yes' } },
      };
      const requestState = { attempt: 2 };
      const schema = z.object({ ok: z.boolean() });

      const real = makeRealContext({
        inputs: createContextInputs(makeServerContext({ inputResponses, requestState }).mcpReq),
      });
      const mock = createMockContext({ inputResponses, requestState });

      // Anchor the comparison: a parity assertion between two `undefined`s
      // would pass even if both readers were broken.
      expect(real.inputs.accepted('confirm', schema)).toEqual({ ok: true });
      expect(real.inputs.view('declined')).toEqual({ kind: 'elicit', action: 'decline' });
      expect(real.inputs.state()).toEqual({ attempt: 2 });

      // accepted(): validated content, and undefined for decline / failed
      // validation / an unasked key — the four cases a handler branches on.
      expect(mock.inputs.accepted('confirm', schema)).toEqual(
        real.inputs.accepted('confirm', schema),
      );
      expect(mock.inputs.accepted('confirm')).toEqual(real.inputs.accepted('confirm'));
      expect(mock.inputs.accepted('declined')).toBe(real.inputs.accepted('declined'));
      expect(mock.inputs.accepted('malformed', schema)).toBe(
        real.inputs.accepted('malformed', schema),
      );
      expect(mock.inputs.accepted('never-asked')).toBe(real.inputs.accepted('never-asked'));

      // view(): the discriminated view, including the missing-key kind.
      expect(mock.inputs.view('confirm')).toEqual(real.inputs.view('confirm'));
      expect(mock.inputs.view('declined')).toEqual(real.inputs.view('declined'));
      expect(mock.inputs.view('never-asked')).toEqual(real.inputs.view('never-asked'));

      // state(): the round's multi-round-trip state.
      expect(mock.inputs.state()).toEqual(real.inputs.state());
    });

    it('both leave ctx.inputs empty on the first round', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      expect(mock.inputs.responses).toBe(real.inputs.responses);
      expect(mock.inputs.dropped).toEqual(real.inputs.dropped);
      expect(mock.inputs.state()).toBe(real.inputs.state());
      expect(mock.inputs.view('anything')).toEqual(real.inputs.view('anything'));
    });

    it('ctx.requestInput throws the same input_required signal on both', () => {
      const real = makeRealContext();
      const mock = createMockContext();

      const capture = (fn: () => never): unknown => {
        try {
          fn();
        } catch (error) {
          return error;
        }
        throw new Error('requestInput returned instead of throwing');
      };

      const realThrown = capture(() => real.requestInput({ requestState: 'round-1' }));
      const mockThrown = capture(() => mock.requestInput({ requestState: 'round-1' }));

      expect(isInputRequiredSignal(realThrown)).toBe(true);
      expect(isInputRequiredSignal(mockThrown)).toBe(true);
      expect((mockThrown as { result: unknown }).result).toEqual(
        (realThrown as { result: unknown }).result,
      );
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
  });
});
