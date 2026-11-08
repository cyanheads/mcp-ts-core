/**
 * @fileoverview A filesystem-based storage provider. Each key is one JSON
 * document under `<storagePath>/_v2/`, at a path of its own: no two valid
 * tenant IDs share a directory, and no two keys of a tenant share a file.
 *
 * Layout: `_v2/<tenant>/<segment>/…/<last segment>.json` — a directory per
 * `/`-separated key segment but the last, then a file for the last. Every name
 * is encoded: `a`–`z`, `0`–`9`, `_`, and `-` stand for themselves, every other
 * byte of the text's UTF-8 form is `%` and two lowercase hex digits (`A` →
 * `%41`, `.` → `%2e`), and an empty directory segment is `%`. So every name is
 * lowercase and never `.` or `..`, a directory name holds no `.` while a file
 * name always ends in `.json`, and `a` (`a.json`) sits beside `a/b`
 * (`a/b.json`) and `x/./y` beside `x/y`. An
 * uppercase letter or `.` takes three bytes of a name, so the filesystem's name
 * limit (255 bytes on APFS and ext4) admits a last segment of 250 lowercase or
 * 83 uppercase characters; past it, a key rejects as `ValidationError` before
 * any filesystem call, and a batch before its first. Every valid tenant ID has
 * a directory: its encoded name when that fits the limit, otherwise `%%` and
 * the ID's SHA-256 in lowercase hex.
 *
 * A storage path in the earlier layout — tenant directories at its top level,
 * each key at the path it spells — is copied into `_v2/` once, when the first
 * provider over it is constructed, and then left in place, unread.
 *
 * Performance note: List operations with TTL filtering can be slow on large datasets
 * as each file must be read and parsed to check expiration. Consider implementing
 * periodic cleanup jobs for production use with large key counts.
 *
 * @module src/storage/providers/fileSystem/fileSystemProvider
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  IStorageProvider,
  ListOptions,
  ListResult,
  StorageOptions,
} from '@/storage/core/IStorageProvider.js';
import {
  type DecodedEnvelope,
  decodeEnvelope,
  deleteManyViaDelete,
  encodeEntries,
  encodeEnvelope,
  getManyViaGet,
  paginateSortedKeys,
  serializeValue,
  setManyViaSet,
} from '@/storage/core/providerHelpers.js';
import { decodeCursor, validateTenantId } from '@/storage/core/storageValidation.js';
import {
  configurationError,
  databaseError,
  JsonRpcErrorCode,
  McpError,
  validationError,
} from '@/types-global/errors.js';
import { ErrorHandler } from '@/utils/internal/error-handler/errorHandler.js';
import { logger } from '@/utils/internal/logger.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import { isErrorWithCode } from '@/utils/types/guards.js';

const DEFAULT_LIST_LIMIT = 1000;

/**
 * The data root under the storage path. No tenant directory of the earlier
 * layout can carry this name: a tenant ID starts with a letter or digit.
 */
const DATA_DIR = '_v2';
const FILE_SUFFIX = '.json';
const EMPTY_SEGMENT = '%';
/** Begins the directory name of a tenant ID whose encoding passes {@link NAME_MAX_BYTES}. */
const DIGEST_PREFIX = '%%';

/**
 * The longest name the provider stores, in bytes: the per-name limit of APFS
 * and ext4. Every encoded name is ASCII, so its length is its byte count. A
 * host with a shorter name or path limit still answers `ENAMETOOLONG`, which
 * {@link fsFailure} maps to the same `ValidationError`.
 */
const NAME_MAX_BYTES = 255;

const utf8 = new TextEncoder();

const isMissing = (error: unknown) => isErrorWithCode(error) && error.code === 'ENOENT';
const isNameTooLong = (error: unknown) => isErrorWithCode(error) && error.code === 'ENAMETOOLONG';

const escapeByte = (byte: number) => `%${byte.toString(16).padStart(2, '0')}`;

/** `%xx` for each UTF-8 byte of one code point; an ASCII one skips the encoder. */
function escapeCodePoint(char: string): string {
  const code = char.charCodeAt(0);
  return code < 0x80 ? escapeByte(code) : Array.from(utf8.encode(char), escapeByte).join('');
}

