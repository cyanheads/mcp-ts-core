/**
 * @fileoverview Loads, validates, and exports application configuration.
 * This module centralizes configuration management, sourcing values from
 * environment variables. It uses Zod for schema validation to ensure type safety
 * and correctness of configuration parameters, and is designed to be
 * environment-agnostic (e.g., Node.js, Cloudflare Workers).
 *
 * @module src/config/index
 */
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import packageJson from '../../package.json' with { type: 'json' };
import { configurationError } from '../types-global/errors.js';
import { runtimeCaps } from '../utils/internal/runtime.js';
import { type PackageManifest, resolveAppRoot } from './appRoot.js';
import { formatEnvIssues, toEnvIssues } from './envIssue.js';
import { emptyStringAsUndefined, normalizeEnv } from './envValue.js';
import { normalizeLogLevelAlias } from './logLevelAlias.js';

const frameworkPkg = packageJson as PackageManifest;

/** Framework identity — sourced from the package's own package.json. */
export const FRAMEWORK_NAME = '@cyanheads/mcp-ts-core';
export const FRAMEWORK_VERSION = frameworkPkg.version ?? '0.0.0';

// Lazy .env loading — deferred to first parseConfig() call.
// Top-level execution loads a stale .env before test setup can configure the
// environment.
let _envFileLoaded = false;

/**
 * Loads `./.env` (relative to the working directory) into `process.env` via
 * Node's native `process.loadEnvFile()`. Variables already set are never
 * overridden. A missing file is the normal case and is ignored; any other read
 * failure is surfaced rather than silently leaving the server unconfigured.
 */
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw configurationError(
      'Failed to load .env from the working directory.',
      { cwd: process.cwd() },
      { cause: error },
    );
  }
}

// --- Helper Functions ---
/**
 * Boolean env flag parser. Uses Zod's `stringbool` — accepts `true/false/1/0/
 * yes/no/on/off` (case-insensitive) and rejects anything else, so `"false"`
 * disables. This is the safe alternative to `z.coerce.boolean()`, where
 * `Boolean("false") === true` makes a flag impossible to turn off through the
 * environment. Empty string and unset both fall through to the baked `false`
 * default; real booleans pass through for runtimes that inject typed env vars
 * (Cloudflare Workers `[vars]`). The default lives under the preprocess so
 * empty strings resolve to it — field sites use `envBoolean` directly, or
 * `envBooleanDefaulting(true)` for a flag that is on until switched off.
 */
const envBooleanDefaulting = (fallback: boolean) =>
  z.preprocess(emptyStringAsUndefined, z.union([z.boolean(), z.stringbool()]).default(fallback));

const envBoolean = envBooleanDefaulting(false);

/** The largest delay `setTimeout` honors; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A timer variable in integer milliseconds, capped at {@link MAX_TIMER_MS}.
 * `min` is `0` where zero disables the interval, delay, or cooldown, and `1`
 * where zero would time out or evict at once. Bounded at startup because
 * `AbortSignal.timeout()` throws on a negative value and Node also on a
 * fractional one, failing every call that builds the timer instead.
 */
const envTimerMs = (min: 0 | 1) => z.coerce.number().int().min(min).max(MAX_TIMER_MS);

/** Reads one environment variable for the field at a dot-joined schema `path`. */
type EnvReader = (path: string, name: string) => string | undefined;

/**
 * One signal's OTLP/HTTP endpoint, per the OTLP exporter spec: the
 * signal-specific variable is used as-is; otherwise `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is the base and the signal path is appended to it, keeping any path prefix
 * and never doubling the slash. Undefined when neither is set. Read through
 * `read`, so the field is attributed to whichever variable supplied it.
 * @see https://opentelemetry.io/docs/specs/otel/protocol/exporter/#endpoint-urls-for-otlphttp
 */
