/**
 * @fileoverview Provides a utility class `IdGenerator` for creating customizable, prefixed unique identifiers,
 * and a standalone `generateUUID` function for generating standard UUIDs.
 * The `IdGenerator` supports entity-specific prefixes, custom character sets, and lengths.
 *
 * Note: Logging has been removed from this module to prevent circular dependencies
 * with the `requestContextService`, which itself uses `generateUUID` from this module.
 * This was causing `ReferenceError: Cannot access 'generateUUID' before initialization`
 * during application startup.
 * @module src/utils/security/idGenerator
 */
import { validationError } from '@/types-global/errors.js';

/**
 * Returns cryptographically secure random bytes using the Web Crypto API (`crypto.getRandomValues`).
 * Available in Node.js 19+, Cloudflare Workers, and browsers — no Node.js-specific imports needed.
 * @param count - Number of random bytes to generate.
 * @returns A `Uint8Array` of `count` random bytes.
 */
function getRandomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Builds a random string of `length` characters drawn uniformly from `charset`.
 *
 * Rejection sampling: a byte is used only when it falls below the largest
 * multiple of `charset.length` that fits in 256, so `byte % charset.length`
 * never biases toward the low characters. Bytes are drawn in over-sized chunks
 * rather than one at a time, so a typical ID costs one `getRandomValues` call.
 */
function randomStringFromCharset(length: number, charset: string): string {
  const maxValidByteValue = Math.floor(256 / charset.length) * charset.length;
  let result = '';
  while (result.length < length) {
    for (const byte of getRandomBytes((length - result.length) * 2)) {
      if (byte >= maxValidByteValue) continue;
      result += charset.charAt(byte % charset.length);
      if (result.length === length) break;
    }
  }
  return result;
}

/**
 * Defines the structure for configuring entity prefixes.
 * Keys are entity type names (e.g., "project", "task"), and values are their corresponding ID prefixes (e.g., "PROJ", "TASK").
 */
export interface EntityPrefixConfig {
  [key: string]: string;
}

/**
 * Defines options for customizing ID generation.
 */
export interface IdGenerationOptions {
  /** Character set to draw from when building the random part. Defaults to `A-Z0-9`. */
  charset?: string;
  /** Length of the random part of the ID. Defaults to `6`. */
  length?: number;
  /** String placed between the prefix and the random part. Defaults to `'_'`. */
  separator?: string;
}

/**
 * A generic ID Generator class for creating and managing unique, prefixed identifiers.
 * Allows defining custom prefixes, generating random strings, and validating/normalizing IDs.
 */
export class IdGenerator {
  /**
   * Default character set for the random part of the ID.
   * @private
   */
  private static DEFAULT_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  /**
   * Default separator character between prefix and random part.
   * @private
   */
  private static DEFAULT_SEPARATOR = '_';
  /**
   * Default length for the random part of the ID.
   * @private
   */
  private static DEFAULT_LENGTH = 6;

  /**
   * Stores the mapping of entity types to their prefixes.
   * @private
   */
  private entityPrefixes: EntityPrefixConfig = {};
  /**
   * Stores a reverse mapping from prefixes (case-insensitive) to entity types.
   * @private
   */
  private prefixToEntityType: Record<string, string> = {};

  /**
   * Constructs an `IdGenerator` instance.
   * @param entityPrefixes - An initial map of entity types to their prefixes.
   */
  constructor(entityPrefixes: EntityPrefixConfig = {}) {
    // Logging removed to prevent circular dependency with requestContextService.
    this.setEntityPrefixes(entityPrefixes);
  }