/** Encodes `text` as one path name: `[a-z0-9_-]` as is, every other UTF-8 byte as `%xx`. */
function encodeName(text: string): string {
  return text.replace(/[^a-z0-9_-]/gu, escapeCodePoint);
}

/** The text `name` encodes, or `undefined` for a name {@link encodeName} never produces. */
function decodeName(name: string): string | undefined {
  let text: string;
  try {
    text = decodeURIComponent(name);
  } catch {
    return;
  }
  return encodeName(text) === name ? text : undefined;
}

const encodeDirName = (segment: string) => (segment === '' ? EMPTY_SEGMENT : encodeName(segment));
const decodeDirName = (name: string) => (name === EMPTY_SEGMENT ? '' : decodeName(name));
const decodeFileName = (name: string) =>
  name.endsWith(FILE_SUFFIX) ? decodeName(name.slice(0, -FILE_SUFFIX.length)) : undefined;

const fitsName = (name: string) => name.length <= NAME_MAX_BYTES;

/**
 * The directory name of `tenantId`: its encoding when that fits the name
 * limit, otherwise `%%` and the ID's SHA-256 in lowercase hex. The two forms
 * never meet: {@link encodeName} writes `%` only to open a `%xx` escape, so a
 * hex digit always follows it and no encoding holds `%%`.
 */
function tenantDirName(tenantId: string): string {
  const encoded = encodeName(tenantId);
  return fitsName(encoded)
    ? encoded
    : `${DIGEST_PREFIX}${createHash('sha256').update(tenantId).digest('hex')}`;
}

/** The names `key` is stored under, below its tenant directory. */
function keyPath(key: string): string[] {
  const segments = key.split('/');
  return segments.map((segment, index) =>
    index < segments.length - 1 ? encodeDirName(segment) : `${encodeName(segment)}${FILE_SUFFIX}`,
  );
}

/**
 * The rejection of a key the filesystem cannot name: a `ValidationError`, as
 * `validateKey` throws, since a shorter key succeeds.
 */
const keyTooLong = (key: string, options?: { cause: unknown }) =>
  validationError(
    `Key "${key}" is too long for filesystem storage. Use a shorter key or shorter "/"-separated segments.`,
    { key },
    options,
  );

/**
 * {@link keyPath}, checked against the name limit before any filesystem call.
 * Throws `ValidationError` when one of the names passes it.
 */
function storedNames(key: string): string[] {
  const names = keyPath(key);
  if (!names.every(fitsName)) throw keyTooLong(key);
  return names;
}

/** A stored document: the key it holds and the file holding it. */
interface StoredFile {
  filePath: string;
  key: string;
}

/**
 * Maps a raw `fs` failure to the error a caller may see. Every `fs` error
 * quotes the absolute path it failed on, and `ErrorHandler.tryCatch` forwards
 * message and `data` toward the caller, so the mapped error names the key
 * instead and keeps the raw error on `cause`, where the log record's
 * `causeChain` carries its `code` and path. `ENAMETOOLONG` on a key the caller
 * chose — a host whose name or path limit is shorter than the one
 * {@link storedNames} checks — is the same `ValidationError`; every other
 * fault is a `DatabaseError`.
 */
function fsFailure(error: unknown, message: string, key?: string): McpError {
  if (key !== undefined && isNameTooLong(error)) return keyTooLong(key, { cause: error });
  return databaseError(message, undefined, { cause: error });
}

/**
 * Appends every regular file below `dir` to `found` under the key the earlier
 * layout's `list` reported for it: its `/`-joined path below the tenant
 * directory. Symbolic links are not followed, as that `list` did not follow
 * them; `readdirSync`'s `recursive` option follows a linked directory.
 */
function collectLegacyFiles(dir: string, keyPrefix: string, found: StoredFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectLegacyFiles(filePath, `${keyPrefix}${entry.name}/`, found);
    else if (entry.isFile()) found.push({ filePath, key: `${keyPrefix}${entry.name}` });
  }
}

