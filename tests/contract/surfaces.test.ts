/**
 * @fileoverview Pins what a 2025-era client reads on connect: the `initialize`
 * result and the four lists, for the shipped templates and the purpose-built
 * fixtures. A client on an older 2025 revision is pinned as its difference
 * from the latest one, which today is the negotiated version alone.
 * @module tests/contract/surfaces.test
 */
import { describe, it } from 'vitest';

import { PURPOSE, TEMPLATES } from './fixtures.js';
import {
  expectPin,
  type FixtureSet,
  type KeyDelta,
  LATEST_2025_REVISION,
  LIST_METHODS,
  openLegacySession,
  type PinName,
  responseDelta,
  type WireResponse,
} from './harness.js';

const OLDER_2025_REVISIONS = ['2025-03-26', '2025-06-18'] as const;

/** `initialize` plus each list, as one 2025-era session receives them. */
async function surfaces(set: FixtureSet, protocolVersion: string) {
  const session = await openLegacySession(set, { protocolVersion });
  try {
    const out: Record<string, WireResponse> = { initialize: session.initialize };
    for (const method of LIST_METHODS) out[method] = await session.request(method);
    return out;
  } finally {
    await session.close();
  }
}

const SETS: Array<[label: string, set: FixtureSet, pin: PinName]> = [
  ['shipped templates', TEMPLATES, 'templates.2025-11-25.json5'],
  ['purpose fixtures', PURPOSE, 'purpose.2025-11-25.json5'],
];

describe('2025-era surfaces', () => {
  it.each(SETS)('pins the %s', async (_label, set, pin) => {
    const latest = await surfaces(set, LATEST_2025_REVISION);
    // Only methods that differ are listed, so an empty entry means identical.
    const older: Record<string, Record<string, KeyDelta>> = {};
    for (const revision of OLDER_2025_REVISIONS) {
      const surface = await surfaces(set, revision);
      older[revision] = Object.fromEntries(
        Object.entries(latest)
          .map(([method, response]) => [
            method,
            responseDelta(response, surface[method] as WireResponse),
          ])
          .filter(([, delta]) => Object.keys(delta as KeyDelta).length > 0),
      );
    }

    await expectPin(pin, { [LATEST_2025_REVISION]: latest, olderRevisions: older });
  });
});
