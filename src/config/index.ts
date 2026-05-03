/**
 * @fileoverview Loads, validates, and exports application configuration.
 * This module centralizes configuration management, sourcing values from
 * environment variables. It uses Zod for schema validation to ensure type safety
 * and correctness of configuration parameters, and is designed to be
 * environment-agnostic (e.g., Node.js, Cloudflare Workers).
 *
 * @module src/config/index
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };
import { configurationError } from '../types-global/errors.js';
import { runtimeCaps } from '../utils/internal/runtime.js';

type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
};

const frameworkPkg = packageJson as PackageManifest;

/** Framework identity — sourced from the package's own package.json. */
export const FRAMEWORK_NAME = '@cyanheads/mcp-ts-core';
export const FRAMEWORK_VERSION = frameworkPkg.version ?? '0.0.0';

/**
 * Lazily reads the consumer project's package.json from process.cwd().
 * Cached after first call — the consumer's identity doesn't change at runtime.
 * Returns an empty object in Workers or if the file can't be read.
 */
let _consumerPkg: PackageManifest | null = null;
function resolveConsumerPackage(): PackageManifest {
  if (_consumerPkg !== null) return _consumerPkg;
  const pkg: PackageManifest = {};
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.name === 'string') pkg.name = parsed.name;
    if (typeof parsed.version === 'string') pkg.version = parsed.version;
    if (typeof parsed.description === 'string') pkg.description = parsed.description;
  } catch {
    // No consumer package.json found — will fall through to framework defaults
  }
  _consumerPkg = pkg;
  return pkg;
}

// Lazy dotenv loading — deferred to first parseConfig() call.
// Top-level execution wastes a filesystem syscall in Workers and loads stale
// .env before test setup can configure the environment.
let _dotenvLoaded = false;

// --- Helper Functions ---
const emptyStringAsUndefined = (val: unknown) => {
  if (typeof val === 'string' && val.trim() === '') {
    return;
  }
  return val;
};

/** Parses string booleans from env vars correctly (`"false"` → `false`). */
const envBoolean = z.preprocess((val) => {
  if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
  return val;
}, z.boolean());

