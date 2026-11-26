/**
 * @fileoverview Rate-limit hit and capacity-eviction costs at two tracked-key counts.
 * @module tests/benchmarks/micro/rate-limiter.bench
 */
import { describe, expect, test } from 'vitest';
import { config } from '@/config/index.js';
import { logger } from '@/utils/internal/logger.js';
import { RateLimiter } from '@/utils/security/rateLimiter.js';
import { runWorkload } from '../harness/workload.js';

for (const capacity of [100, 10_000]) {
  describe(`rate limiter / ${capacity} tracked keys`, () => {
    for (const kind of ['existing key', 'new key requiring eviction']) {
      test(`${kind} / 100 checks`, async (context) => {
        let limiter: RateLimiter;
        let next = 0;
        await runWorkload(
          context,
          {
            beforeAll: () => {
              next = 0;
              limiter = new RateLimiter(config, logger);
              limiter.configure({
                cleanupInterval: 0,
                maxTrackedKeys: capacity,
                maxRequests: Number.MAX_SAFE_INTEGER,
                windowMs: 3_600_000,
              });
              for (let i = 0; i < capacity; i++) limiter.check(`resident-${i}`);
              expect(limiter.getStatus('resident-0')?.current).toBe(1);
            },
            afterAll: () => {
              try {
                if (kind === 'existing key')
                  expect(limiter.getStatus('resident-0')!.current).toBeGreaterThan(1);
                else expect(limiter.getStatus(`new-${next - 1}`)?.current).toBe(1);
              } finally {
                limiter.dispose();
              }
            },
          },
          () => {
            for (let i = 0; i < 100; i++)
              limiter.check(kind === 'existing key' ? 'resident-0' : `new-${next++}`);
          },
        );
      });
    }
  });
}
