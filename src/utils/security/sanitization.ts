/**
 * @fileoverview Provides a comprehensive `Sanitization` class for various input cleaning and
 * validation tasks. Includes utilities for sanitizing HTML, strings, URLs, file paths, JSON,
 * and numbers, as well as redacting sensitive fields from data intended for logging.
 *
 * Several methods (`sanitizeHtml`, `sanitizeString`, `sanitizeUrl`, `sanitizeNumber`) are
 * **async** because they lazy-load optional peer dependencies (`sanitize-html`, `validator`)
 * on first use. If a required peer dependency is not installed, these methods throw a
 * `McpError` with `JsonRpcErrorCode.ConfigurationError`.
 *
 * Path sanitization (`sanitizePath`) is synchronous but only available in Node.js environments.
 *
 * @module src/utils/security/sanitization
 */
import type sanitizeHtml from 'sanitize-html';

import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  validationError,
} from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';
import { DEFAULT_SENSITIVE_FIELDS, toPinoRedactPaths } from '@/utils/security/sensitiveFields.js';
import { isRecord } from '@/utils/types/guards.js';

let _sanitizeHtmlFn: typeof sanitizeHtml | undefined;
async function loadSanitizeHtml() {
  _sanitizeHtmlFn ??= (
    await import('sanitize-html').catch(() => {
      throw configurationError(
        'Install "sanitize-html" to use HTML sanitization: bun add sanitize-html',
      );
    })
  ).default;
  return _sanitizeHtmlFn;
}

let _validator: typeof import('validator').default | undefined;
async function loadValidator() {
  _validator ??= (
    await import('validator').catch(() => {
      throw configurationError('Install "validator" to use input validation: bun add validator');
    })
  ).default;
  return _validator;
}

// Dynamically import 'path' only in Node.js environments.
// Top-level await ensures the module is loaded before any sanitizePath call.
let pathModule: typeof import('node:path') | undefined;
if (runtimeCaps.isNode) {
  try {
    pathModule = (await import('node:path')).default;
  } catch {
    // May fail in some bundlers; sanitizePath guards against undefined pathModule.
  }
}

/**
 * Options controlling how `sanitizePath` processes and validates file paths.
 */
export interface PathSanitizeOptions {
  /** If `true`, absolute paths are permitted (subject to `rootDir` containment). Default: `false`. */
  allowAbsolute?: boolean;
  /**
   * If provided, all paths are resolved relative to this directory and checked for containment.
   * Any path that escapes the root via traversal (`../`) throws a `McpError`.
   * The value is resolved with `path.resolve` before use.
   */
  rootDir?: string;
  /** If `true`, normalizes Windows-style backslashes (`\`) to POSIX forward slashes (`/`). */
  toPosix?: boolean;
}

/**
 * Result returned by `sanitizePath`, describing the outcome of path sanitization.
 */
export interface SanitizedPathInfo {
  /**
   * `true` if the input was absolute but was converted to a relative path because
   * `allowAbsolute` was `false` and a `rootDir` was provided.
   */
  convertedToRelative: boolean;
  /** The effective options used for sanitization, with defaults applied. */
  optionsUsed: PathSanitizeOptions;
  /** The original path string as passed to `sanitizePath`, before any processing. */
  originalInput: string;
  /** The final sanitized and normalized path string. */
  sanitizedPath: string;
  /** `true` if the input path was absolute after initial `path.normalize`. */
  wasAbsolute: boolean;
}

/**
 * Options for context-specific string sanitization passed to `sanitizeString`.
 */
export interface SanitizeStringOptions {
  /**
   * Custom allowed HTML attributes, keyed by tag name (e.g., `{ a: ['href'] }`).
   * Only used when `context` is `'html'`.
   */
  allowedAttributes?: Record<string, string[]>;
  /**
   * Custom list of allowed HTML tag names.
   * Only used when `context` is `'html'`.
   */
  allowedTags?: string[];
  /**
   * The context in which the sanitized string will be used. Determines how sanitization
   * is performed. `'javascript'` is explicitly disallowed and will throw.
   * Defaults to `'text'`.
   */
  context?: 'text' | 'html' | 'attribute' | 'url' | 'javascript';
}

