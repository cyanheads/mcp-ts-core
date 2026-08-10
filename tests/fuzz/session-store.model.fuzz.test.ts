/**
 * @fileoverview Model-based lifecycle coverage for HTTP session cancellation routing.
 * @module tests/fuzz/session-store.model.fuzz.test
 */

import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import fc, { type Command } from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SessionStore } from '@/mcp-server/transports/http/sessionStore.js';

const SESSION_ID = 'a'.repeat(64);

interface ModelRegistration {
  aborted: boolean;
  active: boolean;
  requestId: RequestId;
}

interface SessionModel {
  registrations: Map<number, ModelRegistration>;
  sessionExists: boolean;
}

interface RealRegistration {
  signal: AbortSignal;
  unregister(): void;
}

interface SessionReal {
  registrations: Map<number, RealRegistration>;
  store: SessionStore;
}

class RegisterCommand implements Command<SessionModel, SessionReal> {
  constructor(
    private readonly slot: number,
    private readonly requestId: RequestId,
  ) {}

  check(model: Readonly<SessionModel>): boolean {
    return model.sessionExists && model.registrations.get(this.slot)?.active !== true;
  }

  run(model: SessionModel, real: SessionReal): void {
    const registration = real.store
      .createProtocolSessionHooks(SESSION_ID)
      ?.registerRequest?.(this.requestId);
    expect(registration).toBeDefined();

    model.registrations.set(this.slot, {
      active: true,
      aborted: false,
      requestId: this.requestId,
    });
    real.registrations.set(this.slot, registration!);
    expect(registration!.signal.aborted).toBe(false);
  }

  toString(): string {
    return `register(slot=${this.slot}, id=${typeof this.requestId}:${String(this.requestId)})`;
  }
}

class UnregisterCommand implements Command<SessionModel, SessionReal> {
  constructor(private readonly slot: number) {}

  check(model: Readonly<SessionModel>): boolean {
    return model.registrations.get(this.slot)?.active === true;
  }

  run(model: SessionModel, real: SessionReal): void {
    const expected = model.registrations.get(this.slot)!;
    const registration = real.registrations.get(this.slot)!;
    registration.unregister();
    registration.unregister();
    expected.active = false;
    expect(registration.signal.aborted).toBe(expected.aborted);
  }

  toString(): string {
    return `unregister(slot=${this.slot})`;
  }
}

class CancelCommand implements Command<SessionModel, SessionReal> {
  constructor(private readonly requestId: RequestId) {}

  check(): boolean {
    return true;
  }

  run(model: SessionModel, real: SessionReal): void {
    const matching = [...model.registrations.entries()].filter(
      ([, registration]) => registration.active && registration.requestId === this.requestId,
    );

    expect(real.store.cancelRequest(SESSION_ID, this.requestId, 'model cancellation')).toBe(
      matching.length > 0,
    );
    for (const [slot, expected] of matching) {
      expected.aborted = true;
      expect(real.registrations.get(slot)?.signal).toMatchObject({
        aborted: true,
        reason: expect.objectContaining({ name: 'AbortError', message: 'model cancellation' }),
      });
    }
  }

  toString(): string {
    return `cancel(id=${typeof this.requestId}:${String(this.requestId)})`;
  }
}

class TerminateCommand implements Command<SessionModel, SessionReal> {
  check(model: Readonly<SessionModel>): boolean {
    return model.sessionExists;
  }

  run(model: SessionModel, real: SessionReal): void {
    real.store.terminate(SESSION_ID);
    model.sessionExists = false;
    for (const [slot, expected] of model.registrations) {
      if (!expected.active) continue;
      expected.active = false;
      expected.aborted = true;
      expect(real.registrations.get(slot)?.signal.aborted).toBe(true);
    }
    expect(real.store.createProtocolSessionHooks(SESSION_ID)).toBeUndefined();
  }

  toString(): string {
    return 'terminate()';
  }
}

class RecreateCommand implements Command<SessionModel, SessionReal> {
  check(model: Readonly<SessionModel>): boolean {
    return !model.sessionExists;
  }

  run(model: SessionModel, real: SessionReal): void {
    real.store.getOrCreate(SESSION_ID);
    model.sessionExists = true;
    expect(real.store.createProtocolSessionHooks(SESSION_ID)).toBeDefined();
  }

  toString(): string {
    return 'recreate()';
  }
}

const requestIdArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }).map(String),
);

const commandArbitraries = [
  fc
    .record({ slot: fc.integer({ min: 0, max: 7 }), requestId: requestIdArbitrary })
    .map(({ slot, requestId }) => new RegisterCommand(slot, requestId)),
  fc.integer({ min: 0, max: 7 }).map((slot) => new UnregisterCommand(slot)),
  requestIdArbitrary.map((requestId) => new CancelCommand(requestId)),
  fc.constant(new TerminateCommand()),
  fc.constant(new RecreateCommand()),
];

describe('SessionStore model-based cancellation lifecycle', () => {
  it('preserves typed-ID isolation and lifecycle invariants for generated command sequences', () => {
    fc.assert(
      fc.property(fc.commands(commandArbitraries, { maxCommands: 80 }), (commands) => {
        let real: SessionReal | undefined;
        try {
          fc.modelRun(() => {
            const store = new SessionStore(30_000, 2);
            store.getOrCreate(SESSION_ID);
            real = { registrations: new Map(), store };
            return {
              model: { registrations: new Map(), sessionExists: true },
              real,
            };
          }, commands);
        } finally {
          real?.store.destroy();
        }
      }),
      { numRuns: 100, seed: 20260809 },
    );
  });
});
