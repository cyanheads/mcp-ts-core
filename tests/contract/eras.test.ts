/**
 * @fileoverview Pins what a 2026-07-28 client sees as its difference from a
 * 2025-era one: `server/discover` in full, then for each list, each cacheable
 * read, and each matrix call, the keys only the newer revision carries and any
 * value that diverged. Today the entries match and only the envelope differs,
 * so a divergence between the revisions shows up as new lines in these pins.
 * @module tests/contract/eras.test
 */
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'vitest';

import { CASES, PURPOSE, TEMPLATES } from './fixtures.js';
import {
  expectPin,
  type FixtureSet,
  type KeyDelta,
  LIST_METHODS,
  openLegacySession,
  openModernApp,
  responseDelta,
} from './harness.js';

/** Sends the same requests on both revisions; returns how each 2026-07-28 response differs. */
async function deltas(set: FixtureSet, calls: ReadonlyArray<[string, Record<string, unknown>]>) {
  const legacy = await openLegacySession(set);
  const modern = await openModernApp(set);
  try {
    const out: KeyDelta[] = [];
    for (const [method, params] of calls) {
      out.push(
        responseDelta(await legacy.request(method, params), await modern.request(method, params)),
      );
    }
    return out;
  } finally {
    await legacy.close();
    await modern.close();
  }
}

/** `server/discover` plus each list's delta from 2025-11-25. */
async function surfaceDeltas(set: FixtureSet) {
  const modern = await openModernApp(set);
  const discover = await modern.request('server/discover').finally(() => modern.close());
  const lists = await deltas(
    set,
    LIST_METHODS.map((method) => [method, {}]),
  );
  return {
    'server/discover': discover,
    ...Object.fromEntries(LIST_METHODS.map((method, i) => [method, lists[i]])),
  };
}

const READ_URIS = ['contract://item/1', 'contract://status', 'contract://plain'] as const;

/**
 * Every 2026-07-28 request builds its own server, as `createApp` serves that
 * revision, so these two tests make dozens of full registrations each.
 */
const TIMEOUT = { timeout: 15_000 };

describe('2026-07-28 against 2025-11-25', () => {
  it('pins the difference on each surface and cacheable read', TIMEOUT, async () => {
    const reads = await deltas(
      PURPOSE,
      READ_URIS.map((uri) => ['resources/read', { uri }]),
    );

    await expectPin('eras.2026-07-28.json5', {
      'shipped templates': await surfaceDeltas(TEMPLATES),
      'purpose fixtures': await surfaceDeltas(PURPOSE),
      'resources/read': Object.fromEntries(READ_URIS.map((uri, i) => [uri, reads[i]])),
    });
  });

  it('pins the difference on each matrix call', TIMEOUT, async () => {
    const calls = await deltas(
      PURPOSE,
      CASES.map(([name, , args]) => [
        'tools/call',
        { name, ...(args !== undefined && { arguments: args }) },
      ]),
    );

    // Every call is expected to differ the same way; only an outlier is listed.
    const common = calls[0];
    const outliers = Object.fromEntries(
      CASES.flatMap(([name, label], i) =>
        isDeepStrictEqual(calls[i], common) ? [] : [[`${name}: ${label}`, calls[i]]],
      ),
    );

    await expectPin('eras.calls.2026-07-28.json5', { everyCase: common, except: outliers });
  });
});