const otlpSignalEndpoint = (
  read: EnvReader,
  path: string,
  signalVar: string,
  signalPath: 'v1/traces' | 'v1/metrics',
): string | undefined => {
  const signalEndpoint = read(path, signalVar);
  if (signalEndpoint !== undefined) return signalEndpoint;
  const baseEndpoint = read(path, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  if (baseEndpoint === undefined) return undefined;
  return `${baseEndpoint.endsWith('/') ? baseEndpoint : `${baseEndpoint}/`}${signalPath}`;
};

// --- Schema Definition ---
const ConfigSchema = z
  .object({
    // Package information sourced from environment variables
    pkg: z.object({
      name: z.string(),
      version: z.string(),
      description: z.string().optional(),
      keywords: z.array(z.string()).optional(),
    }),
    mcpServerName: z.string(), // Will be derived from pkg.name
    mcpServerVersion: z.string(), // Will be derived from pkg.version
    mcpServerDescription: z.string().optional(), // Will be derived from pkg.description
    mcpServerKeywords: z.array(z.string()).optional(), // Will be derived from pkg.keywords
    mcpServerHomepage: z.string().optional(), // Will be derived from pkg.homepage
    logLevel: z
      .preprocess(
        (val) => {
          const str = emptyStringAsUndefined(val);
          if (typeof str === 'string') return normalizeLogLevelAlias(str);
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
    logLlmInteractions: envBoolean,
    /**
     * When `true`, every failed tool call also writes one `Tool failure payload`
     * record carrying the arguments as sent and the `CallToolResult` returned,
     * each redacted by key name and capped at `logToolFailurePayloadMaxBytes`.
     * The record is exempt from `logRateLimitThreshold`, so every failed call
     * keeps its own. Default `false` — arguments are caller data, and key-name
     * redaction does not reach a secret inside a free-form value.
     */
    logToolFailurePayloads: envBoolean,
    /** Per-payload cap, in UTF-8 bytes, on the `toolInput` and `toolResult` strings. */
    logToolFailurePayloadMaxBytes: z.coerce.number().int().positive().default(16_384),
    /**
     * Maximum times a given level + message pair is emitted per
     * `logRateLimitWindowMs` before further occurrences are suppressed.
     * Guards against log storms from a repeated error. Set to `0` to disable
     * rate limiting entirely — appropriate for a high-throughput server whose
     * own per-call lines use a constant message by design. The framework's
     * per-call completion and failure-payload records are already exempt.
     */
    logRateLimitThreshold: z.coerce.number().int().min(0).default(10),
    /** Window, in milliseconds, over which `logRateLimitThreshold` is counted. */
    logRateLimitWindowMs: z.coerce.number().int().positive().default(60_000),
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
    mcpHttpPort: z.coerce.number().int().min(0).max(65535).default(3010),
    mcpHttpHost: z.string().default('127.0.0.1'),
    mcpHttpEndpointPath: z.string().default('/mcp'),
    /**
     * Maximum accepted HTTP request body size in bytes for the MCP endpoint.
     * Oversized requests are rejected with 413 before the per-request
     * `McpServer`/transport are allocated and before the SDK parses the body.
     * A declared `Content-Length` over the cap is rejected with zero buffering;
     * otherwise the body is read once and its actual byte length enforced.
     *
     * Caps the inbound JSON-RPC request body only. Data a handler fetches from
     * upstream into a DataCanvas/DuckDB, and the rows it returns in the
     * response, flow outside the request body and are unaffected — canvas
     * servers send small requests (queries, SQL, canvas IDs) regardless of how
     * much data they stage. Default 1 MiB; raise only for servers whose tools
     * accept large payloads in the request body itself (base64 media, pasted
     * documents). Set to `0` to disable and defer to the runtime/reverse proxy.
     * The only request-body limit the transport applies: the SDK's own 4 MiB
     * read cap never engages, since it is handed the already-parsed body, so a
     * value above 4 MiB holds as set.
     */
    mcpHttpMaxBodyBytes: z.coerce
      .number()
      .int()
      .min(0)
      .default(1024 * 1024),
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
    mcpHttpMaxPortRetries: z.coerce.number().int().min(0).default(15),
    mcpHttpPortRetryDelayMs: envTimerMs(0).default(50),
    mcpStatefulSessionStaleTimeoutMs: envTimerMs(1).default(1_800_000),
    /**
     * Kill switch for SSE stream replay under stateful HTTP. Replay is on by
     * default there — selecting a session mode is the opt-in, and a session
     * that survives a dropped connection but loses the in-flight stream is
     * half a promise. Set `MCP_HTTP_RESUMABILITY=false` to disable it without
     * changing session behavior. No effect on stateless mode or on protocol
     * revision 2026-07-28, neither of which has a session to resume (#215).
     */
    mcpHttpResumability: envBooleanDefaulting(true),
    /** Events retained per session for replay. Oldest are evicted first. */
    mcpHttpResumabilityMaxEvents: z.coerce.number().int().min(1).default(512),
    /** How long a retained event stays replayable, in milliseconds. */
    mcpHttpResumabilityTtlMs: z.coerce.number().int().min(1).default(300_000),
    mcpHeartbeatIntervalMs: envTimerMs(0).default(0),
    mcpHeartbeatMissThreshold: z.coerce.number().int().min(1).default(3),
    /**
     * Interval in milliseconds for an opt-in forced GC loop. Only takes effect
     * when the runtime is Bun and `globalThis.Bun.gc` is callable. When set,
     * a `setInterval` (`.unref()`'d) calls `Bun.gc(true)` every N ms to drain
     * the major-GC backlog under sustained moderate load — the scenario behind
     * issue #50 where per-request `McpServer`/`McpSessionTransport` pairs sit
     * reachable in old-gen until a major collection fires. Default `0`
     * (disabled). Recommended starting point for production HTTP deployments
     * exhibiting heap growth: `60000` (1 min). Cheap (~50 ms reclaims dozens of
     * pairs); benign on Node / Workers / when unset.
     */
    mcpGcPressureIntervalMs: envTimerMs(0).default(0),
    mcpAllowedOrigins: z.array(z.string()).optional(),
    mcpAuthSecretKey: z.string().optional(),
    /**
     * Opt-in HMAC key for multi-round-trip `requestState`. When set, the
     * framework seals the state a handler returns with `ctx.requestInput` and
     * the SDK verifies every echoed state before the handler runs, so a retry
     * can only carry state this server minted, for the same principal, within
     * 900 s. Every instance a retry can reach needs the same key. Unset, state
     * round-trips raw. At least 32 bytes; the length is checked where the
     * codec is built, so the startup error names this variable.
     */
    mcpRequestStateKey: z.string().optional(),
    mcpJwtExpectedIssuer: z.string().optional(),
    mcpJwtExpectedAudience: z.string().optional(),
    mcpAuthMode: z.preprocess(
      emptyStringAsUndefined,
      z.enum(['jwt', 'oauth', 'none']).default('none'),
    ),
    /**
     * Bypass per-request scope enforcement when `MCP_AUTH_MODE` is `jwt` or `oauth`.
     * When `true`, both `withRequiredScopes` (declared `auth: [...]`) and `checkScopes`
     * (runtime-computed scopes inside handlers, including tenant isolation patterns
     * like `team:${input.teamId}:write`) early-return after the auth-context presence
     * check. Signature, audience, issuer, and expiry validation remain intact. Combine
     * with server-side ACLs — without an in-handler ACL, every authenticated user
     * effectively has every scope.
     */
    mcpAuthDisableScopeChecks: envBoolean,
    oauthIssuerUrl: z.url().optional(),
    oauthJwksUri: z.url().optional(),
    oauthAudience: z.string().optional(),
    oauthJwksCooldownMs: envTimerMs(0).default(300_000), // 5 minutes
    oauthJwksTimeoutMs: envTimerMs(1).default(5_000), // 5 seconds
    mcpServerResourceIdentifier: z.url().optional(), // RFC 8707 resource indicator
    devMcpAuthBypass: envBoolean,
    devMcpClientId: z.string().optional(),
    devMcpScopes: z.array(z.string()).optional(),
    openrouterAppUrl: z.string().default('http://localhost:3000'),
    openrouterAppName: z.string(),
    openrouterApiKey: z.string().optional(),
    llmDefaultModel: z.string().default('google/gemini-2.5-flash-preview-05-20'),
    llmDefaultTemperature: z.coerce.number().optional(),
    llmDefaultTopP: z.coerce.number().optional(),
    llmDefaultMaxTokens: z.coerce.number().int().min(1).optional(),
    // OpenRouter reads `top_k: 0` as "consider every token".
    llmDefaultTopK: z.coerce.number().int().min(0).optional(),
    llmDefaultMinP: z.coerce.number().optional(),
    supabase: z
      .object({
        url: z.url(),
        /** For a server's own public client; the framework's storage provider never reads it. */
        anonKey: z.string().optional(),
        /** Required by the `supabase` storage provider (admin client). */
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
        defaultMemoryLimitMb: z.coerce.number().int().min(64).default(1024),
        /**
         * Sandbox root for path-targeted exports. Path-based `export()` calls
         * are resolved relative to this directory and rejected if they escape
         * via `..` or absolute paths. Stream-based exports bypass this.
         */
        exportRootPath: z.string().default('./.canvas-exports'),
        /**
         * Parent directory for canvas scratch I/O. On first use the DuckDB
         * provider creates a private `mcp-canvas-XXXXXX` directory inside it
         * (`mkdtemp`, mode `0700` on POSIX) holding each canvas's own DuckDB
         * `temp_directory` (where a query exceeding `memory_limit` spills)
         * and the transient files behind stream exports and `importFrom`;
         * shutdown removes it once the calls still running against it
         * settle.
         *
         * Left unset, the parent is the OS temp directory — never the process
         * cwd, since DuckDB's own default for an in-memory database is a
         * cwd-relative `.tmp`, which fails outright under a non-root or
         * read-only container rootfs. A configured parent is created if
         * missing and gets no ownership or mode check, so it must not be a
         * directory another local user controls. On Windows the private
         * directory inherits the parent's ACL, so there the parent must also
         * not grant other users access. Distinct from
         * `CANVAS_EXPORT_PATH`, which holds user-requested export files and
         * stays where the caller asked for them.
         */
        tempRootPath: z.string().optional(),
        /**
         * Maximum active canvases per tenant before `RateLimited`. Under
         * `MCP_AUTH_MODE=none` every caller shares one tenant, so this bounds
         * the whole deployment.
         */
        maxCanvasesPerTenant: z.coerce.number().int().min(1).default(500),
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
        sweeperIntervalMs: envTimerMs(0).default(60_000),
        /** Default row cap for `query()` results; a safe integer, as `query()` requires of `rowLimit`. */
        defaultRowLimit: z.coerce.number().int().min(1).default(10_000),
        /** Number of rows to sniff for schema inference when schema is omitted. */
        schemaSniffRows: z.coerce.number().int().min(1).default(100),
      })
      .refine((c) => c.absoluteCapMs >= c.ttlMs, {
        message:
          'CANVAS_ABSOLUTE_CAP_MS must be >= CANVAS_TTL_MS — otherwise canvases die at the absolute cap before the sliding TTL ever extends them.',
        path: ['absoluteCapMs'],
      }),
    openTelemetry: z.object({
      enabled: envBoolean,
      serviceName: z.string(),
      serviceVersion: z.string(),
      /** Effective OTLP traces URL — the signal variable, else the base endpoint + `v1/traces`. */
      tracesEndpoint: z.url().optional(),
      /** Effective OTLP metrics URL — the signal variable, else the base endpoint + `v1/metrics`. */
      metricsEndpoint: z.url().optional(),
      /**
       * OTLP logs URL, from `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` only. Deliberately
       * never derived from the base endpoint: a deployment that set only the base
       * for traces and metrics must not start exporting log records on upgrade.
       */
      logsEndpoint: z.url().optional(),
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
            enabled: envBoolean,
            provider: z.enum(['elevenlabs']).default('elevenlabs'),
            apiKey: z.string().optional(),
            baseUrl: z.url().optional(),
            defaultVoiceId: z.string().optional(),
            defaultModelId: z.string().optional(),
            timeout: envTimerMs(1).optional(),
          })
          .optional(),
        stt: z
          .object({
            enabled: envBoolean,
            provider: z.enum(['openai-whisper']).default('openai-whisper'),
            apiKey: z.string().optional(),
            baseUrl: z.url().optional(),
            defaultModelId: z.string().optional(),
            timeout: envTimerMs(1).optional(),
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
  // Lazy .env loading — only in a real Node/Bun process, only once, only when not using overrides
  if (!_envFileLoaded && runtimeCaps.isNode && !runtimeCaps.isWorkerLike && !envOverrides) {
    loadEnvFile();
    _envFileLoaded = true;
  }

  // Empty strings and unsubstituted `${…}` placeholders read as unset for
  // every field, so a blank `.env` line or a host-forwarded placeholder falls
  // through to the default instead of failing a format validator.
  const env = normalizeEnv(envOverrides ? { ...process.env, ...envOverrides } : process.env);
  // Identity comes from the application root, never `process.cwd()`: a stdio
  // client's working directory is arbitrary, and a manifest read from it makes
  // the server report whatever project happens to sit there. Empty in Workers
  // and when no manifest is reachable, so the framework defaults apply.
  const consumerPkg: PackageManifest = resolveAppRoot()?.manifest ?? {};

  // Each field names the variable it reads, so a validation failure can name
  // what the operator set (`CANVAS_DEFAULT_ROW_LIMIT`) rather than the field.
  const envVarByPath: Record<string, string> = Object.create(null);
  const read: EnvReader = (path, name) => {
    envVarByPath[path] = name;
    return env[name];
  };

  const rawConfig = {
    pkg: {
      name: read('pkg.name', 'PACKAGE_NAME') ?? consumerPkg.name ?? frameworkPkg.name,
      version:
        read('pkg.version', 'PACKAGE_VERSION') ?? consumerPkg.version ?? frameworkPkg.version,
      description:
        read('pkg.description', 'PACKAGE_DESCRIPTION') ??
        consumerPkg.description ??
        frameworkPkg.description,
      keywords:
        read('pkg.keywords', 'PACKAGE_KEYWORDS')
          ?.split(',')
          .map((k) => k.trim())
          .filter(Boolean) ?? consumerPkg.keywords,
    },
    logLevel: read('logLevel', 'MCP_LOG_LEVEL'),
    logsPath: read('logsPath', 'LOGS_DIR'),
    logLlmInteractions: read('logLlmInteractions', 'LOG_LLM_INTERACTIONS'),
    logToolFailurePayloads: read('logToolFailurePayloads', 'LOG_TOOL_FAILURE_PAYLOADS'),
    logToolFailurePayloadMaxBytes: read(
      'logToolFailurePayloadMaxBytes',
      'LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES',
    ),
    logRateLimitThreshold: read('logRateLimitThreshold', 'MCP_LOG_RATE_LIMIT_THRESHOLD'),
    logRateLimitWindowMs: read('logRateLimitWindowMs', 'MCP_LOG_RATE_LIMIT_WINDOW_MS'),
    environment: read('environment', 'NODE_ENV'),
    mcpTransportType: read('mcpTransportType', 'MCP_TRANSPORT_TYPE'),
    mcpSessionMode: read('mcpSessionMode', 'MCP_SESSION_MODE'),
    mcpHttpPort: read('mcpHttpPort', 'MCP_HTTP_PORT'),
    mcpHttpHost: read('mcpHttpHost', 'MCP_HTTP_HOST'),
    mcpHttpEndpointPath: read('mcpHttpEndpointPath', 'MCP_HTTP_ENDPOINT_PATH'),
    mcpHttpMaxBodyBytes: read('mcpHttpMaxBodyBytes', 'MCP_HTTP_MAX_BODY_BYTES'),
    mcpPublicUrl: read('mcpPublicUrl', 'MCP_PUBLIC_URL'),
    mcpHttpMaxPortRetries: read('mcpHttpMaxPortRetries', 'MCP_HTTP_MAX_PORT_RETRIES'),
    mcpHttpPortRetryDelayMs: read('mcpHttpPortRetryDelayMs', 'MCP_HTTP_PORT_RETRY_DELAY_MS'),
    mcpStatefulSessionStaleTimeoutMs: read(
      'mcpStatefulSessionStaleTimeoutMs',
      'MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS',
    ),
    mcpHttpResumability: read('mcpHttpResumability', 'MCP_HTTP_RESUMABILITY'),
    mcpHttpResumabilityMaxEvents: read(
      'mcpHttpResumabilityMaxEvents',
      'MCP_HTTP_RESUMABILITY_MAX_EVENTS',
    ),
    mcpHttpResumabilityTtlMs: read('mcpHttpResumabilityTtlMs', 'MCP_HTTP_RESUMABILITY_TTL_MS'),
    mcpHeartbeatIntervalMs: read('mcpHeartbeatIntervalMs', 'MCP_HEARTBEAT_INTERVAL_MS'),
    mcpHeartbeatMissThreshold: read('mcpHeartbeatMissThreshold', 'MCP_HEARTBEAT_MISS_THRESHOLD'),
    mcpGcPressureIntervalMs: read('mcpGcPressureIntervalMs', 'MCP_GC_PRESSURE_INTERVAL_MS'),
    mcpAllowedOrigins: read('mcpAllowedOrigins', 'MCP_ALLOWED_ORIGINS')
      ?.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    mcpAuthSecretKey: read('mcpAuthSecretKey', 'MCP_AUTH_SECRET_KEY'),
    mcpRequestStateKey: read('mcpRequestStateKey', 'MCP_REQUEST_STATE_KEY'),
    mcpJwtExpectedIssuer: read('mcpJwtExpectedIssuer', 'MCP_JWT_EXPECTED_ISSUER'),
    mcpJwtExpectedAudience: read('mcpJwtExpectedAudience', 'MCP_JWT_EXPECTED_AUDIENCE'),
    mcpAuthMode: read('mcpAuthMode', 'MCP_AUTH_MODE'),
    mcpAuthDisableScopeChecks: read('mcpAuthDisableScopeChecks', 'MCP_AUTH_DISABLE_SCOPE_CHECKS'),
    oauthIssuerUrl: read('oauthIssuerUrl', 'OAUTH_ISSUER_URL'),
    oauthJwksUri: read('oauthJwksUri', 'OAUTH_JWKS_URI'),
    oauthAudience: read('oauthAudience', 'OAUTH_AUDIENCE'),
    oauthJwksCooldownMs: read('oauthJwksCooldownMs', 'OAUTH_JWKS_COOLDOWN_MS'),
    oauthJwksTimeoutMs: read('oauthJwksTimeoutMs', 'OAUTH_JWKS_TIMEOUT_MS'),
    mcpServerResourceIdentifier: read(
      'mcpServerResourceIdentifier',
      'MCP_SERVER_RESOURCE_IDENTIFIER',
    ),
    devMcpAuthBypass: read('devMcpAuthBypass', 'DEV_MCP_AUTH_BYPASS'),
    devMcpClientId: read('devMcpClientId', 'DEV_MCP_CLIENT_ID'),
    devMcpScopes: read('devMcpScopes', 'DEV_MCP_SCOPES')
      ?.split(',')
      .map((s) => s.trim()),
    openrouterAppUrl: read('openrouterAppUrl', 'OPENROUTER_APP_URL'),
    openrouterAppName: read('openrouterAppName', 'OPENROUTER_APP_NAME'),
    openrouterApiKey: read('openrouterApiKey', 'OPENROUTER_API_KEY'),
    llmDefaultModel: read('llmDefaultModel', 'LLM_DEFAULT_MODEL'),
    llmDefaultTemperature: read('llmDefaultTemperature', 'LLM_DEFAULT_TEMPERATURE'),
    llmDefaultTopP: read('llmDefaultTopP', 'LLM_DEFAULT_TOP_P'),
    llmDefaultMaxTokens: read('llmDefaultMaxTokens', 'LLM_DEFAULT_MAX_TOKENS'),
    llmDefaultTopK: read('llmDefaultTopK', 'LLM_DEFAULT_TOP_K'),
    llmDefaultMinP: read('llmDefaultMinP', 'LLM_DEFAULT_MIN_P'),
    supabase: env.SUPABASE_URL
      ? {
          url: read('supabase.url', 'SUPABASE_URL'),
          anonKey: read('supabase.anonKey', 'SUPABASE_ANON_KEY'),
          serviceRoleKey: read('supabase.serviceRoleKey', 'SUPABASE_SERVICE_ROLE_KEY'),
        }
      : undefined,
    storage: {
      providerType: read('storage.providerType', 'STORAGE_PROVIDER_TYPE'),
      filesystemPath: read('storage.filesystemPath', 'STORAGE_FILESYSTEM_PATH'),
    },
    canvas: {
      providerType: read('canvas.providerType', 'CANVAS_PROVIDER_TYPE'),
      defaultMemoryLimitMb: read('canvas.defaultMemoryLimitMb', 'CANVAS_DEFAULT_MEMORY_LIMIT_MB'),
      exportRootPath: read('canvas.exportRootPath', 'CANVAS_EXPORT_PATH'),
      tempRootPath: read('canvas.tempRootPath', 'CANVAS_TEMP_PATH'),
      maxCanvasesPerTenant: read('canvas.maxCanvasesPerTenant', 'CANVAS_MAX_CANVASES_PER_TENANT'),
      ttlMs: read('canvas.ttlMs', 'CANVAS_TTL_MS'),
      absoluteCapMs: read('canvas.absoluteCapMs', 'CANVAS_ABSOLUTE_CAP_MS'),
      sweeperIntervalMs: read('canvas.sweeperIntervalMs', 'CANVAS_SWEEPER_INTERVAL_MS'),
      defaultRowLimit: read('canvas.defaultRowLimit', 'CANVAS_DEFAULT_ROW_LIMIT'),
      schemaSniffRows: read('canvas.schemaSniffRows', 'CANVAS_SCHEMA_SNIFF_ROWS'),
    },
    openTelemetry: {
      enabled: read('openTelemetry.enabled', 'OTEL_ENABLED'),
      serviceName: read('openTelemetry.serviceName', 'OTEL_SERVICE_NAME'),
      serviceVersion: read('openTelemetry.serviceVersion', 'OTEL_SERVICE_VERSION'),
      tracesEndpoint: otlpSignalEndpoint(
        read,
        'openTelemetry.tracesEndpoint',
        'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        'v1/traces',
      ),
      metricsEndpoint: otlpSignalEndpoint(
        read,
        'openTelemetry.metricsEndpoint',
        'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
        'v1/metrics',
      ),
      logsEndpoint: read('openTelemetry.logsEndpoint', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'),
      samplingRatio: read('openTelemetry.samplingRatio', 'OTEL_TRACES_SAMPLER_ARG'),
      logLevel: read('openTelemetry.logLevel', 'OTEL_LOG_LEVEL'),
    },
    speech:
      env.SPEECH_TTS_ENABLED || env.SPEECH_STT_ENABLED
        ? {
            tts: env.SPEECH_TTS_ENABLED
              ? {
                  enabled: read('speech.tts.enabled', 'SPEECH_TTS_ENABLED'),
                  provider: read('speech.tts.provider', 'SPEECH_TTS_PROVIDER'),
                  apiKey: read('speech.tts.apiKey', 'SPEECH_TTS_API_KEY'),
                  baseUrl: read('speech.tts.baseUrl', 'SPEECH_TTS_BASE_URL'),
                  defaultVoiceId: read('speech.tts.defaultVoiceId', 'SPEECH_TTS_DEFAULT_VOICE_ID'),
                  defaultModelId: read('speech.tts.defaultModelId', 'SPEECH_TTS_DEFAULT_MODEL_ID'),
                  timeout: read('speech.tts.timeout', 'SPEECH_TTS_TIMEOUT'),
                }
              : undefined,
            stt: env.SPEECH_STT_ENABLED
              ? {
                  enabled: read('speech.stt.enabled', 'SPEECH_STT_ENABLED'),
                  provider: read('speech.stt.provider', 'SPEECH_STT_PROVIDER'),
                  apiKey: read('speech.stt.apiKey', 'SPEECH_STT_API_KEY'),
                  baseUrl: read('speech.stt.baseUrl', 'SPEECH_STT_BASE_URL'),
                  defaultModelId: read('speech.stt.defaultModelId', 'SPEECH_STT_DEFAULT_MODEL_ID'),
                  timeout: read('speech.stt.timeout', 'SPEECH_STT_TIMEOUT'),
                }
              : undefined,
          }
        : undefined,
    // The following fields will be derived and are not directly from env
    mcpServerName: read('mcpServerName', 'MCP_SERVER_NAME'),
    mcpServerVersion: read('mcpServerVersion', 'MCP_SERVER_VERSION'),
    mcpServerDescription: read('mcpServerDescription', 'MCP_SERVER_DESCRIPTION'),
    mcpServerHomepage: read('mcpServerHomepage', 'MCP_SERVER_HOMEPAGE'),
  };

  // Use a temporary schema to parse package info and provide defaults
  const pkgSchema = z.object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    homepage: z.string().optional(),
  });
  const parsedPkg = pkgSchema.parse(rawConfig.pkg);

  // Now add the derived values to the main rawConfig object to be parsed
  const finalRawConfig = {
    ...rawConfig,
    pkg: parsedPkg,
    logsPath:
      runtimeCaps.isNode && !runtimeCaps.isWorkerLike
        ? (() => {
            const logsDir = rawConfig.logsPath ?? 'logs';
            if (isAbsolute(logsDir)) return logsDir;
            // Anchored on the consuming application, never on this file's own
            // location: a path derived from the framework's install directory
            // can only ever land inside node_modules.
            return join(resolveAppRoot()?.dir ?? process.cwd(), logsDir);
          })()
        : undefined,
    mcpServerName: env.MCP_SERVER_NAME ?? parsedPkg.name,
    mcpServerVersion: env.MCP_SERVER_VERSION ?? parsedPkg.version,
    mcpServerDescription: env.MCP_SERVER_DESCRIPTION ?? parsedPkg.description,
    mcpServerKeywords: parsedPkg.keywords,
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
    const issues = toEnvIssues(parsedConfig.error.issues, envVarByPath);
    // Keep existing TTY error logging for developer convenience.
    if (process.stdout.isTTY) {
      console.error(
        '❌ Invalid configuration found. Please check your environment variables.',
        issues,
      );
    }
    // Throw a specific, typed error instead of exiting.
    throw configurationError(`Invalid application configuration:\n${formatEnvIssues(issues)}`, {
      validationErrors: z.flattenError(parsedConfig.error).fieldErrors,
      issues,
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

/**
 * The normalization `parseConfig` applies to every environment value before
 * schema validation. Exported so a caller deciding whether a variable carries
 * configuration reaches the same verdict this module does — an empty string and
 * an unsubstituted `${…}` placeholder both read as unset — instead of
 * re-implementing those rules and disagreeing with the parser.
 */
export { normalizeEnv } from './envValue.js';
export { parseEnvConfig } from './parseEnvConfig.js';
export { ConfigSchema, config, parseConfig, resetConfig };
