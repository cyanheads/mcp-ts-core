/** @fileoverview Cursor keys must be generated at request time and reused for the isolate lifetime. */
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:crypto');
  vi.resetModules();
});

it('imports without randomness, then reuses one key across signing and verification', async () => {
  vi.resetModules();
  let requestActive = false;
  const actual = await import('node:crypto');
  const randomBytes = vi.fn((size: number) => {
    if (!requestActive) throw new Error('Randomness outside request context');
    return actual.randomBytes(size);
  });
  vi.doMock('node:crypto', () => ({ ...actual, randomBytes }));
  // #406: eager key generation fails here, just as it does during Workerd startup.
  const { encodeCursor, decodeCursor } = await import('@/storage/core/storageValidation.js');
  expect(randomBytes).not.toHaveBeenCalled();
  requestActive = true;
  const first = encodeCursor('key-1', 'tenant-a');
  const second = encodeCursor('key-2', 'tenant-a');
  const context = { requestId: 'cursor-lifecycle', timestamp: '2026-01-01T00:00:00.000Z' };
  expect(decodeCursor(first, 'tenant-a', context)).toBe('key-1');
  expect(decodeCursor(second, 'tenant-a', context)).toBe('key-2');
  expect(encodeCursor('key-1', 'tenant-a')).toBe(first);
  expect(() => decodeCursor(first, 'tenant-b', context)).toThrow('tenant ID mismatch');
  expect(() =>
    decodeCursor(`${first.split('.')[0]}.${second.split('.')[1]}`, 'tenant-a', context),
  ).toThrow('signature verification failed');
  expect(randomBytes).toHaveBeenCalledExactlyOnceWith(32);
});
