/**
 * @fileoverview Tests for definition-name lint rules: required-name checks,
 * tool name format validation, and cross-definition duplicate detection.
 * @module tests/unit/linter/name-rules.test
 */

import { describe, expect, it } from 'vitest';

import {
  checkDuplicateNames,
  checkNameRequired,
  checkToolNameFormat,
} from '@/linter/rules/name-rules.js';

// ---------------------------------------------------------------------------
// checkNameRequired
// ---------------------------------------------------------------------------

describe('checkNameRequired', () => {
  it('returns null for a valid non-empty name', () => {
    expect(checkNameRequired('my_tool', 'tool', 'my_tool')).toBeNull();
  });

  it('errors when name is undefined', () => {
    const diagnostic = checkNameRequired(undefined, 'tool', '');
    expect(diagnostic).toMatchObject({
      rule: 'name-required',
      severity: 'error',
      definitionType: 'tool',
    });
  });

  it('errors when name is an empty string', () => {
    expect(checkNameRequired('', 'resource', '')).toMatchObject({ rule: 'name-required' });
  });

  it('errors when name is a non-string type (e.g. a number)', () => {
    expect(checkNameRequired(42, 'prompt', '')).toMatchObject({ rule: 'name-required' });
  });

  it('errors when name is null', () => {
    expect(checkNameRequired(null, 'tool', '')).toMatchObject({ rule: 'name-required' });
  });

  it('falls back to <unnamed> when definitionName is also empty', () => {
    const diagnostic = checkNameRequired(undefined, 'tool', '');
    expect(diagnostic?.definitionName).toBe('<unnamed>');
  });

  it('preserves a truthy definitionName even when name itself is invalid', () => {
    // Through the normal integration path (tool-rules.ts etc.), the `name` var
    // and `definitionName` arg are always the same value, so this combination
    // — an invalid name paired with a non-empty definitionName — only happens
    // via a direct call to the exported function.
    const diagnostic = checkNameRequired(undefined, 'tool', 'fallback-label');
    expect(diagnostic?.definitionName).toBe('fallback-label');
  });

  it('message names the definition type', () => {
    expect(checkNameRequired(undefined, 'prompt', '')?.message).toContain(
      'prompt name is required',
    );
  });
});

// ---------------------------------------------------------------------------
// checkToolNameFormat
// ---------------------------------------------------------------------------

describe('checkToolNameFormat', () => {
  it('returns null for a valid snake_case name', () => {
    expect(checkToolNameFormat('my_tool')).toBeNull();
  });

  it('accepts dots, hyphens, underscores, and digits', () => {
    expect(checkToolNameFormat('my_tool.v2-beta9')).toBeNull();
  });

  it('accepts a single-character name (lower boundary)', () => {
    expect(checkToolNameFormat('a')).toBeNull();
  });

  it('accepts exactly 128 characters (upper boundary)', () => {
    expect(checkToolNameFormat('a'.repeat(128))).toBeNull();
  });

  it('rejects 129 characters (one past the upper boundary)', () => {
    expect(checkToolNameFormat('a'.repeat(129))).toMatchObject({ rule: 'name-format' });
  });

  it('rejects an empty string', () => {
    expect(checkToolNameFormat('')).toMatchObject({ rule: 'name-format' });
  });

  it('rejects names containing spaces', () => {
    expect(checkToolNameFormat('my tool')).toMatchObject({ rule: 'name-format' });
  });

  it('rejects names containing special characters', () => {
    for (const bad of ['my@tool', 'my/tool', 'my!tool', 'my#tool', 'my tool\n']) {
      expect(checkToolNameFormat(bad)).toMatchObject({ rule: 'name-format' });
    }
  });

  it('rejects a name containing only unicode characters', () => {
    expect(checkToolNameFormat('検索ツール')).toMatchObject({ rule: 'name-format' });
  });

  it('message includes the offending name', () => {
    expect(checkToolNameFormat('bad name')?.message).toContain("'bad name'");
  });
});

// ---------------------------------------------------------------------------
// checkDuplicateNames
// ---------------------------------------------------------------------------

describe('checkDuplicateNames', () => {
  it('returns [] for an empty array', () => {
    expect(checkDuplicateNames([], 'tool')).toEqual([]);
  });

  it('returns [] when all names are unique', () => {
    expect(checkDuplicateNames(['a', 'b', 'c'], 'tool')).toEqual([]);
  });

  it('flags exactly one diagnostic for a single duplicate pair', () => {
    const diagnostics = checkDuplicateNames(['a', 'a'], 'resource');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      rule: 'name-unique',
      severity: 'error',
      definitionType: 'resource',
      definitionName: 'a',
    });
  });

  it('flags a duplicate exactly once even with three or more occurrences', () => {
    const diagnostics = checkDuplicateNames(['a', 'a', 'a', 'a'], 'tool');
    expect(diagnostics).toHaveLength(1);
  });

  it('tracks independent duplicate groups without cross-contamination', () => {
    const diagnostics = checkDuplicateNames(['a', 'b', 'a', 'c', 'b', 'b'], 'prompt');
    const names = diagnostics.map((d) => d.definitionName).sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('message names both the definition type and the duplicated name', () => {
    const diagnostics = checkDuplicateNames(['dup', 'dup'], 'tool');
    expect(diagnostics[0]?.message).toContain('dup');
    expect(diagnostics[0]?.message).toContain('tool');
  });
});
