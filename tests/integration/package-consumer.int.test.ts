/**
 * @fileoverview Published-tarball consumer verification.
 * @module tests/integration/package-consumer.int.test
 */

import { describe, expect, it } from 'vitest';

import { PUBLIC_RUNTIME_EXPORTS } from '../../scripts/public-api-contract.js';
import { verifyPublishedPackage } from '../../scripts/verify-package.js';

describe('published package consumer', () => {
  it('packs, installs, imports, typechecks, and scaffolds without repository fallback', async () => {
    const report = await verifyPublishedPackage();

    expect(report.runtimeSubpaths).toHaveLength(Object.keys(PUBLIC_RUNTIME_EXPORTS).length);
  });
});
