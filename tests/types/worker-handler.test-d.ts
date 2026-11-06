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

  it('declares every injected config variable as an optional string binding', () => {
    const bindings: CloudflareBindings = {
      ENVIRONMENT: 'production',
      LOG_LEVEL: 'info',
      MCP_JWT_EXPECTED_AUDIENCE: 'https://mcp.example.com',
      MCP_JWT_EXPECTED_ISSUER: 'https://issuer.example.com',
      MCP_SERVER_RESOURCE_IDENTIFIER: 'https://mcp.example.com/mcp',
      MCP_HTTP_MAX_BODY_BYTES: '65536',
      MCP_SERVER_NAME: 'my-server',
      LLM_DEFAULT_MODEL: 'model',
      SPEECH_STT_TIMEOUT: '30000',
    };
    void bindings;
    expectTypeOf<CloudflareBindings['MCP_JWT_EXPECTED_AUDIENCE']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<CloudflareBindings['OAUTH_JWKS_TIMEOUT_MS']>().toEqualTypeOf<string | undefined>();
    const empty: CloudflareBindings = {};
    void empty;
  });

  it('declares no binding for a variable that has no effect on a Worker', () => {
    // @ts-expect-error `MCP_HTTP_PORT` is excluded: a Worker binds no listener.
    const listener: CloudflareBindings = { MCP_HTTP_PORT: '3010' };
    // @ts-expect-error `DEV_MCP_AUTH_BYPASS` is excluded: it is a development-only bypass.
    const bypass: CloudflareBindings = { DEV_MCP_AUTH_BYPASS: 'true' };
    void listener;
    void bypass;
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
