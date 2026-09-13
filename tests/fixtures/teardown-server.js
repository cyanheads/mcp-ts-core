#!/usr/bin/env node
/**
 * @fileoverview Teardown-hook fixture. A `setup()`-registered service allocates
 * a ref'd handle the framework cannot see and releases it in `teardown()`, so a
 * black-box test can confirm the hook runs on the signal path and that a
 * shutdown ends without the ceiling firing (#435).
 * @module tests/fixtures/teardown-server
 */

import { createApp } from '@cyanheads/mcp-ts-core';

/** Stands in for a watcher, socket, or poller a server's own service owns. */
let refdHandle;

await createApp({
  name: 'teardown-fixture',
  version: '0.0.0-test',
  setup() {
    refdHandle = setInterval(() => {}, 60_000);
  },
  teardown(core) {
    clearInterval(refdHandle);
    refdHandle = undefined;
    core.logger.info('teardown fixture released its handle.', {
      requestId: 'teardown-fixture',
      timestamp: new Date().toISOString(),
    });
  },
});
