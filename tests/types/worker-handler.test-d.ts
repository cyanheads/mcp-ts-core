/**
 * @fileoverview Typecheck coverage for the Cloudflare Worker entry's public
 * types: `CloudflareBindings` stays closed, so a server names its own bindings
 * by extending it, and `createWorkerHandler` refuses the `teardown` hook a
 * Worker has no lifecycle to run.
 * @module tests/types/worker-handler.test-d
 */

import { describe, expectTypeOf, it } from 'vitest';

import { type CloudflareBindings, createWorkerHandler } from '@/core/worker.js';

describe('CloudflareBindings', () => {
  it('has no index signature, so an undeclared binding is a compile error', () => {
    // @ts-expect-error `MY_API_KEY` is not a core binding — servers extend the interface.
    const bindings: CloudflareBindings = { MY_API_KEY: 'value' };
    void bindings;
  });

  it('accepts a server binding once an extending interface declares it', () => {
    interface ServerBindings extends CloudflareBindings {
      MY_API_KEY: string;
    }
    expectTypeOf<ServerBindings>().toMatchTypeOf<CloudflareBindings>();
    expectTypeOf<ServerBindings['MY_API_KEY']>().toEqualTypeOf<string>();
  });
});

describe('createWorkerHandler', () => {
  it('rejects a teardown hook, which an evicted isolate would never run', () => {
    createWorkerHandler({
      // @ts-expect-error Workers have no shutdown lifecycle; `teardown` is omitted from the options.
      teardown() {},
    });
  });

  it('returns the Workers export shape', () => {
    const handler = createWorkerHandler();
    expectTypeOf(handler.fetch).toBeFunction();
    expectTypeOf(handler.scheduled).toBeFunction();
  });
});