/**
 * Configuration options for HTML sanitization, mirroring the `sanitize-html` library's options.
 * Passed to `sanitizeHtml` to override the default allowlist.
 */
export interface HtmlSanitizeConfig {
  /**
   * Allowed HTML attributes, keyed by tag name or `'*'` for a global allowlist.
   * Mirrors `sanitize-html`'s `IOptions['allowedAttributes']`.
   */
  allowedAttributes?: sanitizeHtml.IOptions['allowedAttributes'];
  /**
   * Allowed HTML tag names. Any tag not in this list is stripped from the output.
   * Mirrors `sanitize-html`'s `allowedTags`.
   */
  allowedTags?: string[];
  /**
   * If `true`, HTML comments (`<!-- ... -->`) are preserved in the output.
   * Internally this is implemented by adding `'!--'` to the `allowedTags` list.
   */
  preserveComments?: boolean;
  /**
   * Custom tag-transform functions applied during sanitization.
   * If omitted, `<a>` tags are automatically given `rel="noopener noreferrer"`.
   * Mirrors `sanitize-html`'s `IOptions['transformTags']`.
   */
  transformTags?: sanitizeHtml.IOptions['transformTags'];
}

/**
 * Singleton class providing input sanitization across multiple categories:
 * HTML (XSS prevention), URLs, file paths (traversal prevention), JSON, numbers,
 * and log-safe redaction of sensitive fields.
 *
 * Obtain the singleton via `Sanitization.getInstance()` or use the pre-exported
 * `sanitization` constant.
 *
 * @example
 * ```ts
 * import { sanitization } from '@/utils/security/sanitization.js';
 *
 * const clean = await sanitization.sanitizeHtml('<script>alert(1)</script><b>hi</b>');
 * // => '<b>hi</b>'
 * ```
 */
export class Sanitization {
  /** @private */
  private static instance: Sanitization;

  private sensitiveFields: string[] = [...DEFAULT_SENSITIVE_FIELDS];

  /**
   * Default configuration for HTML sanitization.
   * @private
   */
  private defaultHtmlSanitizeConfig: HtmlSanitizeConfig = {
    allowedTags: [
      // === Structure & Sectioning ===
      'div',
      'span',
      'p',
      'br',
      'hr',
      'header',
      'footer',
      'nav',
      'article',
      'section',
      'aside',
      // === Headings & Text Content ===
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'em',
      'b',
      'i',
      'strike',
      'blockquote',
      // === Code ===
      'code',
      'pre',
      // === Lists ===
      'ul',
      'ol',
      'li',
      // === Tables ===
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      // === Media & Links ===
      'a',
      'img',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      // Allow data attributes, class, and id on all tags.
      // Note: 'style' is intentionally excluded — sanitize-html does not sanitize
      // CSS property values, so allowing it enables CSS injection (data exfiltration
      // via background:url(), UI redress via positioning, content injection via
      // ::before/::after). Use 'class' with external stylesheets instead.
      '*': ['class', 'id', 'data-*'],
      // Table-specific attributes
      th: ['scope'],
      td: ['colspan', 'rowspan'],
    },
    preserveComments: true,
    // transformTags is built lazily in sanitizeHtml() when the dep is loaded
  };

  /** @private */
  private constructor() {
    this.rebuildSensitiveSets();
  }

  private normalizedSensitiveSet!: Set<string>;
  private wordSensitiveSet!: Set<string>;

  /**
   * Returns the singleton instance of `Sanitization`, creating it on first call.
   *
   * @returns The singleton `Sanitization` instance.
   * @example
   * ```ts
   * const san = Sanitization.getInstance();
   * const safe = await san.sanitizeHtml(userInput);
   * ```
   */
  public static getInstance(): Sanitization {
    if (!Sanitization.instance) {
      Sanitization.instance = new Sanitization();
    }
    return Sanitization.instance;
  }

