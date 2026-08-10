/**
 * @fileoverview Tests for the internal log-level alias table shared by the
 * config schema and the Worker entry point.
 * @module tests/unit/config/logLevelAlias.test
 */

import { describe, expect, it } from 'vitest';
import { normalizeLogLevelAlias } from '@/config/logLevelAlias.js';

describe('normalizeLogLevelAlias', () => {
  it.each([
    ['warn', 'warning'],
    ['WARN', 'warning'],
    ['err', 'error'],
    ['information', 'info'],
    ['fatal', 'emerg'],
    ['trace', 'debug'],
    ['silent', 'emerg'],
  ])('resolves %s to %s', (input, expected) => {
    expect(normalizeLogLevelAlias(input)).toBe(expected);
  });

  it('lowercases a canonical level and passes an unknown one through', () => {
    expect(normalizeLogLevelAlias('NOTICE')).toBe('notice');
    expect(normalizeLogLevelAlias('definitely-not-a-level')).toBe('definitely-not-a-level');
  });
});
