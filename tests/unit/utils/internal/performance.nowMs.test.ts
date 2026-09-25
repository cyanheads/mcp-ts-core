/**
 * @fileoverview `nowMs` delegates to `globalThis.performance.now()`.
 * @module tests/utils/internal/performance.nowMs.test
 */
import { describe, expect, it } from 'vitest';

import { nowMs } from '../../../../src/utils/internal/performance.js';

describe('nowMs', () => {
  it('matches performance.now() within 1ms', () => {
    const t0 = performance.now();
    const t1 = nowMs();
    expect(Math.abs(t1 - t0)).toBeLessThan(1);
  });
});
