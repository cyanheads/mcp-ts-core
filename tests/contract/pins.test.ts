/**
 * @fileoverview Keeps `pins/` and the suite in step. Vitest never reports a
 * file snapshot as obsolete, so a pin whose test was renamed or removed would
 * otherwise linger, unread, looking like coverage.
 * @module tests/contract/pins.test
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PINS, PINS_DIR } from './harness.js';

describe('pins directory', () => {
  it('holds exactly the pins the suite writes', () => {
    const onDisk = readdirSync(PINS_DIR).sort();
    if (expect.getState().snapshotState.snapshotUpdateState === 'all') {
      // Under `-u` another file may write a new pin after this read, so only an
      // unlisted file fails here: Vitest never deletes one, in any mode.
      const listed = new Set<string>(PINS);
      expect(onDisk.filter((file) => !listed.has(file))).toEqual([]);
    } else {
      expect(onDisk).toEqual([...PINS].sort());
    }
  });
});
