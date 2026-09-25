/**
 * @fileoverview Tests for the `html` tagged-template utility.
 * @module tests/utils/formatting/html.test
 */
import { describe, expect, test } from 'vitest';

import { escapeHtml, html, SafeHtml, unsafeRaw } from '@/utils/formatting/html.js';

describe('escapeHtml', () => {
  test('escapes all five entity characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  test('passes through plain text unchanged', () => {
    expect(escapeHtml('Hello, world.')).toBe('Hello, world.');
  });

  test('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('escapes repeated characters', () => {
    expect(escapeHtml('<<<')).toBe('&lt;&lt;&lt;');
  });

  test('escapes mixed content', () => {
    expect(escapeHtml('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D');
  });
});

describe('html tagged template', () => {
  test('returns a SafeHtml instance', () => {
    const out = html`<p>Hello</p>`;
    expect(out).toBeInstanceOf(SafeHtml);
    expect(out.toString()).toBe('<p>Hello</p>');
  });

  test('escapes string interpolations', () => {
    const userInput = '<script>alert(1)</script>';
    const out = html`<p>${userInput}</p>`;
    expect(out.toString()).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('escapes double quotes in attributes', () => {
    const value = `evil" onclick="alert(1)`;
    const out = html`<a href="${value}">x</a>`;
    expect(out.toString()).toBe('<a href="evil&quot; onclick=&quot;alert(1)">x</a>');
  });

  test('passes through nested SafeHtml without re-escaping', () => {
    const child = html`<b>${'<evil>'}</b>`;
    const out = html`<div>${child}</div>`;
    expect(out.toString()).toBe('<div><b>&lt;evil&gt;</b></div>');
  });

  test('passes through unsafeRaw without escaping', () => {
    const icon = unsafeRaw('<svg></svg>');
    const out = html`<span>${icon}</span>`;
    expect(out.toString()).toBe('<span><svg></svg></span>');
  });

  test('renders arrays of SafeHtml by joining', () => {
    const items = ['<a>', '<b>', '<c>'].map((x) => html`<li>${x}</li>`);
    const out = html`<ul>${items}</ul>`;
    expect(out.toString()).toBe('<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li><li>&lt;c&gt;</li></ul>');
  });

  test('coerces numbers without escaping', () => {
    expect(html`<span>${42}</span>`.toString()).toBe('<span>42</span>');
  });

  test('omits null, undefined, and false', () => {
    const out = html`<p>${null}${undefined}${false}x</p>`;
    expect(out.toString()).toBe('<p>x</p>');
  });

  test('omits true (boolean toggle idiom)', () => {
    const out = html`<p>${true}</p>`;
    expect(out.toString()).toBe('<p></p>');
  });

  test('handles empty interpolation list', () => {
    const out = html`<p>no subs</p>`;
    expect(out.toString()).toBe('<p>no subs</p>');
  });

  test('handles multiple interpolations', () => {
    const a = 'Alice';
    const b = 'Bob';
    const out = html`<p>${a} & ${b}</p>`;
    expect(out.toString()).toBe('<p>Alice & Bob</p>');
  });
});

describe('unsafeRaw', () => {
  test('wraps value without modification', () => {
    const raw = unsafeRaw('<svg><path/></svg>');
    expect(raw).toBeInstanceOf(SafeHtml);
    expect(raw.toString()).toBe('<svg><path/></svg>');
  });
});

describe('safety invariants', () => {
  test('never emits unescaped user string in attribute context', () => {
    const attacks = [
      `"><script>alert(1)</script>`,
      `' onload='alert(1)`,
      `</textarea><script>alert(1)</script>`,
      `javascript:alert(1)`,
      `&lt;script&gt;`, // already-escaped — double-escape is expected
    ];
    for (const attack of attacks) {
      const out = html`<a href="${attack}">x</a>`.toString();
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toContain(`"><`);
    }
  });

  test('nested composition remains safe through many layers', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const card = html`<h3>${evil}</h3>`;
    const section = html`<section>${card}</section>`;
    const page = html`<main>${section}</main>`;
    const out = page.toString();
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});
