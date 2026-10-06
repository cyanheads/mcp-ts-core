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
    expect(readdirSync(PINS_DIR).sort()).toEqual([...PINS].sort());
  });
});
