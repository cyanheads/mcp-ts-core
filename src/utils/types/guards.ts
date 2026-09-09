/**
 * @fileoverview Type guard utilities for safe runtime type narrowing.
 * @module utils/types/guards
 *
 * Provides reusable type guards to replace unsafe type assertions throughout the codebase.
 * All guards perform proper runtime validation and narrow TypeScript types safely.
 */

/**
 * Type guard to check if a value is a non-null object.
 *
 * @param value - Value to check
 * @returns True if value is an object (excluding null and arrays)
 *
 * @example
 * ```typescript
 * if (isObject(someValue)) {
 *   // someValue is now typed as object
 *   console.log(someValue.toString());
 * }
 * ```
 */
export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a value is a plain record (non-null, non-array object with string keys).
 *
 * Arrays are excluded — this guard is intended for key-value objects only.
 * Delegates to {@link isObject} for the underlying check.
 *
 * @param value - Value to check
 * @returns True if value is a `Record<string, unknown>` (plain object, not null, not an array)
 *
 * @example
 * ```typescript
 * if (isRecord(data)) {
 *   // data is now typed as Record<string, unknown>
 *   const keys = Object.keys(data);
 * }
 * ```
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

/**
 * Type guard to check if an object has a specific property.
 *
 * @param obj - Object to check
 * @param key - Property key to look for
 * @returns True if object has the specified property
 *
 * @example
 * ```typescript
 * if (hasProperty(error, 'message')) {
 *   // TypeScript now knows error has a 'message' property
 *   console.log(error.message);
 * }
 * ```
 */
export function hasProperty<K extends PropertyKey>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> {
  return isObject(obj) && key in obj;
}

/**
 * Type guard to check if an error is an AggregateError.
 *
 * AggregateError contains multiple errors in an 'errors' array property.
 * This guard safely checks for the errors property without unsafe type assertions.
 *
 * @param error - Error to check
 * @returns True if error is an AggregateError with errors array
 *
 * @example
 * ```typescript
 * if (isAggregateError(error)) {
 *   // error.errors is now safely typed as unknown[]
 *   error.errors.forEach(innerError => console.log(innerError));
 * }
 * ```
 */
export function isAggregateError(error: unknown): error is Error & { errors: unknown[] } {
  return error instanceof Error && hasProperty(error, 'errors') && Array.isArray(error.errors);
}

/**
 * Type guard to check if an error has a code property.
 *
 * @param error - Error to check
 * @returns True if error has a code property
 *
 * @example
 * ```typescript
 * if (isErrorWithCode(error)) {
 *   console.log(`Error code: ${error.code}`);
 * }
 * ```
 */
export function isErrorWithCode(error: unknown): error is Error & { code: unknown } {
  return error instanceof Error && hasProperty(error, 'code');
}

/**
 * Safely get a property from an object if it exists.
 *
 * @param obj - Object to get property from
 * @param key - Property key
 * @returns Property value or undefined if property doesn't exist
 *
 * @example
 * ```typescript
 * const message = getProperty(error, 'message');
 * // message is typed as unknown
 * ```
 */
export function getProperty<K extends PropertyKey>(obj: unknown, key: K): unknown {
  return hasProperty(obj, key) ? obj[key] : undefined;
}
