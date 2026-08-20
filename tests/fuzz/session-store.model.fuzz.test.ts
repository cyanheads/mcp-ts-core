/**
 * @fileoverview Model-based lifecycle coverage for the HTTP session registry.
 *
 * Drives generated `register` / `getConnection` / `isValidForIdentity` /
 * `terminate` sequences against a reference model and asserts the store's
 * standing invariants after every step: identity binding is never bypassed, a
 * terminated session is unreachable, capacity is never exceeded, and each
 * session's connection is closed exactly once.
 * @module tests/fuzz/session-store.model.fuzz.test
 */

import fc, { type AsyncCommand } from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  type SessionConnection,
  type SessionIdentity,
  SessionStore,
} from '@/mcp-server/transports/http/sessionStore.js';
import { JsonRpcErrorCode, type McpError } from '@/types-global/errors.js';

/** Concurrent-session cap the modelled store runs under, low enough to hit. */
const MAX_SESSIONS = 2;

/** Slot index → the 64-hex session ID the store is keyed by. */
const SESSION_IDS = [0, 1, 2, 3].map((slot) => String(slot).repeat(64));

/** Identity pool; index 0 is the unauthenticated caller. */
const IDENTITIES: (SessionIdentity | undefined)[] = [
  undefined,
  { tenantId: 'tenant-a', clientId: 'client-a', subject: 'subject-a' },
  { tenantId: 'tenant-b', clientId: 'client-b', subject: 'subject-b' },
];

/**
 * The protocol pair a session holds, reduced to what the store touches: a
 * `close()` on each half, counted so a double close is visible.
 */
interface FakeConnection extends SessionConnection {
  closes: { server: number; transport: number };
}

function fakeConnection(): FakeConnection {
  const closes = { server: 0, transport: 0 };
  return {
    closes,
    server: {
      close: vi.fn(async () => {
        closes.server += 1;
      }),
    },
    transport: {
      close: vi.fn(async () => {
        closes.transport += 1;
      }),
    },
  } as unknown as FakeConnection;
}

/** Reference state for one live session. */
interface ModelSession {
  /** Identity snapshot the session is bound to, if any has been bound yet. */
  identity: SessionIdentity | undefined;
}

interface SessionModel {
  sessions: Map<number, ModelSession>;
}

interface SessionReal {
  /** Every connection ever handed to `register`, by slot. */
  connections: Map<number, FakeConnection>;
  store: SessionStore;
}

function sameIdentity(a: SessionIdentity | undefined, b: SessionIdentity | undefined): boolean {
  return a?.tenantId === b?.tenantId && a?.clientId === b?.clientId && a?.subject === b?.subject;
}

/**
 * The reference answer for `isValidForIdentity`, mirroring the store's
 * late-binding rule: a session created unauthenticated adopts the first
 * identity that presents one, and is bound to it from then on.
 */
function expectedValidity(session: ModelSession, identity: SessionIdentity | undefined): boolean {
  if (!session.identity) {
    if (identity) session.identity = identity;
    return true;
  }
  if (!identity) return false;
  return sameIdentity(session.identity, identity);
}

/** Capacity is a standing invariant, not a per-command one — assert it everywhere. */
function assertCapacity(model: SessionModel, real: SessionReal): void {
  expect(real.store.getSessionCount()).toBe(model.sessions.size);
  expect(real.store.getSessionCount()).toBeLessThanOrEqual(MAX_SESSIONS);
}

class RegisterCommand implements AsyncCommand<SessionModel, SessionReal> {
  constructor(
    private readonly slot: number,
    private readonly identityIndex: number,
  ) {}

  check(model: Readonly<SessionModel>): boolean {
    return !model.sessions.has(this.slot);
  }

  async run(model: SessionModel, real: SessionReal): Promise<void> {
    const identity = IDENTITIES[this.identityIndex];
    const connection = fakeConnection();
    const atCapacity = model.sessions.size >= MAX_SESSIONS;

    try {
      real.store.register(SESSION_IDS[this.slot]!, connection, identity);
      expect(atCapacity).toBe(false);
      model.sessions.set(this.slot, { identity });
      real.connections.set(this.slot, connection);
      expect(real.store.getConnection(SESSION_IDS[this.slot]!)).toBe(connection);
    } catch (error) {
      // The only legal rejection is the capacity gate; a rejected registration
      // must leave neither a session nor a half-closed connection behind.
      expect(atCapacity).toBe(true);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(connection.closes).toEqual({ server: 0, transport: 0 });
    }
    assertCapacity(model, real);
  }