// --- Schema Definition ---
const ConfigSchema = z
  .object({
    // Package information sourced from environment variables
    pkg: z.object({
      name: z.string(),
      version: z.string(),
      description: z.string().optional(),
    }),
    mcpServerName: z.string(), // Will be derived from pkg.name
    mcpServerVersion: z.string(), // Will be derived from pkg.version
    mcpServerDescription: z.string().optional(), // Will be derived from pkg.description
    mcpServerHomepage: z.string().optional(), // Will be derived from pkg.homepage
    logLevel: z
      .preprocess(
        (val) => {
          const str = emptyStringAsUndefined(val);
          if (typeof str === 'string') {
            const lower = str.toLowerCase();
            // Normalize common aliases to RFC5424/MCP log level names
            const aliasMap: Record<string, string> = {
              warn: 'warning',
              err: 'error',
              information: 'info',
              fatal: 'emerg',
              trace: 'debug',
              silent: 'emerg',
            };
            return aliasMap[lower] ?? lower;
          }
          return str;
        },
        z.enum(['debug', 'info', 'notice', 'warning', 'error', 'crit', 'alert', 'emerg']),
      )
      .default('debug'),
    logsPath: z.string().optional(), // Made optional as it's Node-specific
    /**
     * When `true`, persists full LLM request/response transcripts to
     * `interactions.log`. Default `false` — transcripts contain user messages
     * and model completions that can include PII, secrets, or confidential
     * prompts; persisting them is a data-handling decision that must be
     * explicitly opted into. When `false`, interaction logs carry metadata
     * only (model, message count, token usage, duration).
     */
    logLlmInteractions: envBoolean.default(false),
    environment: z
      .preprocess(
        (val) => {
          const str = emptyStringAsUndefined(val);
          if (typeof str === 'string') {
            const lower = str.toLowerCase();
            const aliasMap: Record<string, string> = {
              dev: 'development',
              prod: 'production',
              test: 'testing',
            };
            return aliasMap[lower] ?? lower;
          }
          return str;
        },
        z.enum(['development', 'production', 'testing']),
      )
      .default('development'),
    mcpTransportType: z.preprocess(
      emptyStringAsUndefined,
      z.enum(['stdio', 'http']).default('stdio'),
    ),
    mcpSessionMode: z.preprocess(
      emptyStringAsUndefined,
      z.enum(['stateless', 'stateful', 'auto']).default('auto'),
    ),
    mcpResponseVerbosity: z.preprocess(
      emptyStringAsUndefined,
      z.enum(['minimal', 'standard', 'full']).default('standard'),
    ),
    mcpHttpPort: z.coerce.number().min(0).max(65535).default(3010),
    mcpHttpHost: z.string().default('127.0.0.1'),
    mcpHttpEndpointPath: z.string().default('/mcp'),
    /**
     * Public-facing origin of the server (e.g. `https://mcp.example.com`).
     * Overrides the inbound request URL when rendering self-referential
     * URLs — the landing page connect snippets, the SEP-1649 Server Card
     * `endpoints.streamable_http`, and the RFC 9728 `resource` fallback.
     * Required when running behind a TLS-terminating reverse proxy
     * (Cloudflare Tunnel, Caddy, nginx, ALB) so emitted URLs carry the
     * public `https://` scheme instead of the proxy-to-container `http://`.
     */
    mcpPublicUrl: z.preprocess(emptyStringAsUndefined, z.url().optional()),
    mcpHttpMaxPortRetries: z.coerce.number().default(15),
    mcpHttpPortRetryDelayMs: z.coerce.number().default(50),
    mcpStatefulSessionStaleTimeoutMs: z.coerce.number().default(1_800_000),
    mcpHeartbeatIntervalMs: z.coerce.number().min(0).default(0),
    mcpHeartbeatMissThreshold: z.coerce.number().min(1).default(3),
    mcpAllowedOrigins: z.array(z.string()).optional(),
    mcpAuthSecretKey: z.string().optional(),
    mcpJwtExpectedIssuer: z.string().optional(),
    mcpJwtExpectedAudience: z.string().optional(),
    mcpAuthMode: z.preprocess(
      emptyStringAsUndefined,
      z.enum(['jwt', 'oauth', 'none']).default('none'),
    ),
    oauthIssuerUrl: z.url().optional(),
    oauthJwksUri: z.url().optional(),
    oauthAudience: z.string().optional(),
    oauthJwksCooldownMs: z.coerce.number().default(300_000), // 5 minutes
    oauthJwksTimeoutMs: z.coerce.number().default(5_000), // 5 seconds
    mcpServerResourceIdentifier: z.url().optional(), // RFC 8707 resource indicator
    devMcpAuthBypass: z
      .preprocess((val) => {
        if (val === undefined || val === null || val === '') return false;
        const str = String(val).toLowerCase().trim();
        return str === 'true' || str === '1';
      }, z.boolean())
      .default(false),
    devMcpClientId: z.string().optional(),
    devMcpScopes: z.array(z.string()).optional(),
    openrouterAppUrl: z.string().default('http://localhost:3000'),
    openrouterAppName: z.string(),
    openrouterApiKey: z.string().optional(),
    llmDefaultModel: z.string().default('google/gemini-2.5-flash-preview-05-20'),
    llmDefaultTemperature: z.coerce.number().optional(),
    llmDefaultTopP: z.coerce.number().optional(),
    llmDefaultMaxTokens: z.coerce.number().optional(),
    llmDefaultTopK: z.coerce.number().optional(),
    llmDefaultMinP: z.coerce.number().optional(),
    oauthProxy: z
      .object({
        authorizationUrl: z.url().optional(),
        tokenUrl: z.url().optional(),
        revocationUrl: z.url().optional(),
        issuerUrl: z.url().optional(),
        serviceDocumentationUrl: z.url().optional(),
        defaultClientRedirectUris: z.array(z.string()).optional(),
      })
      .optional(),
    supabase: z
      .object({
        url: z.url(),
        anonKey: z.string(),
        serviceRoleKey: z.string().optional(),
      })
      .optional(),
    storage: z.object({
      providerType: z
        .preprocess(
          (val) => {
            const str = emptyStringAsUndefined(val);
            if (typeof str === 'string') {
              const lower = str.toLowerCase();
              const aliasMap: Record<string, string> = {
                mem: 'in-memory',
                fs: 'filesystem',
              };
              return aliasMap[lower] ?? lower;
            }
            return str;
          },
          z.enum([
            'in-memory',
            'filesystem',
            'supabase',
            'cloudflare-r2',
            'cloudflare-kv',
            'cloudflare-d1',
          ]),
        )
        .default('in-memory'),
      filesystemPath: z.string().default('./.storage'), // This remains, but will only be used if providerType is 'filesystem'
    }),
    // DataCanvas primitive configuration (issue #97)
    canvas: z
      .object({
        providerType: z.preprocess(
          emptyStringAsUndefined,
          z.enum(['none', 'duckdb']).default('none'),
        ),
        /**
         * Per-canvas DuckDB `memory_limit` PRAGMA value, in MB.
         * Applied at instance creation; one DuckDB instance per canvasId.
         */
        defaultMemoryLimitMb: z.coerce.number().min(64).default(1024),
        /**
         * Sandbox root for path-targeted exports. Path-based `export()` calls
         * are resolved relative to this directory and rejected if they escape
         * via `..` or absolute paths. Stream-based exports bypass this.
         */
        exportRootPath: z.string().default('./.canvas-exports'),
        /** Maximum active canvases per tenant before `RateLimited`. */
        maxCanvasesPerTenant: z.coerce.number().min(1).default(100),
        /** Sliding TTL in milliseconds. Default 24h. */
        ttlMs: z.coerce
          .number()
          .min(1000)
          .default(24 * 60 * 60 * 1000),
        /** Absolute cap from creation in milliseconds. Default 7d. */
        absoluteCapMs: z.coerce
          .number()
          .min(1000)
          .default(7 * 24 * 60 * 60 * 1000),
        /** Sweeper interval in milliseconds. Default 60s. Set to 0 to disable. */
        sweeperIntervalMs: z.coerce.number().min(0).default(60_000),
        /** Default row cap for `query()` results. */
        defaultRowLimit: z.coerce.number().min(1).default(10_000),
        /** Number of rows to sniff for schema inference when schema is omitted. */
        schemaSniffRows: z.coerce.number().min(1).default(100),
      })
      .refine((c) => c.absoluteCapMs >= c.ttlMs, {
        message:
          'CANVAS_ABSOLUTE_CAP_MS must be >= CANVAS_TTL_MS — otherwise canvases die at the absolute cap before the sliding TTL ever extends them.',
        path: ['absoluteCapMs'],
      }),
    // Experimental: Task store configuration
    tasks: z.object({
      storeType: z
        .preprocess(
          (val) => {
            const str = emptyStringAsUndefined(val);
            if (typeof str === 'string') {
              const lower = str.toLowerCase();
              const aliasMap: Record<string, string> = {
                mem: 'in-memory',
                memory: 'in-memory',
                persistent: 'storage',
              };
              return aliasMap[lower] ?? lower;
            }
            return str;
          },
          z.enum(['in-memory', 'storage']),
        )
        .default('in-memory'),
      tenantId: z.string().default('system-tasks'),
      defaultTtlMs: z.coerce.number().nullable().optional(),
    }),
    openTelemetry: z.object({
      enabled: envBoolean.default(false),
      serviceName: z.string(),
      serviceVersion: z.string(),
      tracesEndpoint: z.url().optional(),
      metricsEndpoint: z.url().optional(),
      samplingRatio: z.coerce.number().min(0).max(1).default(1.0),
      logLevel: z
        .preprocess(
          (val) => {
            const str = emptyStringAsUndefined(val);
            if (typeof str === 'string') {
              const lower = str.toLowerCase();
              const aliasMap: Record<string, string> = {
                err: 'ERROR',
                warning: 'WARN',
                information: 'INFO',
              };
              return aliasMap[lower] ?? str.toUpperCase();
            }
            return str;
          },
          z.enum(['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE', 'ALL']),
        )
        .default('INFO'),
    }),
    speech: z
      .object({
        tts: z
          .object({
            enabled: envBoolean.default(false),
            provider: z.enum(['elevenlabs']).default('elevenlabs'),
            apiKey: z.string().optional(),
            baseUrl: z.url().optional(),
            defaultVoiceId: z.string().optional(),
            defaultModelId: z.string().optional(),
            timeout: z.coerce.number().optional(),
          })
          .optional(),
        stt: z
          .object({
            enabled: envBoolean.default(false),
            provider: z.enum(['openai-whisper']).default('openai-whisper'),
            apiKey: z.string().optional(),
            baseUrl: z.url().optional(),
            defaultModelId: z.string().optional(),
            timeout: z.coerce.number().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Production guard: reject dev bypass in production regardless of auth mode
    if (data.environment === 'production' && data.devMcpAuthBypass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['devMcpAuthBypass'],
        message:
          'DEV_MCP_AUTH_BYPASS cannot be enabled in production (NODE_ENV=production). This flag is for development only.',
      });
    }

    // JWT mode: require secret key of sufficient length (unless dev bypass is on)
    if (data.mcpAuthMode === 'jwt' && !data.devMcpAuthBypass) {
      if (!data.mcpAuthSecretKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mcpAuthSecretKey'],
          message:
            'MCP_AUTH_SECRET_KEY is required when MCP_AUTH_MODE=jwt (set DEV_MCP_AUTH_BYPASS=true to skip in development).',
        });
      } else if (data.mcpAuthSecretKey.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mcpAuthSecretKey'],
          message: 'MCP_AUTH_SECRET_KEY must be at least 32 characters for JWT mode.',
        });
      }
    }
    // OAuth mode: require issuer URL and audience
    if (data.mcpAuthMode === 'oauth') {
      if (!data.oauthIssuerUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['oauthIssuerUrl'],
          message: 'OAUTH_ISSUER_URL is required when MCP_AUTH_MODE=oauth.',
        });
      }
      if (!data.oauthAudience) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['oauthAudience'],
          message: 'OAUTH_AUDIENCE is required when MCP_AUTH_MODE=oauth.',
        });
      }
    }
  });

