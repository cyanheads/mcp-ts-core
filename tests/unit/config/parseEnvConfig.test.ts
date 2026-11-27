/**
 * @fileoverview Unit tests for parseEnvConfig helper.
 * @module tests/unit/config/parseEnvConfig.test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { parseEnvConfig } from '../../../src/config/parseEnvConfig.js';
import { JsonRpcErrorCode, McpError } from '../../../src/types-global/errors.js';

const Schema = z.object({
  apiKey: z.string().describe('External API key'),
  maxResults: z.coerce.number().default(100),
  enabled: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
});

const envMap = {
  apiKey: 'MY_API_KEY',
  maxResults: 'MY_MAX_RESULTS',
  enabled: 'MY_ENABLED',
};

describe('parseEnvConfig', () => {
  it('parses valid env into typed config', () => {
    const env = { MY_API_KEY: 'sk-123', MY_MAX_RESULTS: '50', MY_ENABLED: 'true' };
    const result = parseEnvConfig(Schema, envMap, env);
    expect(result).toEqual({ apiKey: 'sk-123', maxResults: 50, enabled: true });
  });

  it('applies Zod defaults when env var absent', () => {
    const env = { MY_API_KEY: 'sk-123' };
    const result = parseEnvConfig(Schema, envMap, env);
    expect(result.maxResults).toBe(100);
  });

  it('throws ConfigurationError naming the env var when required field missing', () => {
    const env = {};
    try {
      parseEnvConfig(Schema, envMap, env);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect(mcpErr.message).toContain('MY_API_KEY');
      expect(mcpErr.message).toContain('apiKey');
    }
  });

  it('includes the env var name in structured data.issues', () => {
    try {
      parseEnvConfig(Schema, envMap, {});
      expect.fail('should have thrown');
    } catch (err) {
      const mcpErr = err as McpError;
      const issues = mcpErr.data?.issues as Array<{ envVar: string; path: string }>;
      expect(issues).toBeDefined();
      expect(issues[0]?.envVar).toBe('MY_API_KEY');
      expect(issues[0]?.path).toBe('apiKey');
    }
  });

  it('reports multiple missing env vars in one error', () => {
    const RequireTwo = z.object({
      apiKey: z.string(),
      secret: z.string(),
    });
    const map = { apiKey: 'MY_API_KEY', secret: 'MY_SECRET' };
    try {
      parseEnvConfig(RequireTwo, map, {});
      expect.fail('should have thrown');
    } catch (err) {
      const mcpErr = err as McpError;
      expect(mcpErr.message).toContain('MY_API_KEY');
      expect(mcpErr.message).toContain('MY_SECRET');
    }
  });

  it('falls back to the schema path when no envMap entry exists', () => {
    const WithExtra = z.object({
      apiKey: z.string(),
      unmapped: z.string(),
    });
    const partialMap = { apiKey: 'MY_API_KEY' };
    try {
      parseEnvConfig(WithExtra, partialMap, { MY_API_KEY: 'x' });
      expect.fail('should have thrown');
    } catch (err) {
      const mcpErr = err as McpError;
      // When envMap has no entry, the schema path itself is shown.
      expect(mcpErr.message).toContain('unmapped');
    }
  });

  describe('a failure inside a field (#628)', () => {
    /** The `ConfigurationError` `parseEnvConfig` throws for `env`. */
    function rejection<T extends z.ZodType>(
      schema: T,
      map: Record<string, string>,
      env: Record<string, string>,
    ): McpError {
      try {
        parseEnvConfig(schema, map, env);
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
        return err as McpError;
      }
      return expect.fail('should have thrown');
    }

    it('names the variable behind an array element a transform and pipe produced', () => {
      const Endpoints = z.object({
        endpoints: z
          .string()
          .transform((s) => s.split(',').map((url) => ({ url })))
          .pipe(z.array(z.object({ url: z.string().url() }))),
      });
      const error = rejection(
        Endpoints,
        { endpoints: 'MY_ENDPOINTS' },
        { MY_ENDPOINTS: 'not-a-url' },
      );

      expect(error.message).toBe(
        'Server config validation failed:\n  - MY_ENDPOINTS (endpoints.0.url): Invalid URL',
      );
      expect(error.data?.issues).toEqual([
        expect.objectContaining({ envVar: 'MY_ENDPOINTS', path: 'endpoints.0.url' }),
      ]);
    });

    it('names the variable behind a field of an object parsed from one JSON value', () => {
      const Nested = z.object({
        db: z.preprocess(
          (v) => JSON.parse(String(v)),
          z.object({ host: z.string(), port: z.coerce.number().int() }),
        ),
      });
      const error = rejection(
        Nested,
        { db: 'MY_DB_JSON' },
        { MY_DB_JSON: '{"host":"h","port":"x"}' },
      );

      expect(error.message).toBe(
        'Server config validation failed:\n  - MY_DB_JSON (db.port): Invalid input: expected number, received NaN',
      );
      expect(error.data?.issues).toEqual([
        expect.objectContaining({ envVar: 'MY_DB_JSON', path: 'db.port' }),
      ]);
    });

    it('reports a root-level refinement under its empty path', () => {
      const Paired = z
        .object({ min: z.coerce.number(), max: z.coerce.number() })
        .refine((c) => c.min <= c.max, { message: 'MY_MIN must not exceed MY_MAX' });
      const error = rejection(
        Paired,
        { min: 'MY_MIN', max: 'MY_MAX' },
        { MY_MIN: '5', MY_MAX: '1' },
      );

      expect(error.message).toBe(
        'Server config validation failed:\n  -  (): MY_MIN must not exceed MY_MAX',
      );
      expect(error.data?.issues).toEqual([expect.objectContaining({ envVar: '', path: '' })]);
    });

    it('never resolves a path through a key the map only inherits', () => {
      const Inherited = z.object({ constructor: z.string() });
      const error = rejection(Inherited, {}, {});

      expect(error.message).toContain('  - constructor (constructor): ');
    });
  });

  describe('values that mean "not provided"', () => {
    // Built without a template-literal-shaped string so Biome's
    // noTemplateCurlyInString does not flag a deliberate placeholder.
    const placeholder = (name: string) => ['$', '{', name, '}'].join('');

    it('treats an unsubstituted placeholder on a required field as missing', () => {
      const env = { MY_API_KEY: placeholder('user_config.api_key') };
      try {
        parseEnvConfig(Schema, envMap, env);
        expect.fail('should have thrown');
      } catch (err) {
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(JsonRpcErrorCode.ConfigurationError);
        expect(mcpErr.message).toContain('MY_API_KEY');
        expect(mcpErr.message).not.toContain('user_config');
      }
    });

    it('treats an unsubstituted placeholder on an optional field as unset', () => {
      const Optional = z.object({ email: z.email().optional() });
      const result = parseEnvConfig(
        Optional,
        { email: 'MY_EMAIL' },
        { MY_EMAIL: placeholder('MY_EMAIL') },
      );
      expect(result.email).toBeUndefined();
    });

    it('lets a placeholder fall through to the field default', () => {
      const env = { MY_API_KEY: 'sk-123', MY_MAX_RESULTS: placeholder('user_config.max') };
      expect(parseEnvConfig(Schema, envMap, env).maxResults).toBe(100);
    });

    it('treats an empty string as unset', () => {
      const env = { MY_API_KEY: 'sk-123', MY_MAX_RESULTS: '' };
      expect(parseEnvConfig(Schema, envMap, env).maxResults).toBe(100);
    });

    it('passes a value that merely contains a placeholder through unchanged', () => {
      const inner = `prefix-${placeholder('x')}-suffix`;
      const env = { MY_API_KEY: inner };
      expect(parseEnvConfig(Schema, envMap, env).apiKey).toBe(inner);
    });
  });

  it('defaults to process.env when env argument is omitted', () => {
    // Reading process.env reaches the .env load; keep it off the developer's file.
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    const prev = process.env.MY_API_KEY;
    process.env.MY_API_KEY = 'from-process';
    try {
      const result = parseEnvConfig(Schema, envMap);
      expect(result.apiKey).toBe('from-process');
    } finally {
      load.mockRestore();
      if (prev === undefined) {
        delete process.env.MY_API_KEY;
      } else {
        process.env.MY_API_KEY = prev;
      }
    }
  });
});