  toString(): string {
    return `register(slot=${this.slot}, identity=${this.identityIndex})`;
  }
}

class ValidateCommand implements AsyncCommand<SessionModel, SessionReal> {
  constructor(
    private readonly slot: number,
    private readonly identityIndex: number,
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: SessionModel, real: SessionReal): Promise<void> {
    const identity = IDENTITIES[this.identityIndex];
    const session = model.sessions.get(this.slot);
    const expected = session ? expectedValidity(session, identity) : false;

    expect(real.store.isValidForIdentity(SESSION_IDS[this.slot]!, identity)).toBe(expected);
    assertCapacity(model, real);
  }

  toString(): string {
    return `isValidForIdentity(slot=${this.slot}, identity=${this.identityIndex})`;
  }
}

class GetConnectionCommand implements AsyncCommand<SessionModel, SessionReal> {
  constructor(private readonly slot: number) {}

  check(): boolean {
    return true;
  }

  async run(model: SessionModel, real: SessionReal): Promise<void> {
    const connection = real.store.getConnection(SESSION_IDS[this.slot]!);
    if (model.sessions.has(this.slot)) {
      expect(connection).toBe(real.connections.get(this.slot));
    } else {
      expect(connection).toBeUndefined();
    }
    assertCapacity(model, real);
  }

  toString(): string {
    return `getConnection(slot=${this.slot})`;
  }
}

class TerminateCommand implements AsyncCommand<SessionModel, SessionReal> {
  constructor(private readonly slot: number) {}

  check(): boolean {
    return true;
  }

  async run(model: SessionModel, real: SessionReal): Promise<void> {
    const sessionId = SESSION_IDS[this.slot]!;
    const existed = model.sessions.delete(this.slot);
    const connection = real.connections.get(this.slot);

    await real.store.terminate(sessionId);
    // Idempotent: the SDK transport's DELETE path terminates a session the
    // request handler already removed.
    await real.store.terminate(sessionId);

    if (existed) expect(connection?.closes).toEqual({ server: 1, transport: 1 });

    // A terminated session is unreachable by every accessor, for every identity.
    expect(real.store.getConnection(sessionId)).toBeUndefined();
    for (const identity of IDENTITIES) {
      expect(real.store.isValidForIdentity(sessionId, identity)).toBe(false);
    }
    assertCapacity(model, real);
  }

  toString(): string {
    return `terminate(slot=${this.slot})`;
  }
}

const slotArbitrary = fc.integer({ min: 0, max: SESSION_IDS.length - 1 });
const identityArbitrary = fc.integer({ min: 0, max: IDENTITIES.length - 1 });

const commandArbitraries = [
  fc
    .record({ slot: slotArbitrary, identityIndex: identityArbitrary })
    .map(({ slot, identityIndex }) => new RegisterCommand(slot, identityIndex)),
  fc
    .record({ slot: slotArbitrary, identityIndex: identityArbitrary })
    .map(({ slot, identityIndex }) => new ValidateCommand(slot, identityIndex)),
  slotArbitrary.map((slot) => new GetConnectionCommand(slot)),
  slotArbitrary.map((slot) => new TerminateCommand(slot)),
];

describe('SessionStore model-based session lifecycle', () => {
  it('preserves identity binding, reachability, and capacity for generated command sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(commandArbitraries, { maxCommands: 80, size: 'max' }),
        async (commands) => {
          let real: SessionReal | undefined;
          try {
            await fc.asyncModelRun(() => {
              real = { connections: new Map(), store: new SessionStore(30_000, MAX_SESSIONS) };
              return { model: { sessions: new Map() }, real };
            }, commands);
          } finally {
            await real?.store.destroy();
          }

          // Every connection the store ever accepted is closed exactly once —
          // whether by an explicit terminate() or by the final destroy().
          for (const connection of real?.connections.values() ?? []) {
            expect(connection.closes).toEqual({ server: 1, transport: 1 });
          }
        },
      ),
      { numRuns: 100, seed: 20_260_809 },
    );
  });
});