  /**
   * Extends the list of sensitive field names used by `sanitizeForLogging`.
   * New names are merged with the existing list (deduplication applied, case-insensitive).
   * Changes take effect immediately on subsequent `sanitizeForLogging` calls.
   *
   * @param fields - Field names to add to the sensitive list (e.g., `['myApiKey', 'session_id']`).
   * @returns `void`
   * @example
   * ```ts
   * sanitization.setSensitiveFields(['myApiKey', 'session_id']);
   * sanitization.sanitizeForLogging({ myApiKey: 'abc123' });
   * // => { myApiKey: '[REDACTED]' }
   * ```
   */
  public setSensitiveFields(fields: string[]): void {
    this.sensitiveFields = [
      ...new Set([...this.sensitiveFields, ...fields.map((f) => f.toLowerCase())]),
    ];
    this.rebuildSensitiveSets();
    const logContext = requestContextService.createRequestContext({
      operation: 'Sanitization.setSensitiveFields',
      additionalContext: {
        newSensitiveFieldCount: this.sensitiveFields.length,
      },
    });
    logger.debug('Updated sensitive fields list for log sanitization', logContext);
  }

  /**
   * Returns a copy of the current sensitive field names list.
   * All names are lowercased. Mutating the returned array has no effect on internal state.
   *
   * @returns Array of lowercase sensitive field name strings.
   * @example
   * ```ts
   * const fields = sanitization.getSensitiveFields();
   * // => ['password', 'token', 'secret', ...]
   * ```
   */
  public getSensitiveFields(): string[] {
    return [...this.sensitiveFields];
  }

  /**
   * Returns pino-compatible redact path patterns covering sensitive field names at three
   * nesting depths: top-level, one level deep, and two levels deep.
   *
   * For example, the field `'token'` generates:
   * - `'token'` — matches `{ token: '...' }`
   * - `'*.token'` — matches `{ auth: { token: '...' } }`
   * - `'*.*.token'` — matches `{ context: { auth: { token: '...' } } }`
   *
   * Pass the result directly to pino's `redact.paths` option.
   *
   * @returns Array of fast-redact-compatible path strings for use in pino's `redact.paths`.
   * @example
   * ```ts
   * import pino from 'pino';
   * const log = pino({ redact: { paths: sanitization.getSensitivePinoFields(), censor: '[REDACTED]' } });
   * ```
   */
  public getSensitivePinoFields(): string[] {
    return toPinoRedactPaths(this.sensitiveFields);
  }

  /**
   * Sanitizes an HTML string using `sanitize-html`, stripping disallowed tags and attributes.
   *
   * This method is **async** because it lazy-loads the `sanitize-html` peer dependency on
   * first call. By default, `<a>` tags receive `rel="noopener noreferrer"` automatically.
   * The `style` attribute is intentionally excluded from the default allowlist to prevent
   * CSS injection attacks.
   *
   * @param input - The HTML string to sanitize. Returns `''` immediately if falsy.
   * @param config - Optional config overriding the default tag/attribute allowlists.
   *   If omitted, the built-in defaults are used (see `defaultHtmlSanitizeConfig`).
   * @returns Promise resolving to the sanitized HTML string.
   * @throws {McpError} With `ConfigurationError` if `sanitize-html` is not installed.
   * @example
   * ```ts
   * const safe = await sanitization.sanitizeHtml('<script>alert(1)</script><b>Hello</b>');
   * // => '<b>Hello</b>'
   *
   * const custom = await sanitization.sanitizeHtml('<div class="x"><b>ok</b></div>', {
   *   allowedTags: ['b'],
   * });
   * // => '<b>ok</b>'
   * ```
   */
  public async sanitizeHtml(input: string, config?: HtmlSanitizeConfig): Promise<string> {
    if (!input) return '';
    const sanitizeHtmlFn = await loadSanitizeHtml();

    // Build default transformTags lazily now that the dep is loaded
    const defaultTransformTags = config?.transformTags ??
      this.defaultHtmlSanitizeConfig.transformTags ?? {
        a: sanitizeHtmlFn.simpleTransform('a', { rel: 'noopener noreferrer' }),
      };

    const effectiveConfig = {
      allowedTags: config?.allowedTags ?? this.defaultHtmlSanitizeConfig.allowedTags,
      allowedAttributes:
        config?.allowedAttributes ?? this.defaultHtmlSanitizeConfig.allowedAttributes,
      transformTags: defaultTransformTags,
      preserveComments: config?.preserveComments ?? this.defaultHtmlSanitizeConfig.preserveComments,
    };

    const options: sanitizeHtml.IOptions = {
      allowedTags: effectiveConfig.allowedTags,
      allowedAttributes: effectiveConfig.allowedAttributes,
      transformTags: effectiveConfig.transformTags,
    };

    if (effectiveConfig.preserveComments) {
      const baseTags = Array.isArray(options.allowedTags) ? options.allowedTags : [];
      options.allowedTags = [...baseTags, '!--'];
    }
    return sanitizeHtmlFn(input, options);
  }

