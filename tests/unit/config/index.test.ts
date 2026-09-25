/**
 * @fileoverview Unit tests for configuration parsing.
 * @module tests/config/index.test
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../src/types-global/errors.js';

// Native `process.loadEnvFile()` writes to the live env object, which the
// `process.env = { ... }` resets below replace with a plain copy.
const liveEnv = process.env;
const originalEnv = { ...process.env };
const originalIsTTY = process.stdout.isTTY;

let parseConfig: typeof import('../../../src/config/index.js').parseConfig;

beforeAll(async () => {
  ({ parseConfig } = await import('../../../src/config/index.js'));
});

describe('config parsing', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.stdout.isTTY = originalIsTTY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.stdout.isTTY = originalIsTTY;
  });

  it('normalizes aliases, trims arrays, and applies defaults', async () => {
    process.env.MCP_LOG_LEVEL = 'Warning';
    process.env.NODE_ENV = 'prod';
    process.env.MCP_ALLOWED_ORIGINS = 'https://a.example.com, https://b.example.com ';
    process.env.DEV_MCP_SCOPES = 'scope:read, scope:write';
    process.env.STORAGE_PROVIDER_TYPE = 'fs';
    process.env.MCP_SESSION_MODE = ''; // exercise empty-string sanitization
    process.env.OTEL_ENABLED = 'true';
    process.env.OTEL_LOG_LEVEL = 'warning';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.5';
    process.env.OPENROUTER_APP_URL = 'https://app.example.com';
    delete process.env.OPENROUTER_APP_NAME;
    delete process.env.LOGS_DIR;
    process.env.LLM_DEFAULT_TEMPERATURE = '0.7';

    const parsed = parseConfig();

    expect(parsed.logLevel).toBe('warning');
    expect(parsed.environment).toBe('production');
    expect(parsed.mcpSessionMode).toBe('auto');
    expect(parsed.mcpAllowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(parsed.devMcpScopes).toEqual(['scope:read', 'scope:write']);
    expect(parsed.storage.providerType).toBe('filesystem');
    expect(parsed.logsPath).toMatch(/logs$/);
    expect(parsed.openTelemetry.enabled).toBe(true);
    expect(parsed.openTelemetry.logLevel).toBe('WARN');
    expect(parsed.openTelemetry.samplingRatio).toBe(0.5);
    expect(parsed.openrouterAppUrl).toBe('https://app.example.com');
    expect(parsed.openrouterAppName).toBe('@cyanheads/mcp-ts-core');
    expect(parsed.llmDefaultTemperature).toBeCloseTo(0.7);
  });

  it('derives mcpServerKeywords from PACKAGE_KEYWORDS (comma-split, trimmed, empties dropped)', () => {
    process.env.PACKAGE_KEYWORDS = 'health, medical ,epidemiology,';
    const parsed = parseConfig();
    expect(parsed.mcpServerKeywords).toEqual(['health', 'medical', 'epidemiology']);
  });

  it('rejects DEV_MCP_AUTH_BYPASS=true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_MCP_AUTH_BYPASS = 'true';
    process.env.MCP_AUTH_MODE = 'jwt';
    process.env.MCP_AUTH_SECRET_KEY = 'a-secret-key-that-is-at-least-32-chars';

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const mcpError = thrown as McpError;
    expect(mcpError.code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('allows DEV_MCP_AUTH_BYPASS=true in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_MCP_AUTH_BYPASS = 'true';
    process.env.MCP_AUTH_MODE = 'jwt';

    const parsed = parseConfig();
    expect(parsed.devMcpAuthBypass).toBe(true);
  });

  it('treats DEV_MCP_AUTH_BYPASS=false as disabled (not truthy-coerced)', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_AUTH_MODE = 'jwt';
    process.env.MCP_AUTH_SECRET_KEY = 'a-secret-key-that-is-at-least-32-chars';

    for (const value of ['false', '0', 'no', 'FALSE']) {
      process.env.DEV_MCP_AUTH_BYPASS = value;
      const parsed = parseConfig();
      expect(parsed.devMcpAuthBypass).toBe(false);
    }
  });

  it('rejects MCP_AUTH_MODE=jwt without a secret key when the dev bypass is off', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_AUTH_MODE = 'jwt';
    delete process.env.MCP_AUTH_SECRET_KEY;
    delete process.env.DEV_MCP_AUTH_BYPASS;

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('rejects an MCP_AUTH_SECRET_KEY shorter than 32 characters in jwt mode', () => {
    // A short HMAC key is brute-forceable; the 32-char floor is a security guard.
    process.env.NODE_ENV = 'development';
    process.env.MCP_AUTH_MODE = 'jwt';
    process.env.MCP_AUTH_SECRET_KEY = 'too-short-key';
    delete process.env.DEV_MCP_AUTH_BYPASS;

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('accepts a 32+ character secret key in jwt mode', () => {
    process.env.NODE_ENV = 'production';
    process.env.MCP_AUTH_MODE = 'jwt';
    process.env.MCP_AUTH_SECRET_KEY = 'a-secret-key-that-is-at-least-32-chars';
    delete process.env.DEV_MCP_AUTH_BYPASS;

    const parsed = parseConfig();
    expect(parsed.mcpAuthMode).toBe('jwt');
  });

  it('rejects MCP_AUTH_MODE=oauth without an issuer URL and audience', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_AUTH_MODE = 'oauth';
    delete process.env.OAUTH_ISSUER_URL;
    delete process.env.OAUTH_AUDIENCE;

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('accepts MCP_AUTH_MODE=oauth with an issuer URL and audience', () => {
    process.env.NODE_ENV = 'production';
    process.env.MCP_AUTH_MODE = 'oauth';
    process.env.OAUTH_ISSUER_URL = 'https://issuer.example.com/';
    process.env.OAUTH_AUDIENCE = 'https://api.example.com';

    const parsed = parseConfig();
    expect(parsed.mcpAuthMode).toBe('oauth');
    expect(parsed.oauthIssuerUrl).toBe('https://issuer.example.com/');
    expect(parsed.oauthAudience).toBe('https://api.example.com');
  });

  it('parses env boolean flags via stringbool (the z.coerce.boolean footgun fix)', () => {
    for (const value of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
      process.env.OTEL_ENABLED = value;
      expect(parseConfig().openTelemetry.enabled, `OTEL_ENABLED=${value}`).toBe(false);
    }
    for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'On']) {
      process.env.OTEL_ENABLED = value;
      expect(parseConfig().openTelemetry.enabled, `OTEL_ENABLED=${value}`).toBe(true);
    }
  });

  it('defaults env boolean flags to false when unset or empty', () => {
    delete process.env.OTEL_ENABLED;
    expect(parseConfig().openTelemetry.enabled).toBe(false);
    process.env.OTEL_ENABLED = '';
    expect(parseConfig().openTelemetry.enabled).toBe(false);
  });

  it('rejects an unrecognized env boolean value instead of silently coercing it', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTEL_ENABLED = 'enable'; // plausible typo for "enabled" — must fail loudly

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    consoleSpy.mockRestore();
  });

  it('parses MCP_PUBLIC_URL when set, defaults to undefined', () => {
    expect(parseConfig().mcpPublicUrl).toBeUndefined();

    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com';
    expect(parseConfig().mcpPublicUrl).toBe('https://mcp.example.com');

    process.env.MCP_PUBLIC_URL = '';
    expect(parseConfig().mcpPublicUrl).toBeUndefined();
  });

  // Overrides merge over process.env and an empty value reads as unset, so these
  // cases hold regardless of what the ambient env or a local .env carries.
  it('applies defaults when the core variables are unset', () => {
    const parsed = parseConfig({
      NODE_ENV: '',
      MCP_LOG_LEVEL: '',
      MCP_HTTP_PORT: '',
      STORAGE_PROVIDER_TYPE: '',
      STORAGE_FILESYSTEM_PATH: '',
    });

    expect(parsed.environment).toBe('development');
    expect(parsed.logLevel).toBe('debug');
    expect(parsed.mcpHttpPort).toBe(3010);
    expect(parsed.storage).toEqual({ providerType: 'in-memory', filesystemPath: './.storage' });
  });

  it.each([
    ['NODE_ENV', 'dev', (c: ReturnType<typeof parseConfig>) => c.environment, 'development'],
    ['NODE_ENV', 'test', (c: ReturnType<typeof parseConfig>) => c.environment, 'testing'],
    [
      'STORAGE_PROVIDER_TYPE',
      'mem',
      (c: ReturnType<typeof parseConfig>) => c.storage.providerType,
      'in-memory',
    ],
  ])('normalizes %s=%s', (name, value, read, expected) => {
    expect(read(parseConfig({ [name]: value }))).toBe(expected);
  });

  it('reads STORAGE_FILESYSTEM_PATH into storage.filesystemPath', () => {
    const parsed = parseConfig({
      STORAGE_PROVIDER_TYPE: 'filesystem',
      STORAGE_FILESYSTEM_PATH: '/tmp/test-storage',
    });
    expect(parsed.storage).toEqual({
      providerType: 'filesystem',
      filesystemPath: '/tmp/test-storage',
    });
  });

  describe('supabase', () => {
    it('builds the block from SUPABASE_URL and the service role key', () => {
      const parsed = parseConfig({
        SUPABASE_URL: 'https://supabase.example.com',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_ANON_KEY: '',
      });
      expect(parsed.supabase).toEqual({
        url: 'https://supabase.example.com',
        serviceRoleKey: 'service-role-key',
      });
    });

    it('carries the optional anon key through for a server-owned public client', () => {
      const parsed = parseConfig({
        SUPABASE_URL: 'https://supabase.example.com',
        SUPABASE_ANON_KEY: 'anon-key',
        SUPABASE_SERVICE_ROLE_KEY: '',
      });
      expect(parsed.supabase).toEqual({
        url: 'https://supabase.example.com',
        anonKey: 'anon-key',
      });
    });

    it('leaves supabase unset without SUPABASE_URL', () => {
      const parsed = parseConfig({
        SUPABASE_URL: '',
        SUPABASE_ANON_KEY: 'anon-key',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      });
      expect(parsed.supabase).toBeUndefined();
    });
  });

  it('builds speech configuration for enabled providers', () => {
    const parsed = parseConfig({
      SPEECH_TTS_ENABLED: 'true',
      SPEECH_TTS_PROVIDER: 'elevenlabs',
      SPEECH_TTS_API_KEY: 'tts-key',
      SPEECH_TTS_BASE_URL: 'https://tts.example.com',
      SPEECH_TTS_DEFAULT_VOICE_ID: 'voice-1',
      SPEECH_TTS_DEFAULT_MODEL_ID: 'model-1',
      SPEECH_TTS_TIMEOUT: '2000',
      SPEECH_STT_ENABLED: 'true',
      SPEECH_STT_PROVIDER: 'openai-whisper',
      SPEECH_STT_API_KEY: 'stt-key',
      SPEECH_STT_BASE_URL: 'https://stt.example.com',
      SPEECH_STT_DEFAULT_MODEL_ID: 'whisper-1',
      SPEECH_STT_TIMEOUT: '4000',
    });

    expect(parsed.speech).toEqual({
      tts: {
        enabled: true,
        provider: 'elevenlabs',
        apiKey: 'tts-key',
        baseUrl: 'https://tts.example.com',
        defaultVoiceId: 'voice-1',
        defaultModelId: 'model-1',
        timeout: 2000,
      },
      stt: {
        enabled: true,
        provider: 'openai-whisper',
        apiKey: 'stt-key',
        baseUrl: 'https://stt.example.com',
        defaultModelId: 'whisper-1',
        timeout: 4000,
      },
    });
  });

  describe('unsubstituted placeholders read as unset', () => {
    // An install-time host (MCPB, a plugin manifest) that never substitutes a
    // placeholder hands the server the literal `${…}` text. Built without a
    // template-literal-shaped string so Biome's noTemplateCurlyInString stays quiet.
    const placeholder = (name: string) => ['$', '{', name, '}'].join('');

    it('leaves an optional URL field undefined instead of failing z.url()', () => {
      process.env.MCP_PUBLIC_URL = placeholder('user_config.public_url');
      expect(parseConfig().mcpPublicUrl).toBeUndefined();
    });

    it('reports a placeholder secret in jwt mode as the key being missing', () => {
      process.env.NODE_ENV = 'development';
      process.env.MCP_AUTH_MODE = 'jwt';
      process.env.MCP_AUTH_SECRET_KEY = placeholder('MCP_AUTH_SECRET_KEY');
      delete process.env.DEV_MCP_AUTH_BYPASS;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let thrown: unknown;
      try {
        parseConfig();
      } catch (error) {
        thrown = error;
      }
      consoleSpy.mockRestore();

      expect(thrown).toBeInstanceOf(McpError);
      const fieldErrors = (thrown as McpError).data?.validationErrors as Record<string, string[]>;
      expect(fieldErrors.mcpAuthSecretKey?.[0]).toContain('MCP_AUTH_SECRET_KEY is required');
    });

    it('falls through to the enum default', () => {
      process.env.MCP_SESSION_MODE = placeholder('user_config.session_mode');
      expect(parseConfig().mcpSessionMode).toBe('auto');
    });

    it('keeps a value that merely contains a placeholder', () => {
      const path = `/srv/${placeholder('TENANT')}/logs`;
      process.env.LOGS_DIR = path;
      expect(parseConfig().logsPath).toBe(path);
    });
  });

  describe('OTLP endpoint resolution', () => {
    // Values ride the overrides argument so a local .env can never contribute one.
    const otlp = (env: Record<string, string>) => parseConfig(env).openTelemetry;

    beforeEach(() => {
      for (const signal of ['', 'TRACES_', 'METRICS_', 'LOGS_']) {
        delete process.env[`OTEL_EXPORTER_OTLP_${signal}ENDPOINT`];
      }
    });

    it('derives both signal URLs from the base endpoint', () => {
      const { tracesEndpoint, metricsEndpoint } = otlp({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      });
      expect(tracesEndpoint).toBe('http://collector:4318/v1/traces');
      expect(metricsEndpoint).toBe('http://collector:4318/v1/metrics');
    });

    it.each([
      ['a trailing slash', 'http://collector:4318/', 'http://collector:4318/v1/traces'],
      ['a path prefix', 'http://collector/otlp', 'http://collector/otlp/v1/traces'],
      [
        'a path prefix and trailing slash',
        'http://collector/otlp/',
        'http://collector/otlp/v1/traces',
      ],
    ])('joins a base with %s without doubling the slash', (_label, base, expected) => {
      expect(otlp({ OTEL_EXPORTER_OTLP_ENDPOINT: base }).tracesEndpoint).toBe(expected);
    });

    it('uses a signal-specific endpoint as-is, overriding the base for that signal only', () => {
      const { tracesEndpoint, metricsEndpoint } = otlp({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/ingest',
      });
      expect(tracesEndpoint).toBe('https://traces.example.com/ingest');
      expect(metricsEndpoint).toBe('http://collector:4318/v1/metrics');
    });

    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
      ['an unsubstituted placeholder', ['$', '{', 'user_config.otlp_endpoint', '}'].join('')],
    ])('treats %s base as unset', (_label, base) => {
      const { tracesEndpoint, metricsEndpoint } = otlp({ OTEL_EXPORTER_OTLP_ENDPOINT: base });
      expect(tracesEndpoint).toBeUndefined();
      expect(metricsEndpoint).toBeUndefined();
    });

    it('resolves no endpoint when none is set', () => {
      const { tracesEndpoint, metricsEndpoint } = otlp({});
      expect(tracesEndpoint).toBeUndefined();
      expect(metricsEndpoint).toBeUndefined();
    });
  });

  it('rejects MCP_PUBLIC_URL that is not a valid URL', () => {
    process.env.MCP_PUBLIC_URL = 'not-a-url';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.stdout.isTTY = true;

    expect(() => parseConfig()).toThrow(McpError);
    consoleSpy.mockRestore();
  });

  it('throws a configuration error when validation fails', async () => {
    // Mock console.error BEFORE setting isTTY to suppress output during tests
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.env.MCP_LOG_LEVEL = 'invalid-level';
    process.stdout.isTTY = true;

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const mcpError = thrown as McpError;
    expect(mcpError.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(consoleSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration found. Please check your environment variables.',
      expect.any(Object),
    );

    consoleSpy.mockRestore();
  });
});

describe('.env loading', () => {
  const errnoError = (code: string) => Object.assign(new Error(code), { code });

  /** Fresh module instance — the loaded-once flag is module state. */
  const freshParseConfig = async () => {
    vi.resetModules();
    return (await import('../../../src/config/index.js')).parseConfig;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('loads .env values without overriding variables already set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'MCP_LOG_LEVEL=error\nMCP_HTTP_HOST=10.0.0.9\n');
    const nativeLoad = process.loadEnvFile.bind(process);
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => nativeLoad(envPath));
    process.env = liveEnv;
    delete process.env.MCP_LOG_LEVEL;
    process.env.MCP_HTTP_HOST = '127.0.0.2';

    try {
      const config = (await freshParseConfig())();
      expect(config.logLevel).toBe('error');
      expect(config.mcpHttpHost).toBe('127.0.0.2');
    } finally {
      delete liveEnv.MCP_LOG_LEVEL;
      delete liveEnv.MCP_HTTP_HOST;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the file once and tolerates a missing .env', async () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw errnoError('ENOENT');
    });
    const parse = await freshParseConfig();

    expect(() => parse()).not.toThrow();
    parse();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('skips the file when parsing with explicit overrides', async () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    const parse = await freshParseConfig();

    parse({ MCP_LOG_LEVEL: 'info' });
    expect(load).not.toHaveBeenCalled();
  });

  it('surfaces any other read failure as a configuration error', async () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw errnoError('EACCES');
    });
    const parse = await freshParseConfig();

    let thrown: unknown;
    try {
      parse();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect((thrown as McpError).cause).toMatchObject({ code: 'EACCES' });
  });
});