  /**
   * Sets or updates the entity prefix configuration and rebuilds the internal reverse lookup map.
   * @param entityPrefixes - A map where keys are entity type names and values are their desired ID prefixes.
   */
  public setEntityPrefixes(entityPrefixes: EntityPrefixConfig): void {
    // Logging removed.
    this.entityPrefixes = { ...entityPrefixes };

    this.prefixToEntityType = Object.entries(this.entityPrefixes).reduce(
      (acc, [type, prefix]) => {
        acc[prefix.toLowerCase()] = type; // Store lowercase for case-insensitive lookup
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  /**
   * Retrieves a copy of the current entity prefix configuration.
   * @returns The current entity prefix configuration.
   */
  public getEntityPrefixes(): EntityPrefixConfig {
    return { ...this.entityPrefixes };
  }

  /**
   * Generates a cryptographically secure random string.
   * @param length - The desired length of the random string. Defaults to `IdGenerator.DEFAULT_LENGTH`.
   * @param charset - The character set to use. Defaults to `IdGenerator.DEFAULT_CHARSET`.
   * @returns The generated random string.
   */
  public generateRandomString(
    length: number = IdGenerator.DEFAULT_LENGTH,
    charset: string = IdGenerator.DEFAULT_CHARSET,
  ): string {
    return randomStringFromCharset(length, charset);
  }

  /**
   * Generates a unique ID, optionally prepended with a prefix.
   * @param prefix - An optional prefix for the ID.
   * @param options - Optional parameters for ID generation (length, separator, charset).
   * @returns A unique identifier string.
   */
  public generate(prefix?: string, options: IdGenerationOptions = {}): string {
    // Logging removed.
    const {
      length = IdGenerator.DEFAULT_LENGTH,
      separator = IdGenerator.DEFAULT_SEPARATOR,
      charset = IdGenerator.DEFAULT_CHARSET,
    } = options;

    const randomPart = this.generateRandomString(length, charset);
    const generatedId = prefix ? `${prefix}${separator}${randomPart}` : randomPart;
    return generatedId;
  }

  /**
   * Generates a unique ID for a specified entity type, using its configured prefix.
   * @param entityType - The type of entity (must be registered).
   * @param options - Optional parameters for ID generation.
   * @returns A unique identifier string for the entity (e.g., "PROJ_A6B3J0").
   * @throws {McpError} If the `entityType` is not registered.
   */
  public generateForEntity(entityType: string, options: IdGenerationOptions = {}): string {
    const prefix = this.entityPrefixes[entityType];
    if (!prefix) {
      throw validationError(`Unknown entity type: ${entityType}. No prefix registered.`);
    }
    return this.generate(prefix, options);
  }

  /**
   * Validates if an ID conforms to the expected format for a specific entity type.
   * @param id - The ID string to validate.
   * @param entityType - The expected entity type of the ID.
   * @param options - Optional parameters used during generation for validation consistency.
   *                  The `charset` from these options will be used for validation.
   * @returns `true` if the ID is valid, `false` otherwise.
   */
  public isValid(id: string, entityType: string, options: IdGenerationOptions = {}): boolean {
    const prefix = this.entityPrefixes[entityType];
    const {
      length = IdGenerator.DEFAULT_LENGTH,
      separator = IdGenerator.DEFAULT_SEPARATOR,
      charset = IdGenerator.DEFAULT_CHARSET, // Use charset from options or default
    } = options;

    if (!prefix) {
      return false;
    }

    // Build regex character class from the charset
    // Escape characters that have special meaning inside a regex character class `[]`
    const escapedCharsetForClass = charset.replace(/[[\]\\^-]/g, '\\$&');
    const charsetRegexPart = `[${escapedCharsetForClass}]`;

    const pattern = new RegExp(
      `^${this.escapeRegex(prefix)}${this.escapeRegex(separator)}${charsetRegexPart}{${length}}$`,
    );
    return pattern.test(id);
  }

  /**
   * Escapes special characters in a string for use in a regular expression.
   * @param str - The string to escape.
   * @returns The escaped string.
   * @private
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Strips the prefix and separator from an ID string, returning only the random part.
   * If the separator does not appear in the string, the original ID is returned unchanged.
   * Handles edge cases where the separator character appears in the random part by
   * rejoining all parts after the first split.
   *
   * @param id - The full ID string (e.g., `"PROJ_A6B3J0"`).
   * @param separator - The separator character used in the ID. Defaults to `'_'`.
   * @returns The random part of the ID without the prefix (e.g., `"A6B3J0"`), or the
   *   original string if the separator is not present.
   *
   * @example
   * ```ts
   * idGenerator.stripPrefix('PROJ_A6B3J0');         // → 'A6B3J0'
   * idGenerator.stripPrefix('PROJ-A6B3J0', '-');    // → 'A6B3J0'
   * idGenerator.stripPrefix('NOPREFIXID');           // → 'NOPREFIXID'
   * ```
   */
  public stripPrefix(id: string, separator: string = IdGenerator.DEFAULT_SEPARATOR): string {
    const parts = id.split(separator);
    return parts.length > 1 ? parts.slice(1).join(separator) : id; // Handle separators in random part
  }

  /**
   * Determines the entity type from an ID string by its prefix (case-insensitive).
   * @param id - The ID string (e.g., "PROJ_A6B3J0").
   * @param separator - The separator used in the ID. Defaults to `IdGenerator.DEFAULT_SEPARATOR`.
   * @returns The determined entity type.
   * @throws {McpError} If ID format is invalid or prefix is unknown.
   */
  public getEntityType(id: string, separator: string = IdGenerator.DEFAULT_SEPARATOR): string {
    const parts = id.split(separator);
    if (parts.length < 2 || !parts[0]) {
      throw validationError(
        `Invalid ID format: ${id}. Expected format like: PREFIX${separator}RANDOMPART`,
      );
    }

    const prefix = parts[0];
    const entityType = this.prefixToEntityType[prefix.toLowerCase()];

    if (!entityType) {
      throw validationError(`Unknown entity type for prefix: ${prefix}`);
    }
    return entityType;
  }

  /**
   * Normalizes an entity ID so that the prefix matches its registered casing and the random
   * part is uppercased. Delegates to {@link getEntityType} to resolve the canonical prefix.
   *
   * Note: Uppercasing the random part is correct for the default `A-Z0-9` charset. For custom
   * charsets that include lowercase or non-alphabetic characters, `toUpperCase()` may produce
   * unexpected results.
   *
   * @param id - The ID to normalize (e.g., `"proj_a6b3j0"`).
   * @param separator - The separator used in the ID. Defaults to `'_'`.
   * @returns The normalized ID with canonical prefix casing and uppercase random part
   *   (e.g., `"PROJ_A6B3J0"`).
   * @throws {McpError} With {@link JsonRpcErrorCode.ValidationError} if the entity type
   *   cannot be determined from the ID's prefix.
   *
   * @example
   * ```ts
   * idGenerator.setEntityPrefixes({ project: 'PROJ' });
   * idGenerator.normalize('proj_a6b3j0'); // → 'PROJ_A6B3J0'
   * idGenerator.normalize('PROJ_a6b3j0'); // → 'PROJ_A6B3J0'
   * ```
   */
  public normalize(id: string, separator: string = IdGenerator.DEFAULT_SEPARATOR): string {
    const entityType = this.getEntityType(id, separator);
    const registeredPrefix = this.entityPrefixes[entityType];
    const idParts = id.split(separator);
    const randomPart = idParts.slice(1).join(separator);

    // Consider if randomPart.toUpperCase() is always correct for custom charsets.
    // For now, maintaining existing behavior.
    return `${registeredPrefix}${separator}${randomPart.toUpperCase()}`;
  }
}

/**
 * Default singleton instance of {@link IdGenerator}, initialized with no entity prefixes.
 * Call `idGenerator.setEntityPrefixes({ ... })` during application startup to register prefixes
 * before calling `generateForEntity` or `getEntityType`.
 */
export const idGenerator = new IdGenerator();

/**
 * Generates a standard Version 4 UUID using the Web Crypto API (`crypto.randomUUID()`).
 * Cross-runtime: works in Node.js 19+, Cloudflare Workers, and browsers.
 *
 * @returns A new UUID v4 string (e.g., `"110e8400-e29b-41d4-a716-446655440000"`).
 *
 * @example
 * ```ts
 * const id = generateUUID(); // → '110e8400-e29b-41d4-a716-446655440000'
 * ```
 */
export const generateUUID = (): string => crypto.randomUUID();

/**
 * Generates a short, human-readable request context ID in the format `XXXXX-XXXXX`
 * (two 5-character alphanumeric segments joined by a hyphen, e.g., `"A3K9Z-BQ72M"`).
 *
 * This function is self-contained — it does not call `IdGenerator` or any other module-level
 * export — specifically to avoid circular dependencies with `requestContextService`, which
 * itself calls this function during initialization.
 *
 * Uses rejection sampling against the Web Crypto API for uniform, bias-free character selection.
 *
 * @returns A 11-character string in `XXXXX-XXXXX` format suitable for request tracing.
 *
 * @example
 * ```ts
 * const reqId = generateRequestContextId(); // → 'A3K9Z-BQ72M'
 * ```
 */
export const generateRequestContextId = (): string => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return `${randomStringFromCharset(5, charset)}-${randomStringFromCharset(5, charset)}`;
};