  /**
   * Sanitizes a string according to its intended usage context.
   *
   * This method is **async** because it lazy-loads `sanitize-html` and/or `validator`
   * depending on the requested context.
   *
   * | `context`      | Behavior |
   * |----------------|----------|
   * | `'text'`       | Strips all HTML tags and attributes (default). |
   * | `'html'`       | Runs full HTML sanitization via `sanitizeHtml` (respects `allowedTags`/`allowedAttributes`). |
   * | `'attribute'`  | Strips all tags and attributes — safe for use inside an HTML attribute value. |
   * | `'url'`        | Validates the URL with `validator.isURL` (http/https only); returns `''` if invalid. |
   * | `'javascript'` | **Disallowed.** Always throws `McpError`. |
   *
   * @param input - The string to sanitize. Returns `''` immediately if falsy.
   * @param options - Context and optional allowlist overrides.
   * @returns Promise resolving to the sanitized string, or `''` for invalid URLs.
   * @throws {McpError} With `ValidationError` if `context` is `'javascript'`.
   * @throws {McpError} With `ConfigurationError` if a required peer dep is not installed.
   * @example
   * ```ts
   * await sanitization.sanitizeString('<b>hello</b>', { context: 'text' });
   * // => 'hello'
   *
   * await sanitization.sanitizeString('https://example.com', { context: 'url' });
   * // => 'https://example.com'
   *
   * await sanitization.sanitizeString('javascript:alert(1)', { context: 'url' });
   * // => '' (logged as warning, not thrown)
   * ```
   */
  public async sanitizeString(input: string, options: SanitizeStringOptions = {}): Promise<string> {
    if (!input) return '';

    const context = options.context ?? 'text';

    switch (context) {
      case 'html': {
        const config: HtmlSanitizeConfig = {};
        if (options.allowedTags) {
          config.allowedTags = options.allowedTags;
        }
        if (options.allowedAttributes) {
          config.allowedAttributes = options.allowedAttributes;
        }
        return await this.sanitizeHtml(input, config);
      }
      case 'attribute': {
        const sanitizeHtmlFn = await loadSanitizeHtml();
        return sanitizeHtmlFn(input, { allowedTags: [], allowedAttributes: {} });
      }
      case 'url': {
        const v = await loadValidator();
        if (
          !v.isURL(input, {
            protocols: ['http', 'https'],
            require_protocol: true,
            require_host: true,
          })
        ) {
          logger.warning(
            'Potentially invalid URL detected during string sanitization (context: url)',
            requestContextService.createRequestContext({
              operation: 'Sanitization.sanitizeString.urlWarning',
              additionalContext: { invalidUrlAttempt: input },
            }),
          );
          return '';
        }
        return v.trim(input);
      }
      case 'javascript':
        logger.error(
          'Attempted JavaScript sanitization via sanitizeString, which is disallowed.',
          requestContextService.createRequestContext({
            operation: 'Sanitization.sanitizeString.jsAttempt',
            additionalContext: { inputSnippet: input.substring(0, 50) },
          }),
        );
        throw validationError(
          'JavaScript sanitization is not supported through sanitizeString due to security risks.',
        );
      default: {
        const sanitizeHtmlFn = await loadSanitizeHtml();
        return sanitizeHtmlFn(input, { allowedTags: [], allowedAttributes: {} });
      }
    }
  }