// --- Parsing Logic ---
const parseConfig = (envOverrides?: Record<string, string | undefined>) => {
  // Lazy dotenv loading — only in Node.js, only once, only when not using overrides
  if (!_dotenvLoaded && runtimeCaps.isNode && !envOverrides) {
    dotenv.config({ quiet: true });
    _dotenvLoaded = true;
  }

  const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;
  const consumerPkg = resolveConsumerPackage();

  const rawConfig = {
    pkg: {
      name: env.PACKAGE_NAME ?? consumerPkg.name ?? frameworkPkg.name,
      version: env.PACKAGE_VERSION ?? consumerPkg.version ?? frameworkPkg.version,
      description: env.PACKAGE_DESCRIPTION ?? consumerPkg.description ?? frameworkPkg.description,
    },
    logLevel: env.MCP_LOG_LEVEL,
    logsPath: env.LOGS_DIR,
    logLlmInteractions: env.LOG_LLM_INTERACTIONS,
    environment: env.NODE_ENV,
    mcpTransportType: env.MCP_TRANSPORT_TYPE,
    mcpSessionMode: env.MCP_SESSION_MODE,
    mcpResponseVerbosity: env.MCP_RESPONSE_VERBOSITY,
    mcpHttpPort: env.MCP_HTTP_PORT,
    mcpHttpHost: env.MCP_HTTP_HOST,
    mcpHttpEndpointPath: env.MCP_HTTP_ENDPOINT_PATH,
    mcpPublicUrl: env.MCP_PUBLIC_URL,
    mcpHttpMaxPortRetries: env.MCP_HTTP_MAX_PORT_RETRIES,
    mcpHttpPortRetryDelayMs: env.MCP_HTTP_PORT_RETRY_DELAY_MS,
    mcpStatefulSessionStaleTimeoutMs: env.MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS,
    mcpHeartbeatIntervalMs: env.MCP_HEARTBEAT_INTERVAL_MS,
    mcpHeartbeatMissThreshold: env.MCP_HEARTBEAT_MISS_THRESHOLD,
    mcpAllowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    mcpAuthSecretKey: env.MCP_AUTH_SECRET_KEY,
    mcpJwtExpectedIssuer: env.MCP_JWT_EXPECTED_ISSUER,
    mcpJwtExpectedAudience: env.MCP_JWT_EXPECTED_AUDIENCE,
    mcpAuthMode: env.MCP_AUTH_MODE,
    oauthIssuerUrl: env.OAUTH_ISSUER_URL,
    oauthJwksUri: env.OAUTH_JWKS_URI,
    oauthAudience: env.OAUTH_AUDIENCE,
    oauthJwksCooldownMs: env.OAUTH_JWKS_COOLDOWN_MS,
    oauthJwksTimeoutMs: env.OAUTH_JWKS_TIMEOUT_MS,
    mcpServerResourceIdentifier: env.MCP_SERVER_RESOURCE_IDENTIFIER,
    devMcpAuthBypass: env.DEV_MCP_AUTH_BYPASS,
    devMcpClientId: env.DEV_MCP_CLIENT_ID,
    devMcpScopes: env.DEV_MCP_SCOPES?.split(',').map((s) => s.trim()),
    openrouterAppUrl: env.OPENROUTER_APP_URL,
    openrouterAppName: env.OPENROUTER_APP_NAME,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    llmDefaultModel: env.LLM_DEFAULT_MODEL,
    llmDefaultTemperature: env.LLM_DEFAULT_TEMPERATURE,
    llmDefaultTopP: env.LLM_DEFAULT_TOP_P,
    llmDefaultMaxTokens: env.LLM_DEFAULT_MAX_TOKENS,
    llmDefaultTopK: env.LLM_DEFAULT_TOP_K,
    llmDefaultMinP: env.LLM_DEFAULT_MIN_P,
    oauthProxy:
      env.OAUTH_PROXY_AUTHORIZATION_URL || env.OAUTH_PROXY_TOKEN_URL
        ? {
            authorizationUrl: env.OAUTH_PROXY_AUTHORIZATION_URL,
            tokenUrl: env.OAUTH_PROXY_TOKEN_URL,
            revocationUrl: env.OAUTH_PROXY_REVOCATION_URL,
            issuerUrl: env.OAUTH_PROXY_ISSUER_URL,
            serviceDocumentationUrl: env.OAUTH_PROXY_SERVICE_DOCUMENTATION_URL,
            defaultClientRedirectUris: env.OAUTH_PROXY_DEFAULT_CLIENT_REDIRECT_URIS?.split(',')
              .map((uri) => uri.trim())
              .filter(Boolean),
          }
        : undefined,
    supabase:
      env.SUPABASE_URL && env.SUPABASE_ANON_KEY
        ? {
            url: env.SUPABASE_URL,
            anonKey: env.SUPABASE_ANON_KEY,
            serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
          }
        : undefined,
    storage: {
      providerType: env.STORAGE_PROVIDER_TYPE,
      filesystemPath: env.STORAGE_FILESYSTEM_PATH,
    },
    canvas: {
      providerType: env.CANVAS_PROVIDER_TYPE,
      defaultMemoryLimitMb: env.CANVAS_DEFAULT_MEMORY_LIMIT_MB,
      exportRootPath: env.CANVAS_EXPORT_PATH,
      maxCanvasesPerTenant: env.CANVAS_MAX_CANVASES_PER_TENANT,
      ttlMs: env.CANVAS_TTL_MS,
      absoluteCapMs: env.CANVAS_ABSOLUTE_CAP_MS,
      sweeperIntervalMs: env.CANVAS_SWEEPER_INTERVAL_MS,
      defaultRowLimit: env.CANVAS_DEFAULT_ROW_LIMIT,
      schemaSniffRows: env.CANVAS_SCHEMA_SNIFF_ROWS,
    },
    tasks: {
      storeType: env.TASK_STORE_TYPE,
      tenantId: env.TASK_STORE_TENANT_ID,
      defaultTtlMs: env.TASK_STORE_DEFAULT_TTL_MS,
    },
    openTelemetry: {
      enabled: env.OTEL_ENABLED,
      serviceName: env.OTEL_SERVICE_NAME,
      serviceVersion: env.OTEL_SERVICE_VERSION,
      tracesEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      metricsEndpoint: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      samplingRatio: env.OTEL_TRACES_SAMPLER_ARG,
      logLevel: env.OTEL_LOG_LEVEL,
    },
    speech:
      env.SPEECH_TTS_ENABLED || env.SPEECH_STT_ENABLED
        ? {
            tts: env.SPEECH_TTS_ENABLED
              ? {
                  enabled: env.SPEECH_TTS_ENABLED,
                  provider: env.SPEECH_TTS_PROVIDER,
                  apiKey: env.SPEECH_TTS_API_KEY,
                  baseUrl: env.SPEECH_TTS_BASE_URL,
                  defaultVoiceId: env.SPEECH_TTS_DEFAULT_VOICE_ID,
                  defaultModelId: env.SPEECH_TTS_DEFAULT_MODEL_ID,
                  timeout: env.SPEECH_TTS_TIMEOUT,
                }
              : undefined,
            stt: env.SPEECH_STT_ENABLED
              ? {
                  enabled: env.SPEECH_STT_ENABLED,
                  provider: env.SPEECH_STT_PROVIDER,
                  apiKey: env.SPEECH_STT_API_KEY,
                  baseUrl: env.SPEECH_STT_BASE_URL,
                  defaultModelId: env.SPEECH_STT_DEFAULT_MODEL_ID,
                  timeout: env.SPEECH_STT_TIMEOUT,
                }
              : undefined,
          }
        : undefined,
    // The following fields will be derived and are not directly from env
    mcpServerName: env.MCP_SERVER_NAME,
    mcpServerVersion: env.MCP_SERVER_VERSION,
    mcpServerDescription: env.MCP_SERVER_DESCRIPTION,
    mcpServerHomepage: env.MCP_SERVER_HOMEPAGE,
  };

  // Use a temporary schema to parse package info and provide defaults
  const pkgSchema = z.object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    homepage: z.string().optional(),
  });
  const parsedPkg = pkgSchema.parse(rawConfig.pkg);

  // Now add the derived values to the main rawConfig object to be parsed
  const finalRawConfig = {
    ...rawConfig,
    pkg: parsedPkg,
    logsPath: runtimeCaps.isNode
      ? (() => {
          // Bundled (dist/index.js) is one level deep; source (src/config/index.ts) is two.
          // Detect bundle path to avoid overshooting the project root.
          const depth = import.meta.url.includes('/dist/') ? '..' : '../..';
          const thisFile = fileURLToPath(import.meta.url);
          const root = join(dirname(thisFile), depth);
          const logsDir = rawConfig.logsPath ?? 'logs';
          if (isAbsolute(logsDir)) return logsDir;
          return join(root, logsDir);
        })()
      : undefined,
    mcpServerName: env.MCP_SERVER_NAME ?? parsedPkg.name,
    mcpServerVersion: env.MCP_SERVER_VERSION ?? parsedPkg.version,
    mcpServerDescription: env.MCP_SERVER_DESCRIPTION ?? parsedPkg.description,
    mcpServerHomepage: env.MCP_SERVER_HOMEPAGE, // Intentionally no pkg fallback — opt-in only
    openTelemetry: {
      ...rawConfig.openTelemetry,
      serviceName: env.OTEL_SERVICE_NAME ?? parsedPkg.name,
      serviceVersion: env.OTEL_SERVICE_VERSION ?? parsedPkg.version,
    },
    openrouterAppName: env.OPENROUTER_APP_NAME ?? parsedPkg.name,
  };

  const parsedConfig = ConfigSchema.safeParse(finalRawConfig);

  if (!parsedConfig.success) {
    // Keep existing TTY error logging for developer convenience.
    if (process.stdout.isTTY) {
      console.error(
        '❌ Invalid configuration found. Please check your environment variables.',
        parsedConfig.error.flatten().fieldErrors,
      );
    }
    // Throw a specific, typed error instead of exiting.
    throw configurationError('Invalid application configuration.', {
      validationErrors: parsedConfig.error.flatten().fieldErrors,
    });
  }

  return parsedConfig.data;
};

