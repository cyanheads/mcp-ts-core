/**
 * @fileoverview Tests for the now-deprecated initHighResTimer and loadPerfHooks exports.
 * Both are no-ops under the Node ≥24 / Bun ≥1.3 floors; tests verify they remain
 * callable without error and that nowMs delegates to globalThis.performance.now().
 * @module tests/utils/internal/performance.init.test
 */
import { describe, expect, it } from 'vitest';

import {
  // biome-ignore lint/suspicious/noDeprecatedImports: exercising the deprecated no-op shim is this suite's purpose
  initHighResTimer,
  // biome-ignore lint/suspicious/noDeprecatedImports: exercising the deprecated no-op shim is this suite's purpose
  loadPerfHooks,
  nowMs,
} from '../../../../src/utils/internal/performance.js';

describe('initHighResTimer (deprecated no-op)', () => {
  it('resolves without error when called with no arguments', async () => {
    await expect(initHighResTimer()).resolves.toBeUndefined();
  });

  it('resolves without error when called with a loader argument (ignored)', async () => {
    const neverCalled = async () => ({ performance: { now: () => 0 } });
    await expect(initHighResTimer(neverCalled)).resolves.toBeUndefined();
  });
});

describe('loadPerfHooks (deprecated)', () => {
  it('returns an object with a performance.now function', async () => {
    const mod = await loadPerfHooks();
    expect(typeof mod.performance.now).toBe('function');
  });

  it('delegates to performance.now', async () => {
    const mod = await loadPerfHooks();
    const t0 = performance.now();
    const t1 = mod.performance.now();
    // Both should be close (same monotonic clock, within 10ms of each other)
    expect(Math.abs(t1 - t0)).toBeLessThan(10);
  });
});

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