  /**
   * Validates and sanitizes a URL string.
   *
   * This method is **async** because it lazy-loads the `validator` peer dependency on first call.
   *
   * Validation requires a protocol and host. Even if a protocol appears in `allowedProtocols`,
   * the pseudo-protocols `javascript:`, `data:`, and `vbscript:` are always rejected.
   *
   * @param input - The URL string to sanitize. Leading/trailing whitespace is trimmed.
   * @param allowedProtocols - URL schemes that are permitted. Defaults to `['http', 'https']`.
   * @returns Promise resolving to the trimmed, validated URL string.
   * @throws {McpError} With `ValidationError` if the URL is invalid, uses a disallowed protocol,
   *   or uses a blocked pseudo-protocol (`javascript:`, `data:`, `vbscript:`).
   * @throws {McpError} With `ConfigurationError` if `validator` is not installed.
   * @example
   * ```ts
   * await sanitization.sanitizeUrl('https://example.com/path');
   * // => 'https://example.com/path'
   *
   * await sanitization.sanitizeUrl('ftp://files.example.com', ['ftp', 'sftp']);
   * // => 'ftp://files.example.com'
   *
   * await sanitization.sanitizeUrl('javascript:alert(1)');
   * // throws McpError (ValidationError)
   * ```
   */
  public async sanitizeUrl(
    input: string,
    allowedProtocols: string[] = ['http', 'https'],
  ): Promise<string> {
    try {
      const v = await loadValidator();
      const trimmedInput = input.trim();
      if (
        !v.isURL(trimmedInput, {
          protocols: allowedProtocols,
          require_protocol: true,
          require_host: true,
        })
      ) {
        throw new Error('Invalid URL format or protocol not in allowed list.');
      }
      const lowercasedInput = trimmedInput.toLowerCase();
      if (
        lowercasedInput.startsWith('javascript:') ||
        lowercasedInput.startsWith('data:') ||
        lowercasedInput.startsWith('vbscript:')
      ) {
        throw new Error('Disallowed pseudo-protocol (javascript:, data:, or vbscript:) in URL.');
      }
      return trimmedInput;
    } catch (error: unknown) {
      throw validationError(
        error instanceof Error ? error.message : 'Invalid or unsafe URL provided.',
        { input },
      );
    }
  }

