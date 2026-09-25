/**
 * @fileoverview Tests for the startup banner utility.
 * @module tests/utils/internal/startupBanner.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logStartupBanner } from '../../../../src/utils/internal/startupBanner.js';

const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

const restoreIsTTY = () => {
  if (originalIsTTYDescriptor) {
    Object.defineProperty(process.stdout, 'isTTY', originalIsTTYDescriptor);
  } else {
    delete (process.stdout as unknown as Record<string, unknown>).isTTY;
  }
};

describe('logStartupBanner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreIsTTY();
  });

  it('does not log when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logStartupBanner('Should not appear');

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('uses console.error for stdio transport to avoid stdout pollution', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logStartupBanner('STDIO banner', 'stdio');

    expect(errorSpy).toHaveBeenCalledWith('STDIO banner');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('uses console.log for http transport', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logStartupBanner('HTTP banner', 'http');

    expect(logSpy).toHaveBeenCalledWith('HTTP banner');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
