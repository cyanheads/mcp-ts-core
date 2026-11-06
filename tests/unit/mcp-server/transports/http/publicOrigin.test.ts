/**
 * @fileoverview The origin the HTTP transport advertises in emitted links.
 * @module tests/unit/mcp-server/transports/http/publicOrigin.test
 */

import { describe, expect, it } from 'vitest';

import { resolvePublicOrigin } from '@/mcp-server/transports/http/publicOrigin.js';

describe('resolvePublicOrigin', () => {
  it("derives the request's own origin when no public URL is configured", () => {
    expect(resolvePublicOrigin(undefined, 'http://127.0.0.1:3010/mcp?probe=1')).toBe(
      'http://127.0.0.1:3010',
    );
  });

  it('prefers the configured public URL over the request origin', () => {
    expect(resolvePublicOrigin('https://api.example.com', 'http://127.0.0.1:3010/mcp')).toBe(
      'https://api.example.com',
    );
  });

  it('strips a trailing slash so callers can append paths', () => {
    expect(resolvePublicOrigin('https://api.example.com/', 'http://127.0.0.1:3010/mcp')).toBe(
      'https://api.example.com',
    );
  });

  it.each([
    ['https://public.example/prefix', 'https://public.example/prefix'],
    ['https://public.example/prefix/', 'https://public.example/prefix'],
    ['https://public.example/prefix//', 'https://public.example/prefix'],
    ['https://public.example//', 'https://public.example'],
    ['https://trusted.example:8443', 'https://trusted.example:8443'],
  ])('keeps the ASCII public URL %s as %s', (publicUrl, expected) => {
    expect(resolvePublicOrigin(publicUrl, 'http://127.0.0.1:3010/mcp')).toBe(expected);
  });

  /**
   * The result reaches a response header (the 401 challenge's
   * `resource_metadata`), which carries ASCII only, so a configured URL is
   * written in its WHATWG serialization: host punycoded and lowercased, path
   * percent-encoded, a default port dropped.
   */
  it.each([
    ['https://例え.jp', 'https://xn--r8jz45g.jp'],
    ['https://mcp.example.com/p"q', 'https://mcp.example.com/p%22q'],
    ['https://mcp.example.com/服务', 'https://mcp.example.com/%E6%9C%8D%E5%8A%A1'],
    ['https://API.Example.com', 'https://api.example.com'],
    ['https://api.example.com:443', 'https://api.example.com'],
  ])('serializes the configured public URL %s as %s', (publicUrl, expected) => {
    expect(resolvePublicOrigin(publicUrl, 'http://127.0.0.1:3010/mcp')).toBe(expected);
  });
});