  /**
   * Sanitizes a file path, preventing path traversal attacks and normalizing format.
   *
   * This method is **synchronous** and only available in Node.js (uses `node:path`).
   * Calling it in a non-Node.js environment (e.g., Cloudflare Workers) throws immediately.
   *
   * Traversal detection:
   * - With `rootDir`: resolves the full path and asserts it starts within the root.
   * - Without `rootDir`: resolves the relative path against CWD and asserts containment.
   * - Null bytes (`\0`) in paths are always rejected.
   *
   * @param input - The file path string to sanitize.
   * @param options - Options controlling absolute path permission, root directory, and POSIX normalization.
   * @returns A `SanitizedPathInfo` object with the sanitized path and operation metadata.
   * @throws {McpError} With `InternalError` if called outside a Node.js environment.
   * @throws {McpError} With `ValidationError` if the path is empty, contains a null byte,
   *   attempts traversal beyond `rootDir` or CWD, or is absolute when `allowAbsolute` is `false`.
   * @example
   * ```ts
   * const result = sanitization.sanitizePath('../../etc/passwd', { rootDir: '/app/data' });
   * // throws McpError (path traversal detected)
   *
   * const result = sanitization.sanitizePath('uploads/file.txt', { rootDir: '/app/data' });
   * // => { sanitizedPath: 'uploads/file.txt', wasAbsolute: false, convertedToRelative: false, ... }
   *
   * const result = sanitization.sanitizePath('C:\\Users\\foo\\bar', { toPosix: true, allowAbsolute: true });
   * // => { sanitizedPath: 'C:/Users/foo/bar', wasAbsolute: true, ... }
   * ```
   */
  public sanitizePath(input: string, options: PathSanitizeOptions = {}): SanitizedPathInfo {
    if (!runtimeCaps.isNode || !pathModule) {
      throw new McpError(
        JsonRpcErrorCode.InternalError,
        'File-based path sanitization is not supported in this environment.',
      );
    }
    const path = pathModule;

    const originalInput = input;
    const resolvedRootDir = options.rootDir ? path.resolve(options.rootDir) : undefined;
    const effectiveOptions: PathSanitizeOptions = {
      toPosix: options.toPosix ?? false,
      allowAbsolute: options.allowAbsolute ?? false,
      ...(resolvedRootDir && { rootDir: resolvedRootDir }),
    };

    let wasAbsoluteInitially = false;

    try {
      if (!input || typeof input !== 'string')
        throw new Error('Invalid path input: must be a non-empty string.');
      if (input.includes('\0')) throw new Error('Path contains null byte, which is disallowed.');

      let normalized = path.normalize(input);
      wasAbsoluteInitially = path.isAbsolute(normalized);

      if (effectiveOptions.toPosix) {
        normalized = normalized.replace(/\\/g, '/');
      }

      let finalSanitizedPath: string;

      if (resolvedRootDir) {
        const fullPath = path.resolve(resolvedRootDir, normalized);
        if (!fullPath.startsWith(resolvedRootDir + path.sep) && fullPath !== resolvedRootDir) {
          throw new Error(
            'Path traversal detected: attempts to escape the defined root directory.',
          );
        }
        finalSanitizedPath = path.relative(resolvedRootDir, fullPath);
        finalSanitizedPath = finalSanitizedPath === '' ? '.' : finalSanitizedPath;
        if (path.isAbsolute(finalSanitizedPath) && !effectiveOptions.allowAbsolute) {
          throw new Error(
            'Path resolved to absolute outside root when absolute paths are disallowed.',
          );
        }
      } else {
        if (path.isAbsolute(normalized)) {
          if (!effectiveOptions.allowAbsolute) {
            throw new Error('Absolute paths are disallowed by current options.');
          } else {
            finalSanitizedPath = normalized;
          }
        } else {
          const resolvedAgainstCwd = path.resolve(normalized);
          const currentWorkingDir = path.resolve('.');
          if (
            !resolvedAgainstCwd.startsWith(currentWorkingDir + path.sep) &&
            resolvedAgainstCwd !== currentWorkingDir
          ) {
            throw new Error(
              'Relative path traversal detected (escapes current working directory context).',
            );
          }
          finalSanitizedPath = normalized;
        }
      }

      return {
        sanitizedPath: finalSanitizedPath,
        originalInput,
        wasAbsolute: wasAbsoluteInitially,
        convertedToRelative:
          wasAbsoluteInitially &&
          !path.isAbsolute(finalSanitizedPath) &&
          !effectiveOptions.allowAbsolute,
        optionsUsed: effectiveOptions,
      };
    } catch (error: unknown) {
      logger.warning(
        'Path sanitization error',
        requestContextService.createRequestContext({
          operation: 'Sanitization.sanitizePath.error',
          additionalContext: {
            originalPathInput: originalInput,
            pathOptionsUsed: effectiveOptions,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      throw validationError(
        error instanceof Error ? error.message : 'Invalid or unsafe path provided.',
        { input: originalInput },
      );
    }
  }

  /**
   * Validates and parses a JSON string, with an optional maximum byte-size guard.
   *
   * This method is **synchronous**. Byte length is computed via `Buffer.byteLength` in
   * Node.js, `TextEncoder` in environments that support it, or falls back to `string.length`.
   *
   * @template T - Expected type of the parsed value. Defaults to `unknown`.
   * @param input - The JSON string to validate and parse. Must be a `string`.
   * @param maxSize - Optional maximum allowed UTF-8 byte length. Throws if exceeded.
   * @returns The parsed JavaScript value cast to `T`.
   * @throws {McpError} With `ValidationError` if:
   *   - `input` is not a string
   *   - `input` exceeds `maxSize` bytes
   *   - `input` is not valid JSON
   * @example
   * ```ts
   * const obj = sanitization.sanitizeJson<{ id: number }>('{"id":1}');
   * // => { id: 1 }
   *
   * sanitization.sanitizeJson('{"big":"value"}', 5);
   * // throws McpError (exceeds maxSize)
   *
   * sanitization.sanitizeJson('{bad json}');
   * // throws McpError (invalid JSON)
   * ```
   */
  public sanitizeJson<T = unknown>(input: string, maxSize?: number): T {
    try {
      if (typeof input !== 'string') throw new Error('Invalid input: expected a JSON string.');

      // Cross-environment byte length computation
      const computeBytes = (s: string): number => {
        if (runtimeCaps.hasBuffer && typeof Buffer.byteLength === 'function') {
          return Buffer.byteLength(s, 'utf8');
        }
        if (runtimeCaps.hasTextEncoder) {
          return new TextEncoder().encode(s).length;
        }
        return s.length;
      };

      if (maxSize !== undefined && computeBytes(input) > maxSize) {
        throw validationError(`JSON string exceeds maximum allowed size of ${maxSize} bytes.`, {
          actualSize: computeBytes(input),
          maxSize,
        });
      }

      return JSON.parse(input) as T;
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      throw validationError(error instanceof Error ? error.message : 'Invalid JSON format.', {
        inputPreview: input.length > 100 ? `${input.substring(0, 100)}...` : input,
      });
    }
  }

  /**
   * Validates a numeric input and optionally clamps it to a range.
   *
   * This method is **async** because string inputs are validated using the `validator` peer
   * dependency, which is lazy-loaded on first call. Numeric inputs bypass the lazy load.
   *
   * - String inputs: trimmed and checked with `validator.isNumeric`, then parsed with `parseFloat`.
   * - Number inputs: used directly.
   * - `NaN` and `Infinity` are always rejected.
   * - If `min` or `max` are provided, the value is silently clamped (a debug log is emitted).
   *
   * @param input - The number or numeric string to validate.
   * @param min - Inclusive lower bound. If the value is below this, it is clamped to `min`.
   * @param max - Inclusive upper bound. If the value is above this, it is clamped to `max`.
   * @returns Promise resolving to the validated (and potentially clamped) number.
   * @throws {McpError} With `ValidationError` if the input is not numeric, is `NaN`, or is `Infinity`.
   * @throws {McpError} With `ConfigurationError` if `validator` is not installed (string input only).
   * @example
   * ```ts
   * await sanitization.sanitizeNumber('42.5');
   * // => 42.5
   *
   * await sanitization.sanitizeNumber(150, 0, 100);
   * // => 100  (clamped to max)
   *
   * await sanitization.sanitizeNumber('abc');
   * // throws McpError (ValidationError)
   * ```
   */
  public async sanitizeNumber(input: number | string, min?: number, max?: number): Promise<number> {
    let value: number;
    if (typeof input === 'string') {
      const v = await loadValidator();
      const trimmedInput = input.trim();
      if (trimmedInput === '' || !v.isNumeric(trimmedInput)) {
        throw validationError('Invalid number format: input is empty or not numeric.', { input });
      }
      value = parseFloat(trimmedInput);
    } else if (typeof input === 'number') {
      value = input;
    } else {
      throw validationError('Invalid input type: expected number or string.', {
        input: String(input),
      });
    }

    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw validationError('Invalid number value (NaN or Infinity).', { input });
    }

    let clamped = false;
    const originalValueForLog = value;
    if (min !== undefined && value < min) {
      value = min;
      clamped = true;
    }
    if (max !== undefined && value > max) {
      value = max;
      clamped = true;
    }
    if (clamped) {
      logger.debug(
        'Number clamped to range.',
        requestContextService.createRequestContext({
          operation: 'Sanitization.sanitizeNumber.clamped',
          additionalContext: {
            originalInput: String(input),
            parsedValue: originalValueForLog,
            minValue: min,
            maxValue: max,
            clampedValue: value,
          },
        }),
      );
    }
    return value;
  }

  /**
   * Produces a log-safe deep clone of `input` with sensitive field values replaced by `'[REDACTED]'`.
   *
   * This method is **synchronous**. It uses `structuredClone` for deep cloning. Sensitive field
   * detection combines two strategies:
   * - **Exact match**: the normalized key (lowercased, non-alphanumeric stripped) matches a
   *   sensitive field name.
   * - **Word match**: splitting the key by camelCase/snake_case/kebab-case tokens and checking
   *   each token against the sensitive word set.
   *
   * Non-object/non-array inputs (primitives, `null`) are returned as-is without cloning.
   * If `structuredClone` itself throws (e.g., circular reference, uncloneable type), the method
   * returns the string `'[Log Sanitization Failed]'` and emits an error log rather than throwing.
   *
   * @param input - The value to sanitize. Non-objects are returned unchanged.
   * @returns A sanitized deep clone of `input` (with sensitive values redacted),
   *   the original primitive if not an object, or `'[Log Sanitization Failed]'` on clone error.
   * @example
   * ```ts
   * sanitization.sanitizeForLogging({ user: 'alice', password: 'secret', nested: { token: 'abc' } });
   * // => { user: 'alice', password: '[REDACTED]', nested: { token: '[REDACTED]' } }
   *
   * sanitization.sanitizeForLogging('just a string');
   * // => 'just a string'  (returned as-is)
   * ```
   */
  public sanitizeForLogging(input: unknown): unknown {
    try {
      if (!input || typeof input !== 'object') return input;

      const clonedInput: unknown = structuredClone(input);
      this.redactSensitiveFields(clonedInput);
      return clonedInput;
    } catch (error: unknown) {
      logger.error(
        'Error during log sanitization, returning placeholder.',
        requestContextService.createRequestContext({
          operation: 'Sanitization.sanitizeForLogging.error',
          additionalContext: {
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      return '[Log Sanitization Failed]';
    }
  }

  /**
   * Recursively redacts sensitive fields in an object or array in place.
   * @param obj - The object or array to redact.
   * @private
   */
  private redactSensitiveFields(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) this.redactSensitiveFields(item);
      return;
    }

    // Type guard ensures obj is a Record<string, unknown>
    if (!isRecord(obj)) return;

    for (const key in obj) {
      if (Object.hasOwn(obj, key)) {
        const value = obj[key];
        const normalizedKey = Sanitization.normalizeName(key);
        // Split into words for token-based matching (camelCase, snake_case, kebab-case)
        const keyWords = key
          .replace(/([A-Z])/g, ' $1')
          .toLowerCase()
          .split(/[\s_-]+/)
          .filter(Boolean);

        const isExactSensitive = this.normalizedSensitiveSet.has(normalizedKey);
        const isWordSensitive = keyWords.some((w) => this.wordSensitiveSet.has(w));
        const isSensitive = isExactSensitive || isWordSensitive;

        if (isSensitive) {
          obj[key] = '[REDACTED]';
        } else if (value && typeof value === 'object') {
          this.redactSensitiveFields(value);
        }
      }
    }
  }

  /**
   * Normalizes a field name for sensitive-key lookup by lowercasing and stripping
   * all non-alphanumeric characters. Used for exact-match detection in `redactSensitiveFields`.
   * @param str - The raw field name string.
   * @returns Lowercased alphanumeric-only version of `str`.
   * @private
   */
  private static normalizeName(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private rebuildSensitiveSets(): void {
    this.normalizedSensitiveSet = new Set(
      this.sensitiveFields.map((f) => Sanitization.normalizeName(f)).filter(Boolean),
    );
    this.wordSensitiveSet = new Set(
      this.sensitiveFields.map((f) => f.toLowerCase()).filter(Boolean),
    );
  }
}

/**
 * Pre-constructed singleton instance of `Sanitization`.
 * Use this for all input sanitization tasks rather than calling `Sanitization.getInstance()` directly.
 *
 * @example
 * ```ts
 * import { sanitization } from '@/utils/security/sanitization.js';
 * const safe = await sanitization.sanitizeHtml(userHtml);
 * ```
 */
export const sanitization = Sanitization.getInstance();

/**
 * Convenience wrapper around `sanitization.sanitizeForLogging`.
 * Produces a log-safe deep clone of `input` with sensitive field values replaced by `'[REDACTED]'`.
 *
 * @param input - The value to sanitize. Non-objects are returned unchanged.
 * @returns A sanitized deep clone of `input`, the original primitive if not an object,
 *   or `'[Log Sanitization Failed]'` on clone error.
 * @example
 * ```ts
 * import { sanitizeInputForLogging } from '@/utils/security/sanitization.js';
 * logger.info('Request', sanitizeInputForLogging({ user: 'alice', token: 'secret' }));
 * // logs: { user: 'alice', token: '[REDACTED]' }
 * ```
 */
export const sanitizeInputForLogging = (input: unknown): unknown =>
  sanitization.sanitizeForLogging(input);
