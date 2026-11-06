/**
 * @fileoverview The Worker string bindings `createWorkerHandler` copies into
 * `process.env` before core config is parsed, and the config variables it
 * leaves out, each with the reason it has no effect on a Worker. Internal: no
 * package export reaches this module.
 *
 * Every variable `parseConfig` reads is in exactly one of the two lists;
 * `tests/unit/core/worker.test.ts` fails when a new read is in neither, or an
 * entry names a variable the parser no longer reads.
 * @module src/core/workerEnvBindings
 */

/**
 * Config variables a same-named binding feeds. A Worker whose `process.env`
 * is not populated from its bindings (`nodejs_compat_do_not_populate_process_env`,
 * `disallow_importable_env`) receives only these and the renamed pair below.
 */
const SAME_NAMED_ENV_BINDINGS = [
  // Identity
  'MCP_SERVER_NAME',
  'MCP_SERVER_VERSION',
  'MCP_SERVER_DESCRIPTION',
  'MCP_SERVER_HOMEPAGE',
  'PACKAGE_NAME',
  'PACKAGE_VERSION',
  'PACKAGE_DESCRIPTION',
  'PACKAGE_KEYWORDS',
  // Logging
  'LOG_TOOL_FAILURE_PAYLOADS',
  'LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES',
  'MCP_LOG_RATE_LIMIT_THRESHOLD',
  'MCP_LOG_RATE_LIMIT_WINDOW_MS',
  'LOG_LLM_INTERACTIONS',
  // HTTP surface
  'MCP_HTTP_ENDPOINT_PATH',
  'MCP_HTTP_MAX_BODY_BYTES',
  'MCP_PUBLIC_URL',
  'MCP_ALLOWED_ORIGINS',
  'MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS',
  'MCP_HTTP_RESUMABILITY',
  'MCP_HTTP_RESUMABILITY_MAX_EVENTS',
  'MCP_HTTP_RESUMABILITY_TTL_MS',
  // Auth
  'MCP_AUTH_MODE',
  'MCP_AUTH_SECRET_KEY',
  'MCP_AUTH_DISABLE_SCOPE_CHECKS',
  'MCP_JWT_EXPECTED_AUDIENCE',
  'MCP_JWT_EXPECTED_ISSUER',
  'MCP_SERVER_RESOURCE_IDENTIFIER',
  'MCP_REQUEST_STATE_KEY',
  'OAUTH_ISSUER_URL',
  'OAUTH_AUDIENCE',
  'OAUTH_JWKS_URI',
  'OAUTH_JWKS_COOLDOWN_MS',
  'OAUTH_JWKS_TIMEOUT_MS',
  // Storage and canvas (`CANVAS_PROVIDER_TYPE=duckdb` must reach the factory to fail closed)
  'STORAGE_PROVIDER_TYPE',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CANVAS_PROVIDER_TYPE',
  // LLM
  'OPENROUTER_API_KEY',
  'OPENROUTER_APP_URL',
  'OPENROUTER_APP_NAME',
  'LLM_DEFAULT_MODEL',
  'LLM_DEFAULT_TEMPERATURE',
  'LLM_DEFAULT_TOP_P',
  'LLM_DEFAULT_MAX_TOKENS',
  'LLM_DEFAULT_TOP_K',
  'LLM_DEFAULT_MIN_P',
  // Speech
  'SPEECH_TTS_ENABLED',
  'SPEECH_TTS_PROVIDER',
  'SPEECH_TTS_API_KEY',
  'SPEECH_TTS_BASE_URL',
  'SPEECH_TTS_DEFAULT_VOICE_ID',
  'SPEECH_TTS_DEFAULT_MODEL_ID',
  'SPEECH_TTS_TIMEOUT',
  'SPEECH_STT_ENABLED',
  'SPEECH_STT_PROVIDER',
  'SPEECH_STT_API_KEY',
  'SPEECH_STT_BASE_URL',
  'SPEECH_STT_DEFAULT_MODEL_ID',
  'SPEECH_STT_TIMEOUT',
  // Telemetry (the service name and version name the scope of every framework span and meter)
  'OTEL_ENABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_VERSION',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
] as const;

