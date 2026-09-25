/**
 * @fileoverview Unit tests for runtime capability detection.
 * @module tests/utils/internal/runtime.test
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runtimeCaps } from '../../../../src/utils/internal/runtime.js';

describe('Runtime Capabilities', () => {
  it('should detect Node.js environment', () => {
    // This test runs in Node, so should be true
    expect(runtimeCaps.isNode).toBe(true);
    expect(runtimeCaps.hasProcess).toBe(true);
    expect(runtimeCaps.hasBuffer).toBe(true);
  });

  it('should correctly identify not being a worker or browser', () => {
    expect(runtimeCaps.isWorkerLike).toBe(false);
    expect(runtimeCaps.isBrowserLike).toBe(false);
  });

  it('should detect TextEncoder availability', () => {
    expect(runtimeCaps.hasTextEncoder).toBe(true);
  });

  it('should detect performance.now availability', () => {
    expect(runtimeCaps.hasPerformanceNow).toBe(true);
  });
});

describe('isWorkerLike detection under nodejs_compat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns true when navigator.userAgent reports Cloudflare-Workers', async () => {
    // Cloudflare Workers populate `process.versions.node` under `nodejs_compat`,
    // so the legacy `!isNode` gate always evaluated false. Detection now uses
    // the canonical `navigator.userAgent === 'Cloudflare-Workers'`.
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    vi.resetModules();
    const { runtimeCaps: stubbed } = await import('../../../../src/utils/internal/runtime.js');
    expect(stubbed.isWorkerLike).toBe(true);
    expect(stubbed.isNode).toBe(true); // Node-compat globals remain present
  });

  it('falls back to WorkerGlobalScope when navigator is absent', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('WorkerGlobalScope', class {});
    vi.resetModules();
    const { runtimeCaps: stubbed } = await import('../../../../src/utils/internal/runtime.js');
    expect(stubbed.isWorkerLike).toBe(true);
  });
});