let _config: AppConfig | undefined;

/**
 * Resets the cached config. Without arguments, clears the cache so the next
 * proxy access re-parses from `process.env`. With `envOverrides`, immediately
 * parses and caches config with the overrides applied — avoiding `process.env`
 * mutation and the concurrency races that come with it.
 *
 * Used in Cloudflare Workers (env vars injected at request time, after ESM
 * static imports), `composeServices` (name/version overrides), and test isolation.
 */
const resetConfig = (envOverrides?: Record<string, string | undefined>): void => {
  _config = envOverrides ? parseConfig(envOverrides) : undefined;
};

/**
 * Lazy config proxy. Defers `parseConfig()` until the first property access.
 * This is critical for Cloudflare Workers where environment variables are
 * injected via `injectEnvVars()` at request time — before config is read,
 * but after ESM static imports have been evaluated. Without this, config
 * would freeze at module-load time with empty/default env values.
 */
const config = new Proxy({} as AppConfig, {
  get(_target, prop) {
    _config ??= parseConfig();
    return (_config as Record<string | symbol, unknown>)[prop];
  },
  set() {
    return false;
  },
  defineProperty() {
    return false;
  },
  has(_target, prop) {
    _config ??= parseConfig();
    return prop in _config;
  },
  ownKeys() {
    _config ??= parseConfig();
    return Reflect.ownKeys(_config);
  },
  getOwnPropertyDescriptor(_target, prop) {
    _config ??= parseConfig();
    return Object.getOwnPropertyDescriptor(_config, prop);
  },
});

/**
 * Export the runtime configuration, parser, and schema, plus a static AppConfig type.
 */
export type AppConfig = z.infer<typeof ConfigSchema>;

export { parseEnvConfig } from './parseEnvConfig.js';
export { ConfigSchema, config, parseConfig, resetConfig };
