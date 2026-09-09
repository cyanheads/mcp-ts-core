/**
 * @fileoverview `nowMs` delegates to `globalThis.performance.now()`.
 * @module tests/utils/internal/performance.nowMs.test
 */
import { describe, expect, it } from 'vitest';

import { nowMs } from '../../../../src/utils/internal/performance.js';

describe('nowMs', () => {
  it('returns a positive number', () => {
    expect(nowMs()).toBeGreaterThan(0);
  });

  it('is monotonically non-decreasing', () => {
    const t0 = nowMs();
    const t1 = nowMs();
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it('matches performance.now() within 1ms', () => {
    const t0 = performance.now();
    const t1 = nowMs();
    expect(Math.abs(t1 - t0)).toBeLessThan(1);
  });
});
