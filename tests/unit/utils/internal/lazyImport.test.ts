/**
 * @fileoverview Unit tests for the lazyImport utility. Verifies that both
 * successful and failed dynamic imports are cached correctly, preventing
 * repeated import attempts and metric spam for missing peer dependencies.
 * @module tests/unit/utils/internal/lazyImport.test
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/internal/logger.js', () => ({
  logger: {
    warning: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    notice: vi.fn(),
  },
}));

import { lazyImport } from '../../../../src/utils/internal/lazyImport.js';
import { logger } from '../../../../src/utils/internal/logger.js';

describe('lazyImport', () => {
  describe('success path', () => {
    it('returns the imported module', async () => {
      const fakeModule = { parse: vi.fn() };
      const importFn = vi.fn().mockResolvedValue(fakeModule);
      const loader = lazyImport(importFn, 'Install "foo": bun add foo');

      const result = await loader();
      expect(result).toBe(fakeModule);
    });

    it('caches the module — importFn is called exactly once across multiple calls', async () => {
      const fakeModule = { parse: vi.fn() };
      const importFn = vi.fn().mockResolvedValue(fakeModule);
      const loader = lazyImport(importFn, 'Install "foo": bun add foo');

      const r1 = await loader();
      const r2 = await loader();
      const r3 = await loader();

      expect(r1).toBe(fakeModule);
      expect(r2).toBe(fakeModule);
      expect(r3).toBe(fakeModule);
      expect(importFn).toHaveBeenCalledTimes(1);
    });

    it('does not log a warning on success', async () => {
      const importFn = vi.fn().mockResolvedValue({ ok: true });
      const loader = lazyImport(importFn, 'Install "foo": bun add foo');
      const warningMock = vi.mocked(logger.warning);
      warningMock.mockClear();

      await loader();

      expect(warningMock).not.toHaveBeenCalled();
    });
  });

  describe('failure path', () => {
    it('throws ConfigurationError on import failure', async () => {
      const importFn = vi.fn().mockRejectedValue(new Error('Cannot find module'));
      const loader = lazyImport(importFn, 'Install "foo": bun add foo');

      await expect(loader()).rejects.toMatchObject({
        message: expect.stringContaining('Install "foo"'),
      });
    });

    it('logs warning exactly once on failure', async () => {
      const importFn = vi.fn().mockRejectedValue(new Error('Cannot find module'));
      const loader = lazyImport(importFn, 'Install "foo": bun add foo');
      const warningMock = vi.mocked(logger.warning);
      warningMock.mockClear();

      await expect(loader()).rejects.toThrow();
      await expect(loader()).rejects.toThrow();

      expect(warningMock).toHaveBeenCalledTimes(1);
      expect(warningMock).toHaveBeenCalledWith('Install "foo": bun add foo');
    });

    it('subsequent failures throw without going through the importFn again', async () => {
      const importFn = vi.fn().mockRejectedValue(new Error('Cannot find module'));
      const loader = lazyImport(importFn, 'Install "foo": bun add foo');

      // First call — actually attempts the import
      await expect(loader()).rejects.toThrow('Install "foo"');
      expect(importFn).toHaveBeenCalledTimes(1);

      // Subsequent calls — throw from cache, importFn not called again
      await expect(loader()).rejects.toThrow('Install "foo"');
      await expect(loader()).rejects.toThrow('Install "foo"');
      expect(importFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('isolation', () => {
    it('separate lazyImport instances do not share state', async () => {
      const successFn = vi.fn().mockResolvedValue({ name: 'success' });
      const failureFn = vi.fn().mockRejectedValue(new Error('missing'));

      const loaderA = lazyImport(successFn, 'hint A');
      const loaderB = lazyImport(failureFn, 'hint B');

      const resultA = await loaderA();
      expect(resultA).toEqual({ name: 'success' });

      await expect(loaderB()).rejects.toThrow('hint B');

      // A still works after B fails
      const resultA2 = await loaderA();
      expect(resultA2).toEqual({ name: 'success' });
    });
  });
});
