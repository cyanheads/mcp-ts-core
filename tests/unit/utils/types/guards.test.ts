/**
 * @fileoverview Tests for type guard utilities
 * @module tests/utils/types/guards
 */

import { describe, expect, it } from 'vitest';
import {
  getProperty,
  hasProperty,
  isAggregateError,
  isErrorWithCode,
  isObject,
  isRecord,
} from '@/utils/types/guards.js';

describe('Type Guards', () => {
  describe('isObject', () => {
    it('should return true for plain objects', () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ a: 1 })).toBe(true);
      expect(isObject(new Date())).toBe(true);
    });

    it('should return false for null', () => {
      expect(isObject(null)).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isObject([])).toBe(false);
      expect(isObject([1, 2, 3])).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(isObject('string')).toBe(false);
      expect(isObject(123)).toBe(false);
      expect(isObject(true)).toBe(false);
      expect(isObject(undefined)).toBe(false);
      expect(isObject(Symbol('test'))).toBe(false);
    });

    it('should return false for functions', () => {
      expect(isObject(() => {})).toBe(false);
      expect(isObject(function test() {})).toBe(false);
    });
  });

  describe('isRecord', () => {
    it('should return true for plain objects', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ key: 'value' })).toBe(true);
      expect(isRecord({ a: 1, b: 2, c: 3 })).toBe(true);
    });

    it('should return false for null', () => {
      expect(isRecord(null)).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2, 3])).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(isRecord('string')).toBe(false);
      expect(isRecord(123)).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });

    it('should handle objects with various value types', () => {
      expect(isRecord({ str: 'hello', num: 42, bool: true })).toBe(true);
      expect(isRecord({ nested: { obj: 'value' } })).toBe(true);
    });
  });

  describe('hasProperty', () => {
    it('should return true when property exists', () => {
      const obj = { name: 'test', count: 42 };
      expect(hasProperty(obj, 'name')).toBe(true);
      expect(hasProperty(obj, 'count')).toBe(true);
    });

    it('should return false when property does not exist', () => {
      const obj = { name: 'test' };
      expect(hasProperty(obj, 'missing')).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(hasProperty(null, 'prop')).toBe(false);
      expect(hasProperty(undefined, 'prop')).toBe(false);
      expect(hasProperty('string', 'prop')).toBe(false);
      expect(hasProperty(123, 'prop')).toBe(false);
    });

    it('should work with symbols as keys', () => {
      const sym = Symbol('test');
      const obj = { [sym]: 'value' };
      expect(hasProperty(obj, sym)).toBe(true);
    });

    it('should work with numeric keys', () => {
      const obj = { 0: 'zero', 1: 'one' };
      expect(hasProperty(obj, 0)).toBe(true);
      expect(hasProperty(obj, 1)).toBe(true);
    });

    it('should handle undefined property values', () => {
      const obj = { prop: undefined };
      expect(hasProperty(obj, 'prop')).toBe(true);
    });
  });

  describe('isAggregateError', () => {
    it('should return true for AggregateError', () => {
      const err = new AggregateError([new Error('1'), new Error('2')], 'Test');
      expect(isAggregateError(err)).toBe(true);
    });

    it('should return true for Error with errors array property', () => {
      const err = new Error('Test');
      (err as any).errors = [new Error('1'), new Error('2')];
      expect(isAggregateError(err)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const err = new Error('Test');
      expect(isAggregateError(err)).toBe(false);
    });

    it('should return false when errors property is not an array', () => {
      const err = new Error('Test');
      (err as any).errors = 'not an array';
      expect(isAggregateError(err)).toBe(false);
    });

    it('should return false for non-Error objects', () => {
      expect(isAggregateError({ errors: [] })).toBe(false);
      expect(isAggregateError(null)).toBe(false);
      expect(isAggregateError(undefined)).toBe(false);
      expect(isAggregateError('error')).toBe(false);
    });

    it('should handle empty errors array', () => {
      const err = new Error('Test');
      (err as any).errors = [];
      expect(isAggregateError(err)).toBe(true);
    });
  });

  describe('isErrorWithCode', () => {
    it('should return true for Error with code property', () => {
      const err = new Error('Test');
      (err as any).code = 'ERR_TEST';
      expect(isErrorWithCode(err)).toBe(true);
    });

    it('should return true for Error with numeric code', () => {
      const err = new Error('Test');
      (err as any).code = 404;
      expect(isErrorWithCode(err)).toBe(true);
    });

    it('should return false for regular Error without code', () => {
      const err = new Error('Test');
      expect(isErrorWithCode(err)).toBe(false);
    });

    it('should return false for non-Error objects with code', () => {
      expect(isErrorWithCode({ code: 'ERR_TEST' })).toBe(false);
      expect(isErrorWithCode(null)).toBe(false);
      expect(isErrorWithCode(undefined)).toBe(false);
    });
  });

  describe('getProperty', () => {
    it('should return property value when it exists', () => {
      const obj = { name: 'test', count: 42 };
      expect(getProperty(obj, 'name')).toBe('test');
      expect(getProperty(obj, 'count')).toBe(42);
    });

    it('should return undefined when property does not exist', () => {
      const obj = { name: 'test' };
      expect(getProperty(obj, 'missing')).toBeUndefined();
    });

    it('should return undefined for non-objects', () => {
      expect(getProperty(null, 'prop')).toBeUndefined();
      expect(getProperty(undefined, 'prop')).toBeUndefined();
      expect(getProperty('string', 'prop')).toBeUndefined();
      expect(getProperty(123, 'prop')).toBeUndefined();
    });

    it('should handle undefined property values', () => {
      const obj = { prop: undefined };
      expect(getProperty(obj, 'prop')).toBeUndefined();
    });

    it('should handle null property values', () => {
      const obj = { prop: null };
      expect(getProperty(obj, 'prop')).toBeNull();
    });

    it('should work with symbols as keys', () => {
      const sym = Symbol('test');
      const obj = { [sym]: 'value' };
      expect(getProperty(obj, sym)).toBe('value');
    });
  });
});
