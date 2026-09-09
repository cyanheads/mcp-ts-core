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
});