describe('parseEnvConfig reads ./.env before process.env (#634)', () => {
  const RUNTIME_MODULE = '../../../src/utils/internal/runtime.js';
  /** The object `process.loadEnvFile()` writes to; tests below make it `process.env`. */
  const liveEnv = process.env;
  const KEYS = ['ENVFILE_PROBE_API_KEY', 'ENVFILE_PROBE_BASE_DIR'] as const;
  const ProbeSchema = z.object({
    apiKey: z.string(),
    baseDir: z.string().optional(),
  });
  const probeMap = { apiKey: 'ENVFILE_PROBE_API_KEY', baseDir: 'ENVFILE_PROBE_BASE_DIR' };

  const tempDirs: string[] = [];
  const saved = new Map<string, string | undefined>();

  /** A fresh directory, removed after the test, holding `.env` as a file with `contents` or as a directory. */
  const envDir = (contents: string | 'directory'): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-parse-env-'));
    tempDirs.push(dir);
    if (contents === 'directory') mkdirSync(join(dir, '.env'));
    else writeFileSync(join(dir, '.env'), contents);
    return dir;
  };

  /**
   * Runs `fn` with `dir` as the working directory, so the unmocked
   * `process.loadEnvFile()` reads `<dir>/.env`. Synchronous, so nothing else
   * runs while the directory is changed.
   */
  const inDir = <T>(dir: string, fn: () => T): T => {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(previous);
    }
  };

  /** Fresh module instances: the loaded-once flag is module state. */
  const freshModules = async () => {
    vi.resetModules();
    const [{ parseEnvConfig: parse }, { parseConfig }] = await Promise.all([
      import('../../../src/config/parseEnvConfig.js'),
      import('../../../src/config/index.js'),
    ]);
    return { parse, parseConfig };
  };

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, liveEnv[key]);
      delete liveEnv[key];
    }
    process.env = liveEnv;
  });

  afterEach(() => {
    vi.doUnmock(RUNTIME_MODULE);
    vi.restoreAllMocks();
    process.env = liveEnv;
    for (const [key, value] of saved) {
      if (value === undefined) delete liveEnv[key];
      else liveEnv[key] = value;
    }
    saved.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // #562's scenario: a server-config read before createApp() — a module-scope
  // gate, a z.lazy bound — sees a value set only in .env.
  it('sees a value set only in .env when no env argument is passed', async () => {
    const dir = envDir('ENVFILE_PROBE_API_KEY=from-dotenv\nENVFILE_PROBE_BASE_DIR=/srv/repos\n');
    const { parse } = await freshModules();

    const result = inDir(dir, () => parse(ProbeSchema, probeMap));

    expect(result).toEqual({ apiKey: 'from-dotenv', baseDir: '/srv/repos' });
  });

  it('loads .env when passed process.env explicitly', async () => {
    const dir = envDir('ENVFILE_PROBE_API_KEY=from-dotenv\n');
    const { parse } = await freshModules();

    expect(inDir(dir, () => parse(ProbeSchema, probeMap, process.env)).apiKey).toBe('from-dotenv');
  });

  it('keeps a value already in the process environment over .env', async () => {
    const dir = envDir('ENVFILE_PROBE_API_KEY=from-dotenv\nENVFILE_PROBE_BASE_DIR=/srv/repos\n');
    liveEnv.ENVFILE_PROBE_BASE_DIR = '/from-process';
    const { parse } = await freshModules();

    const result = inDir(dir, () => parse(ProbeSchema, probeMap));

    expect(result).toEqual({ apiKey: 'from-dotenv', baseDir: '/from-process' });
  });

  it('never loads .env when reading an env object other than process.env', async () => {
    const load = vi.spyOn(process, 'loadEnvFile');
    const { parse } = await freshModules();

    expect(parse(ProbeSchema, probeMap, { ENVFILE_PROBE_API_KEY: 'given' }).apiKey).toBe('given');
    expect(load).not.toHaveBeenCalled();
  });

  it('loads .env at most once together with framework config', async () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      liveEnv.ENVFILE_PROBE_API_KEY ??= 'from-dotenv';
    });
    const { parse, parseConfig } = await freshModules();

    parse(ProbeSchema, probeMap);
    expect(load).toHaveBeenCalledTimes(1);
    parseConfig();
    parse(ProbeSchema, probeMap);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never throws a .env load failure, which the next framework config read retries and reports', async () => {
    const dir = envDir('directory');
    liveEnv.ENVFILE_PROBE_API_KEY = 'from-process';
    const load = vi.spyOn(process, 'loadEnvFile');
    const { parse, parseConfig } = await freshModules();

    const outcome = inDir(dir, () => {
      const parsed = parse(ProbeSchema, probeMap);
      let configError: unknown;
      try {
        parseConfig();
      } catch (error) {
        configError = error;
      }
      return { parsed, configError };
    });

    expect(outcome.parsed.apiKey).toBe('from-process');
    // A fresh module graph has its own McpError class, so match the fields.
    expect(outcome.configError).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: 'Failed to load .env from the working directory.',
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never loads .env on a Worker', async () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock(RUNTIME_MODULE, async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../../src/utils/internal/runtime.js')>();
      return { runtimeCaps: { ...actual.runtimeCaps, isWorkerLike: true } };
    });
    const { parseEnvConfig: workerParse } = await import('../../../src/config/parseEnvConfig.js');
    liveEnv.ENVFILE_PROBE_API_KEY = 'from-bindings';

    expect(workerParse(ProbeSchema, probeMap).apiKey).toBe('from-bindings');
    expect(load).not.toHaveBeenCalled();
  });
});