/** Bindings named differently from the config variable they feed. */
const RENAMED_ENV_BINDINGS = [
  ['ENVIRONMENT', 'NODE_ENV'],
  ['LOG_LEVEL', 'MCP_LOG_LEVEL'],
] as const;

/** The string bindings `createWorkerHandler` reads, each optional. */
export type CoreStringBindings = {
  [Name in
    | (typeof SAME_NAMED_ENV_BINDINGS)[number]
    | (typeof RENAMED_ENV_BINDINGS)[number][0]]?: string;
};

/** `[bindingKey, processEnvKey]` for every core string binding, injected on each request. */
export const CORE_ENV_BINDINGS: ReadonlyArray<readonly [keyof CoreStringBindings, string]> = [
  ...RENAMED_ENV_BINDINGS,
  ...SAME_NAMED_ENV_BINDINGS.map((name) => [name, name] as const),
];

/**
 * Config variables no binding feeds, each with the reason it has no effect on
 * a Worker. On a Worker whose `process.env` is populated from its bindings, a
 * same-named binding still reaches the parser; an `extraEnvBindings` entry
 * reaches it on any Worker.
 */
export const EXCLUDED_ENV_NAMES: Readonly<Record<string, string>> = {
  MCP_TRANSPORT_TYPE: 'Set to http by the Worker itself.',
  MCP_SESSION_MODE: 'Workers take the sessionMode option, not the env session contract.',
  DEV_MCP_AUTH_BYPASS: 'Development-only auth bypass.',
  DEV_MCP_CLIENT_ID: 'Development-only auth bypass.',
  DEV_MCP_SCOPES: 'Development-only auth bypass.',
  MCP_HTTP_PORT: 'A Worker binds no listener.',
  MCP_HTTP_HOST: 'A Worker binds no listener.',
  MCP_HTTP_MAX_PORT_RETRIES: 'A Worker binds no listener.',
  MCP_HTTP_PORT_RETRY_DELAY_MS: 'A Worker binds no listener.',
  MCP_GC_PRESSURE_INTERVAL_MS: 'Read only by createApp.',
  MCP_HEARTBEAT_INTERVAL_MS: 'Read only by createApp.',
  MCP_HEARTBEAT_MISS_THRESHOLD: 'Read only by createApp.',
  LOGS_DIR: 'A Worker has no filesystem.',
  STORAGE_FILESYSTEM_PATH: 'A Worker has no filesystem.',
  CANVAS_DEFAULT_MEMORY_LIMIT_MB: 'DuckDB does not run on Workers.',
  CANVAS_EXPORT_PATH: 'DuckDB does not run on Workers.',
  CANVAS_TEMP_PATH: 'DuckDB does not run on Workers.',
  CANVAS_MAX_CANVASES_PER_TENANT: 'DuckDB does not run on Workers.',
  CANVAS_TTL_MS: 'DuckDB does not run on Workers.',
  CANVAS_ABSOLUTE_CAP_MS: 'DuckDB does not run on Workers.',
  CANVAS_SWEEPER_INTERVAL_MS: 'DuckDB does not run on Workers.',
  CANVAS_DEFAULT_ROW_LIMIT: 'DuckDB does not run on Workers.',
  CANVAS_SCHEMA_SNIFF_ROWS: 'DuckDB does not run on Workers.',
  OTEL_TRACES_SAMPLER_ARG: 'The OpenTelemetry SDK does not run on Workers.',
  OTEL_LOG_LEVEL: 'The OpenTelemetry SDK does not run on Workers.',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'The OpenTelemetry SDK does not run on Workers.',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'The OpenTelemetry SDK does not run on Workers.',
};
