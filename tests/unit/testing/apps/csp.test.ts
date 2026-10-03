/**
 * @fileoverview Tests for the MCP Apps view CSP builder: the restrictive default, each
 * `_meta.ui.csp` domain list, and rejection of entries that would escape a directive.
 * @module tests/unit/testing/apps/csp.test
 */

import { describe, expect, it } from 'vitest';

import { buildCsp } from '@/testing/apps/csp.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

/** The header as a directive → sources map. */
function directives(csp: string): Record<string, string> {
  return Object.fromEntries(
    csp.split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ');
      return [name, sources.join(' ')];
    }),
  );
}

describe('buildCsp', () => {
  it('applies the restrictive default when the resource declares no csp', () => {
    expect(directives(buildCsp(undefined))).toEqual({
      'default-src': "'none'",
      'script-src': "'self' 'unsafe-inline'",
      'style-src': "'self' 'unsafe-inline'",
      'img-src': "'self' data:",
      'media-src': "'self' data:",
      'connect-src': "'none'",
      'frame-src': "'none'",
      'object-src': "'none'",
      'base-uri': "'self'",
    });
  });

  it('keeps defaults for every list an empty declaration leaves unset', () => {
    expect(directives(buildCsp({}))).toEqual({
      'default-src': "'none'",
      'script-src': "'self' 'unsafe-inline'",
      'style-src': "'self' 'unsafe-inline'",
      'connect-src': "'self'",
      'img-src': "'self' data:",
      'font-src': "'self'",
      'media-src': "'self' data:",
      'frame-src': "'none'",
      'object-src': "'none'",
      'base-uri': "'self'",
    });
  });

  it('adds resourceDomains to script, style, img, font, and media sources', () => {
    const csp = directives(
      buildCsp({ resourceDomains: ['https://cdn.example.test', 'https://assets.example.test'] }),
    );
    const both = 'https://cdn.example.test https://assets.example.test';
    expect(csp['script-src']).toBe(`'self' 'unsafe-inline' ${both}`);
    expect(csp['style-src']).toBe(`'self' 'unsafe-inline' ${both}`);
    expect(csp['img-src']).toBe(`'self' data: ${both}`);
    expect(csp['font-src']).toBe(`'self' ${both}`);
    expect(csp['media-src']).toBe(`'self' data: ${both}`);
    expect(csp['connect-src']).toBe("'self'");
  });

  it('adds connectDomains to connect-src only', () => {
    const csp = directives(buildCsp({ connectDomains: ['https://api.example.test'] }));
    expect(csp['connect-src']).toBe("'self' https://api.example.test");
    expect(csp['script-src']).toBe("'self' 'unsafe-inline'");
  });

  it('replaces the frame-src and base-uri defaults with their declared lists', () => {
    const csp = directives(
      buildCsp({
        frameDomains: ['https://embed.example.test'],
        baseUriDomains: ['https://base.example.test'],
      }),
    );
    expect(csp['frame-src']).toBe('https://embed.example.test');
    expect(csp['base-uri']).toBe('https://base.example.test');
  });

  it("never adds 'unsafe-eval'", () => {
    for (const csp of [
      buildCsp(undefined),
      buildCsp({}),
      buildCsp({
        resourceDomains: ['https://a.example.test'],
        connectDomains: ['https://b.example.test'],
        frameDomains: ['https://c.example.test'],
        baseUriDomains: ['https://d.example.test'],
      }),
    ]) {
      expect(csp).not.toContain('unsafe-eval');
    }
  });

  it.each([
    ['a separator', 'https://a.example.test; script-src *'],
    ['a comma', 'https://a.example.test,https://b.example.test'],
    ['a single quote', "'unsafe-eval'"],
    ['a double quote', '"https://a.example.test"'],
    ['a space', 'https://a.example.test *'],
    ['a newline', 'https://a.example.test\nscript-src *'],
    ['a carriage return', 'https://a.example.test\r'],
    ['a tab', 'https://a.example.test\t*'],
    ['an empty entry', ''],
  ])('rejects an entry holding %s', (_label, entry) => {
    let thrown: unknown;
    try {
      buildCsp({ connectDomains: [entry] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeMcpError(JsonRpcErrorCode.ValidationError);
    expect(thrown).toMatchObject({
      message: expect.stringContaining('_meta.ui.csp.connectDomains'),
      data: { reason: 'invalid_csp_entry', field: 'connectDomains' },
    });
  });

  it('rejects an entry that is not a string, naming the field it sits in', () => {
    expect(() => buildCsp({ frameDomains: [42 as unknown as string] })).toThrow(
      /_meta\.ui\.csp\.frameDomains holds 42/,
    );
  });
});