/** Whether `name` is a tenant ID, and so a tenant directory of the earlier layout. */
function isTenantId(name: string, context: RequestContext): boolean {
  try {
    validateTenantId(name, context);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `from` to `to`, creating the directories above it. `false` when the
 * host refuses a name or the path as too long; any other fault throws.
 */
function copyInto(from: string, to: string): boolean {
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    return true;
  } catch (error: unknown) {
    if (isNameTooLong(error)) return false;
    throw error;
  }
}

/**
 * Creates the data root at `dataPath`, first copying in a storage path that
 * holds the earlier layout. Each legacy file is copied byte for byte — its TTL
 * envelope included — under the tenant and key the earlier layout's `list`
 * reported for it: its tenant directory's name and its `/`-joined path there,
 * into the directory {@link tenantDirName} gives that tenant.
 * The copy is assembled beside the data root and renamed into place, so a
 * partial copy is never read; a construction racing this one over the same
 * storage path loses the rename, discards its copy, and uses the winner's.
 * The legacy tree is never modified. A legacy file whose key is too long for
 * the new layout stays behind and is named in the warning that names the
 * legacy tenant directories. Any other fault throws, leaving no data root, so
 * the next construction copies again.
 */
function createDataRoot(storagePath: string, dataPath: string): void {
  const context = requestContextService.createRequestContext({
    operation: 'FileSystemProvider.createDataRoot',
  });
  const stagingPath = `${dataPath}.tmp-${randomUUID()}`;
  const legacyTenants: string[] = [];
  const notCopied: string[] = [];
  try {
    for (const entry of readdirSync(storagePath, { withFileTypes: true })) {
      if (entry.isDirectory() && isTenantId(entry.name, context)) legacyTenants.push(entry.name);
    }
    if (legacyTenants.length === 0) {
      mkdirSync(dataPath, { recursive: true });
      return;
    }
    mkdirSync(stagingPath);
    for (const tenant of legacyTenants) {
      const files: StoredFile[] = [];
      collectLegacyFiles(path.join(storagePath, tenant), '', files);
      const tenantPath = path.join(stagingPath, tenantDirName(tenant));
      for (const { filePath, key } of files) {
        const names = keyPath(key);
        if (names.every(fitsName) && copyInto(filePath, path.join(tenantPath, ...names))) continue;
        notCopied.push(`${tenant}/${key}`);
      }
    }
    renameSync(stagingPath, dataPath);
  } catch (error: unknown) {
    rmSync(stagingPath, { force: true, recursive: true });
    // Another construction over this storage path created the data root first.
    if (existsSync(dataPath)) return;
    throw databaseError(
      `Failed to copy filesystem storage at "${storagePath}" into its current layout under "${dataPath}". Nothing was changed; fix the cause and start again.`,
      undefined,
      { cause: error },
    );
  }
  const leftBehind =
    notCopied.length > 0
      ? ` ${notCopied.length} file(s), listed in notCopied, stayed behind: their keys are too long for the filesystem in the new layout, so they are not readable.`
      : '';
  logger.warning(
    `Filesystem storage moved to a new layout under "${dataPath}". Copied the tenant directories of the earlier layout in "${storagePath}" (${legacyTenants.join(', ')}); they are no longer read and can be removed once no earlier version of this server uses this storage path.${leftBehind}`,
    withExtra(context, { notCopied }),
  );
}

export class FileSystemProvider implements IStorageProvider {
  private readonly dataPath: string;

  constructor(storagePath: string) {
    if (!storagePath) {
      throw configurationError('FileSystemProvider requires a valid storagePath.');
    }
    const resolvedPath = path.resolve(storagePath);
    this.dataPath = path.join(resolvedPath, DATA_DIR);
    if (!existsSync(this.dataPath)) {
      mkdirSync(resolvedPath, { recursive: true });
      createDataRoot(resolvedPath, this.dataPath);
    }
  }

  private getTenantPath(tenantId: string, context: RequestContext): string {
    // Defense-in-depth: re-validate at the provider boundary. The upstream
    // StorageService gate also runs this check; mirroring it here protects
    // callers that construct the provider directly (custom providers,
    // tests, the add-provider skill's reference path).
    validateTenantId(tenantId, context);
    const tenantPath = path.join(this.dataPath, tenantDirName(tenantId));
    if (!existsSync(tenantPath)) {
      try {
        mkdirSync(tenantPath, { recursive: true });
      } catch (error: unknown) {
        throw fsFailure(error, `Failed to create the storage directory for tenant "${tenantId}".`);
      }
    }
    return tenantPath;
  }

  /** The file holding `key`; its names are checked before the tenant directory is created. */
  private getFilePath(tenantId: string, key: string, context: RequestContext): string {
    const names = storedNames(key);
    return path.join(this.getTenantPath(tenantId, context), ...names);
  }

  /**
   * Appends to `found` every stored file below `dir`, whose keys start with
   * `keyPrefix`, that can match `prefix`. A name the encoding never produces —
   * an editor's swap file, `.DS_Store` — is skipped.
   */
  private async collectFiles(
    dir: string,
    keyPrefix: string,
    prefix: string,
    found: StoredFile[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      throw fsFailure(error, 'Failed to list stored keys.');
    });
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const segment = decodeDirName(entry.name);
        if (segment === undefined) continue;
        const childPrefix = `${keyPrefix}${segment}/`;
        // Every key below this directory starts with `childPrefix`.
        if (childPrefix.startsWith(prefix) || prefix.startsWith(childPrefix)) {
          await this.collectFiles(filePath, childPrefix, prefix, found);
        }
      } else if (entry.isFile()) {
        const segment = decodeFileName(entry.name);
        if (segment !== undefined) found.push({ filePath, key: `${keyPrefix}${segment}` });
      }
    }
  }

  /** Every stored document of the tenant whose key starts with `prefix`. */
  private async listFiles(tenantPath: string, prefix: string): Promise<StoredFile[]> {
    const found: StoredFile[] = [];
    await this.collectFiles(tenantPath, '', prefix, found);
    return found.filter(({ key }) => key.startsWith(prefix));
  }

  /** Decodes a stored envelope; an expired file is removed best-effort and reads as `null`. */
  private async parseAndValidate<T>(
    raw: string,
    tenantId: string,
    key: string,
    filePath: string,
  ): Promise<T | null> {
    let decoded: DecodedEnvelope<T>;
    try {
      decoded = decodeEnvelope<T>(raw);
    } catch (error: unknown) {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        `Failed to parse stored JSON for key "${key}" (tenant "${tenantId}").`,
        undefined,
        { cause: error },
      );
    }
    if (decoded.kind === 'expired') {
      await rm(filePath, { force: true }).catch(() => undefined);
      return null;
    }
    return decoded.value;
  }

  private async writeDocument(filePath: string, key: string, document: string): Promise<void> {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, document, 'utf-8');
    } catch (error: unknown) {
      throw fsFailure(error, `Failed to write stored value for key "${key}".`, key);
    }
  }

  /** Removes a stored document; `false` when there was none. */
  private async removeDocument(filePath: string, key: string): Promise<boolean> {
    try {
      await rm(filePath);
      return true;
    } catch (error: unknown) {
      if (isMissing(error)) return false;
      throw fsFailure(error, `Failed to delete stored value for key "${key}".`, key);
    }
  }

  async get<T>(tenantId: string, key: string, context: RequestContext): Promise<T | null> {
    return await ErrorHandler.tryCatch(
      async () => {
        const filePath = this.getFilePath(tenantId, key, context);
        let data: string;
        try {
          data = await readFile(filePath, 'utf-8');
        } catch (error: unknown) {
          if (isMissing(error)) return null;
          throw fsFailure(error, `Failed to read stored value for key "${key}".`, key);
        }
        return await this.parseAndValidate<T>(data, tenantId, key, filePath);
      },
      {
        operation: 'FileSystemProvider.get',
        context,
        input: { tenantId, key },
      },
    );
  }

  async set(
    tenantId: string,
    key: string,
    value: unknown,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    return await ErrorHandler.tryCatch(
      () =>
        this.writeDocument(
          this.getFilePath(tenantId, key, context),
          key,
          encodeEnvelope(serializeValue(key, value), options),
        ),
      {
        operation: 'FileSystemProvider.set',
        context,
        input: { tenantId, key },
      },
    );
  }

  async delete(tenantId: string, key: string, context: RequestContext): Promise<boolean> {
    return await ErrorHandler.tryCatch(
      () => this.removeDocument(this.getFilePath(tenantId, key, context), key),
      {
        operation: 'FileSystemProvider.delete',
        context,
        input: { tenantId, key },
      },
    );
  }

  async list(
    tenantId: string,
    prefix: string,
    context: RequestContext,
    options?: ListOptions,
  ): Promise<ListResult> {
    return await ErrorHandler.tryCatch(
      async () => {
        const candidates = await this.listFiles(this.getTenantPath(tenantId, context), prefix);

        // TTL-aware filtering: reads each file to check expiration.
        // Retains parsed values to populate ListResult.values, avoiding
        // a redundant getMany() in ContextState.list().
        const validKeys: string[] = [];
        const validValues = new Map<string, unknown>();
        for (const { filePath, key } of candidates) {
          try {
            const raw = await readFile(filePath, 'utf-8');
            const value = await this.parseAndValidate<unknown>(raw, tenantId, key, filePath);
            if (value !== null) {
              validKeys.push(key);
              validValues.set(key, value);
            }
          } catch (_e) {}
        }

        validKeys.sort();
        const lastKey = options?.cursor
          ? decodeCursor(options.cursor, tenantId, context)
          : undefined;
        const { keys: paginatedKeys, nextCursor } = paginateSortedKeys(
          validKeys,
          tenantId,
          lastKey,
          options?.limit ?? DEFAULT_LIST_LIMIT,
        );

        // Build a values map for the paginated slice only.
        const paginatedValues = new Map<string, unknown>();
        for (const k of paginatedKeys) {
          const v = validValues.get(k);
          if (v !== undefined) paginatedValues.set(k, v);
        }

        return {
          keys: paginatedKeys,
          nextCursor,
          values: paginatedValues,
        };
      },
      {
        operation: 'FileSystemProvider.list',
        context,
        input: { tenantId, prefix },
      },
    );
  }

  async getMany<T>(
    tenantId: string,
    keys: string[],
    context: RequestContext,
  ): Promise<Map<string, T>> {
    return await ErrorHandler.tryCatch(
      () => {
        // Every name is checked before the first read, which removes an expired file.
        for (const key of keys) storedNames(key);
        return getManyViaGet(keys, (key) => this.get<T>(tenantId, key, context));
      },
      {
        operation: 'FileSystemProvider.getMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  async setMany(
    tenantId: string,
    entries: Map<string, unknown>,
    context: RequestContext,
    options?: StorageOptions,
  ): Promise<void> {
    return await ErrorHandler.tryCatch(
      () => {
        // Every value is encoded and every name checked before the first write.
        const documents = encodeEntries(entries, (key, value) =>
          encodeEnvelope(serializeValue(key, value), options),
        );
        for (const key of documents.keys()) storedNames(key);
        return setManyViaSet(documents, (key, document) =>
          this.writeDocument(this.getFilePath(tenantId, key, context), key, document),
        );
      },
      {
        operation: 'FileSystemProvider.setMany',
        context,
        input: { tenantId, entryCount: entries.size },
      },
    );
  }

  async deleteMany(tenantId: string, keys: string[], context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      () => {
        // Every name is checked before the first delete.
        for (const key of keys) storedNames(key);
        return deleteManyViaDelete(keys, (key) => this.delete(tenantId, key, context));
      },
      {
        operation: 'FileSystemProvider.deleteMany',
        context,
        input: { tenantId, keyCount: keys.length },
      },
    );
  }

  async clear(tenantId: string, context: RequestContext): Promise<number> {
    return await ErrorHandler.tryCatch(
      async () => {
        const stored = await this.listFiles(this.getTenantPath(tenantId, context), '');
        let deletedCount = 0;
        for (const { filePath, key } of stored) {
          if (await this.removeDocument(filePath, key)) deletedCount++;
        }
        return deletedCount;
      },
      {
        operation: 'FileSystemProvider.clear',
        context,
        input: { tenantId },
      },
    );
  }
}
