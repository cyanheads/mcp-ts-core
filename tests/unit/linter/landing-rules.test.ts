/**
 * @fileoverview Tests for landing page lint rules.
 * @module tests/linter/landing-rules.test
 */
import { describe, expect, test } from 'vitest';

import { lintLandingConfig } from '@/linter/rules/landing-rules.js';

describe('lintLandingConfig', () => {
  test('returns no diagnostics for undefined input', () => {
    expect(lintLandingConfig(undefined)).toEqual([]);
  });

  test('returns no diagnostics for a valid full config', () => {
    const diagnostics = lintLandingConfig({
      enabled: true,
      tagline: 'Short and punchy',
      links: [{ href: 'https://example.com', label: 'Docs' }],
      theme: { accent: '#6366f1' },
      repoRoot: 'https://github.com/acme/demo',
      requireAuth: false,
      attribution: true,
    });
    expect(diagnostics).toEqual([]);
  });

  test('errors when landing is not a plain object', () => {
    expect(lintLandingConfig('string')).toEqual([
      expect.objectContaining({ rule: 'landing-shape', severity: 'error' }),
    ]);
    expect(lintLandingConfig([])).toEqual([
      expect.objectContaining({ rule: 'landing-shape', severity: 'error' }),
    ]);
  });

  test('errors when tagline exceeds the length limit', () => {
    const tooLong = 'x'.repeat(121);
    const diagnostics = lintLandingConfig({ tagline: tooLong });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-tagline-length', severity: 'error' }),
    ]);
  });

  test('errors when tagline is not a string', () => {
    expect(lintLandingConfig({ tagline: 42 })).toEqual([
      expect.objectContaining({ rule: 'landing-tagline-type', severity: 'error' }),
    ]);
  });

  test('errors when data URI logo exceeds byte limit', () => {
    // 24KB limit; 50KB base64 payload ~ 37.5KB decoded
    const bigPayload = 'A'.repeat(50_000);
    const bigLogo = `data:image/png;base64,${bigPayload}`;
    const diagnostics = lintLandingConfig({ logo: bigLogo });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-logo-size', severity: 'error' }),
    ]);
  });

  test('accepts a small data URI logo', () => {
    const smallLogo = `data:image/png;base64,${'A'.repeat(100)}`;
    expect(lintLandingConfig({ logo: smallLogo })).toEqual([]);
  });

  test('accepts a same-origin path as logo without byte check', () => {
    expect(lintLandingConfig({ logo: '/static/logo.svg' })).toEqual([]);
  });

  test('warns when links array exceeds max', () => {
    const links = Array.from({ length: 10 }, (_, i) => ({
      href: `https://example.com/${i}`,
      label: `L${i}`,
    }));
    const diagnostics = lintLandingConfig({ links });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-links-count', severity: 'warning' }),
    ]);
  });

  test('errors when link is missing href or label', () => {
    const diagnostics = lintLandingConfig({
      links: [{ href: 'https://example.com' }, { label: 'Missing href' }],
    });
    const rules = diagnostics.map((d) => d.rule);
    expect(rules).toContain('landing-link-label');
    expect(rules).toContain('landing-link-href');
  });

  test('errors when repoRoot has trailing path', () => {
    const diagnostics = lintLandingConfig({
      repoRoot: 'https://github.com/acme/demo/tree/main',
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-repo-root-shape', severity: 'error' }),
    ]);
  });

  test('errors when repoRoot is a non-github URL', () => {
    const diagnostics = lintLandingConfig({ repoRoot: 'https://gitlab.com/a/b' });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-repo-root-shape', severity: 'error' }),
    ]);
  });

  test('errors when theme.accent is not a string', () => {
    const diagnostics = lintLandingConfig({ theme: { accent: 123 } });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-theme-accent', severity: 'error' }),
    ]);
  });

  test('errors when theme is not an object', () => {
    const diagnostics = lintLandingConfig({ theme: 'red' });
    expect(diagnostics).toEqual([
      expect.objectContaining({ rule: 'landing-theme-type', severity: 'error' }),
    ]);
  });

  test.each([
    ['#fff'],
    ['#6366f1'],
    ['#6366f1aa'],
    ['red'],
    ['transparent'],
    ['currentColor'],
    ['rgb(99 102 241)'],
    ['rgba(99, 102, 241, 0.8)'],
    ['hsl(230 84% 67%)'],
    ['oklch(0.64 0.18 278)'],
    ['color-mix(in oklab, red, blue 20%)'],
  ])('accepts %s as a valid theme.accent', (accent) => {
    expect(lintLandingConfig({ theme: { accent } })).toEqual([]);
  });

  test.each([
    ['red; } body { background: url(evil)'],
    ['red } * { color: red'],
    ['red /* injected */'],
    ['red */ x'],
    ['<script>alert(1)</script>'],
    ['red\\00003b'],
    [''],
    ['   '],
    ['x'.repeat(129)],
    ['123'],
  ])('rejects %s as an unsafe theme.accent', (accent) => {
    expect(lintLandingConfig({ theme: { accent } })).toEqual([
      expect.objectContaining({ rule: 'landing-theme-accent-format', severity: 'error' }),
    ]);
  });

  test('accepts a valid connectSnippets override', () => {
    const diagnostics = lintLandingConfig({
      connectSnippets: {
        stdio: '{"mcpServers":{"my-server":{"command":"docker"}}}',
        http: '{"mcpServers":{"my-server":{"type":"http","url":"https://example.com/mcp"}}}',
      },
    });
    expect(diagnostics).toEqual([]);
  });

  test('accepts overrides for codex, cursor, gemini tabs', () => {
    const diagnostics = lintLandingConfig({
      connectSnippets: {
        claude: 'claude mcp add --transport http my-server https://example.com/mcp',
        codex: 'codex mcp add my-server --url https://example.com/mcp',
        cursor: '{"mcpServers":{"my-server":{"url":"https://example.com/mcp"}}}',
        gemini: 'gemini mcp add --transport http my-server https://example.com/mcp',
      },
    });
    expect(diagnostics).toEqual([]);
  });

  test('errors when connectSnippets is not a plain object', () => {
    expect(lintLandingConfig({ connectSnippets: ['a'] })).toEqual([
      expect.objectContaining({ rule: 'landing-connect-snippets-type', severity: 'error' }),
    ]);
    expect(lintLandingConfig({ connectSnippets: 'raw' })).toEqual([
      expect.objectContaining({ rule: 'landing-connect-snippets-type', severity: 'error' }),
    ]);
  });

  test('errors when a connectSnippets value is not a string', () => {
    expect(lintLandingConfig({ connectSnippets: { stdio: 42 } })).toEqual([
      expect.objectContaining({ rule: 'landing-connect-snippets-value', severity: 'error' }),
    ]);
  });

  test('warns on unknown connectSnippets tab id', () => {
    expect(lintLandingConfig({ connectSnippets: { bogus: 'x' } })).toEqual([
      expect.objectContaining({ rule: 'landing-connect-snippets-key', severity: 'warning' }),
    ]);
  });

  test('warns on empty-string connectSnippets value', () => {
    expect(lintLandingConfig({ connectSnippets: { stdio: '' } })).toEqual([
      expect.objectContaining({ rule: 'landing-connect-snippets-empty', severity: 'warning' }),
    ]);
  });
});
