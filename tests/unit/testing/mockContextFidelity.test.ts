/**
 * @fileoverview Fidelity tests comparing createMockContext() against real createContext().
 * Ensures the mock context used in consumer tests behaves equivalently to the
 * production context. Documents known divergences.
 * @module tests/testing/mockContextFidelity.test
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
import { createMockContext, type MockContextLogger } from '@/testing/index.js';
import type { Logger } from '@/utils/internal/logger.js';
import { createFakeStorage, makeRequestContext } from '../../helpers/index.js';
import { makeServerContext } from '../../helpers/server-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRealContext(overrides: Partial<ContextDeps> = {}) {
  return createContext({
    appContext: makeRequestContext((overrides as any).appContextOverrides),
    defaultTenantId: 'default',
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
    it('should carry neither of the removed elicit/progress fields', () => {
      const real = makeRealContext();
      const mock = createMockContext({ tenantId: 'test' });

      for (const key of ['elicit', 'progress']) {
        expect(real, `real still has ${key}`).not.toHaveProperty(key);
        expect(mock, `mock still has ${key}`).not.toHaveProperty(key);
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
      const realCall = mockLogger.info.mock.lastCall;
      expect(realCall).toBeDefined();
      expect(realCall![1]).toHaveProperty('requestId', real.requestId);

      // Mock ctx.log just stores {level, msg, data} — no requestId injection,
      // so log correlation is not verified by consumer unit tests.
      mock.log.info('test');
      expect((mock.log as MockContextLogger).calls).toEqual([
        { level: 'info', msg: 'test', data: undefined },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Behavioral parity (things that SHOULD match)
  // -----------------------------------------------------------------------

  describe('Behavioral parity', () => {
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
  });
});
