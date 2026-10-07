/**
 * @fileoverview Pino-backed singleton logger with environment-adaptive output.
 * Implements RFC5424 level mapping, structured context carrying the request's OpenTelemetry
 * `traceId`/`spanId`, and graceful shutdown. In a serverless environment (like Cloudflare
 * Workers), it uses a lightweight console-based logger.
 * @module src/utils/internal/logger
 */
import type { LevelWithSilent, Logger as PinoLogger } from 'pino';
import pino from 'pino';

import { config } from '@/config/index.js';
import { toLogValue } from '@/utils/internal/logValue.js';
import {
  type RequestContext,
  requestContextService,
  toCanonicalContext,
} from '@/utils/internal/requestContext.js';
import { UNTHROTTLED_MESSAGES } from '@/utils/internal/telemetryMessages.js';

/**
 * RFC 5424 severity levels supported by the MCP logger, ordered from least to most severe.
 * A record is emitted at the pino level its MCP level maps to:
 * - `debug` → pino `debug`
 * - `info` / `notice` → pino `info`
 * - `warning` → pino `warn`
 * - `error` / `crit` → pino `error`
 * - `alert` / `emerg` → pino `fatal`
 *
 * The level filter ({@link Logger.isLevelEnabled}) compares on the RFC 5424 order of
 * all eight levels, never on that pino level, so two levels sharing one stay distinct.
 */
export type McpLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'crit'
  | 'alert'
  | 'emerg';

const mcpToPinoLevel: Record<McpLogLevel, LevelWithSilent> = {
  emerg: 'fatal',
  alert: 'fatal',
  crit: 'error',
  error: 'error',
  warning: 'warn',
  notice: 'info',
  info: 'info',
  debug: 'debug',
};

/** RFC 5424 severity per level: `emerg` is 0, `debug` 7, and a lower number is more severe. */
const RFC5424_SEVERITY: Record<McpLogLevel, number> = {
  emerg: 0,
  alert: 1,
  crit: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
};

/**
 * OTel `SeverityNumber` per MCP level. Each RFC 5424 level sharing a pino level
 * with a milder one takes the next step inside the same OTel range, so export
 * keeps the ordering pino collapses.
 */
const mcpToOtelSeverity: Record<McpLogLevel, number> = {
  debug: 5, // DEBUG
  info: 9, // INFO
  notice: 10, // INFO2
  warning: 13, // WARN
  error: 17, // ERROR
  crit: 18, // ERROR2
  alert: 21, // FATAL
  emerg: 22, // FATAL2
};

/**
 * Level every non-error sink is built with: the lowest the framework emits.
 * A transport target without its own `level` defaults to `info`, and target
 * levels are fixed when the transport is built, so anything higher would
 * filter records the logger's active level — the only intended gate — admits,
 * at startup and after {@link Logger.setLevel} alike.
 */
const ALL_RECORDS_LEVEL: LevelWithSilent = 'debug';

/** A `pino/file` transport target writing to a file path or file descriptor. */
function fileTarget(
  destination: string | number,
  level: LevelWithSilent = ALL_RECORDS_LEVEL,
): pino.TransportTargetOptions {
  return { level, target: 'pino/file', options: { destination } };
}

/** The three file sinks under `logsPath`. */
const FILE_SINK_NAMES = ['combined.log', 'error.log', 'interactions.log'] as const;

type FileSinkName = (typeof FILE_SINK_NAMES)[number];

/** A file sink the startup probe could not open, with the error code that stopped it. */
interface DroppedFileSink {
  code: string;
  name: FileSinkName;
  path: string;
}

/** Outcome of {@link probeFileSinks}: the openable destinations by name, and the rest. */
interface FileSinkProbe {
  dropped: DroppedFileSink[];
  writable: Partial<Record<FileSinkName, string>>;
}

/**
 * Opens each file sink under `dir` for append and closes it again,
 * synchronously, before any transport exists. `pino/file` opens its
 * destination inside the transport worker, where a failure surfaces as an
 * unhandled `'error'` that ends the process and takes the stderr sink sharing
 * that worker with it — so an unwritable destination has to be found here and
 * left out, not discovered there.
 *
 * A directory that cannot be created drops every sink under it with the
 * `mkdir` error code.
 *
 * @internal Exported only for unit testing. Not part of the public API.
 */
export async function probeFileSinks(dir: string): Promise<FileSinkProbe> {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const probe: FileSinkProbe = { dropped: [], writable: {} };
  const codeOf = (err: unknown) =>
    (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = codeOf(err);
    probe.dropped = FILE_SINK_NAMES.map((name) => ({ code, name, path: path.join(dir, name) }));
    return probe;
  }

  for (const name of FILE_SINK_NAMES) {
    const destination = path.join(dir, name);
    try {
      fs.closeSync(fs.openSync(destination, 'a'));
      probe.writable[name] = destination;
    } catch (err) {
      probe.dropped.push({ code: codeOf(err), name, path: destination });
    }
  }
  return probe;
}

/**
 * Evaluated at call time (not module load) so worker.ts can set
 * `process.env.IS_SERVERLESS = 'true'` before the first log call. The
 * `storageFactory` and `canvasFactory` modules already use this pattern;
 * mirroring it here closes the same gap for transport selection.
 */
function isServerless(): boolean {
  return typeof process === 'undefined' || process.env.IS_SERVERLESS === 'true';
}

/**
 * pino serializers for the process and `interactions.log` loggers. The
 * log-data walk has already written every `Error` as plain data, so `err`
 * passes through: pino's default would retype that object as `Object` and
 * copy any other field it carries.
 */
const PINO_SERIALIZERS = { err: (value: unknown) => value };

/**
 * Hard ceiling on distinct rate-limit keys retained between sweeps.
 *
 * Many framework log messages interpolate dynamic values (storage keys, tenant
 * IDs, canvas and table names, redacted URLs), so key cardinality tracks
 * traffic rather than code paths. A window-based sweep alone would let a
 * high-cardinality burst grow the map without bound inside a single window.
 */
const MAX_TRACKED_LOG_KEYS = 1000;

/**
 * How long {@link Logger.close} waits on one pino instance's drain.
 *
 * `flush(cb)` is unbounded by contract, and under workerd the callback never
 * arrives at all — an unbounded await there hangs every shutdown path that
 * reaches the logger (#342). Node and Bun call back in milliseconds, so this
 * window is orders of magnitude past a real drain: it ends a hang, it never
 * truncates a flush that is going to complete.
 */
const FLUSH_DRAIN_TIMEOUT_MS = 2_000;

/**
 * How many records are held while the logger is still uninitialized. Startup
 * emits a handful of lines; the cap exists so a runtime that never calls
 * {@link Logger.initialize} cannot grow the buffer without bound.
 */
const PRE_INIT_BUFFER_LIMIT = 250;

/** A record emitted before the sinks existed, replayed at initialization. */
interface PendingRecord {
  context?: RequestContext;
  error?: Error;
  level: McpLogLevel;
  msg: string;
}

/**
 * The fields a record carries from its request context to correlate it. At the
 * record's root, each one the context supplied is never redacted, so a name
 * added through `setSensitiveFields` (`session_id`, `id`) cannot cut every
 * record off from its request. A caller's key of the same name — in `extra`
 * when the context lacks that field, anywhere in caller data, and every key of
 * an `interactions.log` record, which has no context — is matched like any other.
 */
const CORRELATION_KEYS: ReadonlySet<string> = new Set([
  'operation',
  'requestId',
  'sessionId',
  'spanId',
  'tenantId',
  'timestamp',
  'traceId',
]);

/** The `base` the process logger writes on every line: constants only. */
function processLogBase(): Record<string, unknown> {
  return {
    env: config.environment,
    version: config.mcpServerVersion,
    pid: !isServerless() ? process.pid : undefined,
  };
}

/**
 * The fields the logger's pino instances write on a line themselves: `level`
 * and `time` before the record and `msg` after it, the process logger's
 * `base` ({@link processLogBase}), and pino's default `base` — `pid` and
 * `hostname` — on `interactions.log`. A record key with one of these names
 * would be a second copy in the line: a transport routes a line by the last
 * `level` it parses, so a caller's `level: 'high'` would drop the record from
 * stderr and `combined.log`, and a parser keeps the last `version`, so a
 * caller's would replace the server's.
 */
const LINE_FIELDS: ReadonlySet<string> = new Set([
  'level',
  'time',
  'msg',
  ...Object.keys(processLogBase()),
  'pid',
  'hostname',
]);

/**
 * The context a record's bindings were projected from, under a key only this
 * module holds. It rides the spread into pino's record and the OTLP bindings,
 * where {@link sanitizeLogBindings} reads which correlation fields the context
 * supplied; the walk never writes a symbol-keyed field.
 */
const RECORD_CONTEXT = Symbol('recordContext');

/** Bindings as {@link toBindings} builds them: the record's fields and the context they came from. */
type Bindings = Record<string, unknown> & { [RECORD_CONTEXT]?: Readonly<Record<string, unknown>> };

/** Moves `record[key]` to `data_<key>`, prefixed again while that name is taken. */
function moveLineField(record: Record<string, unknown>, key: string): void {
  let name = `data_${key}`;
  while (Object.hasOwn(record, name)) name = `data_${name}`;
  record[name] = record[key];
  delete record[key];
}

/**
 * Pino `formatters.log` hook, and the bindings of every exported OTel record:
 * the log-data walk ({@link toLogValue}) over the whole record. pino
 * therefore never receives an `Error` or a class instance — the method-bearing
 * handles on the framework `Context` and `ctx.signal` included — whatever
 * shape a caller gave its bindings. The walk is the only redaction: it is the
 * one path caller data takes into a written line, since neither pino logger
 * sets a `mixin`, binds a child, or carries anything in `base` but constants.
 * Exempt from it are the root correlation fields ({@link CORRELATION_KEYS})
 * that the record's context supplied, and a root key named after a field pino
 * writes on the line itself ({@link LINE_FIELDS}) is written as `data_<name>` —
 * prefixed again while that name is taken. `err` is such a field on a line
 * carrying an error argument, which {@link Logger} moves the same way before
 * attaching the error.
 *
 * @internal Exported only for unit testing. Not part of the public API.
 */
export function sanitizeLogBindings(obj: Record<string, unknown>): Record<string, unknown> {
  const supplied = (obj as Bindings)[RECORD_CONTEXT];
  const written = toLogValue(obj, {
    exemptRootKey: supplied && ((key) => CORRELATION_KEYS.has(key) && Object.hasOwn(supplied, key)),
  }) as Record<string, unknown>;
  // The walk's copy is a fresh object, so renaming in place touches no caller data.
  for (const key of LINE_FIELDS) {
    if (Object.hasOwn(written, key)) moveLineField(written, key);
  }
  return written;
}

/**
 * The walk's copy of `fields` a spread could not read (a getter, a revoked
 * Proxy): `'[Unreadable]'` where a read failed, and under `key` when nothing
 * could be read. A log call never throws on data it cannot read.
 */
function walkedFields(fields: unknown, key: string): Record<string, unknown> {
  const walked = toLogValue(fields);
  return walked !== null && typeof walked === 'object' && !Array.isArray(walked)
    ? (walked as Record<string, unknown>)
    : { [key]: walked };
}

/**
 * The bindings a record writes for `context`. `extra` is flattened rather than
 * nested so the line keeps the shape callers had when `RequestContext` was an
 * open bag. The projection runs first: `logger.info(msg, ctx)` with a handler
 * context is a documented call, and that object carries live request machinery
 * and the user-entered content in `inputs.responses` — none of which belongs in
 * a log line. The canonical fields are spread again after `extra`, so a caller's
 * key reusing a canonical name (`requestId`, `traceId`, …) never replaces the
 * context's value — the first spread only keeps them leading the line. The
 * canonical fields also ride along under {@link RECORD_CONTEXT}, so the walk
 * exempts only the correlation fields the context supplied. A context the
 * projection cannot read is projected from the walk's copy, and one with
 * nothing readable is written as `context: '[Unreadable]'`.
 */
function toBindings(context: RequestContext | undefined): Bindings {
  let projected: RequestContext;
  try {
    projected = toCanonicalContext((context ?? {}) as Readonly<Record<string, unknown>>);
  } catch {
    const walked = toLogValue(context);
    if (walked === null || typeof walked !== 'object') return { context: walked };
    projected = toCanonicalContext(walked as Readonly<Record<string, unknown>>);
  }
  const { extra, ...canonical } = projected;
  try {
    return { ...canonical, ...extra, ...canonical, [RECORD_CONTEXT]: canonical };
  } catch {
    return {
      ...canonical,
      ...walkedFields(extra, 'extra'),
      ...canonical,
      [RECORD_CONTEXT]: canonical,
    };
  }
}

/**
 * The walk's copy of a log call's error argument, as fields: `{}` when the walk
 * writes nothing for it, as for a function given `Error.prototype`, which passes
 * `instanceof Error` and is dropped like any other function.
 */
function errorFields(error: Error): Record<string, unknown> {
  const walked = toLogValue(error);
  return walked !== null && typeof walked === 'object' ? (walked as Record<string, unknown>) : {};
}

/** Whether `value` is an `Error`; a value `instanceof` cannot inspect (a revoked Proxy) is not. */
function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * The record shape an OTel Logs API `Logger` accepts, narrowed to the fields
 * the framework sets. Declared here rather than imported so this module's
 * public types never require the optional `@opentelemetry/api-logs` peer.
 *
 * @internal Exported only for tests that capture records. Not part of the public API.
 */
export interface OtelLogRecord {
  attributes: Record<string, OtelAttributeValue>;
  body: string;
  severityNumber: number;
  severityText: McpLogLevel;
}

/** An attribute value as the OTel Logs API `AnyValue` accepts it. */
type OtelAttributeValue =
  | string
  | number
  | boolean
  | Uint8Array
  | null
  | undefined
  | OtelAttributeValue[]
  | { [key: string]: OtelAttributeValue };

/** The one method of an OTel Logs API `Logger` the framework logger calls. */
interface OtelLogSink {
  emit(record: OtelLogRecord): void;
}

/**
 * Converts one walked binding into an attribute value. The walk has already
 * written every `Error` as plain data and redacted every sensitive field, so
 * all that is left is a primitive JSON has no form for, which becomes its string.
 */
function toExportValue(value: unknown): OtelAttributeValue {
  if (Array.isArray(value)) return value.map(toExportValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, toExportValue(field)]),
    );
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  return value as OtelAttributeValue;
}

/**
 * Builds the OTel record for one framework log line: the message as the body,
 * the bindings the process log writes as attributes, and an `Error` argument as
 * the `exception.*` semantic-convention attributes, read through the walk, so a
 * field whose read throws is exported as `'[Unreadable]'` and one the walk does
 * not write is left out, rather than failing the log call. Trace context is
 * left to the Logs API, which takes it from the active context at emit time.
 */
function toOtelLogRecord(
  level: McpLogLevel,
  msg: string,
  bindings: Bindings,
  error?: Error,
): OtelLogRecord {
  const attributes = toExportValue(sanitizeLogBindings(bindings)) as Record<
    string,
    OtelAttributeValue
  >;
  if (error) {
    const { type, message, stack } = errorFields(error);
    if (type !== undefined) attributes['exception.type'] = toExportValue(type);
    if (message !== undefined) attributes['exception.message'] = toExportValue(message);
    if (stack) attributes['exception.stacktrace'] = toExportValue(stack);
  }
  return {
    attributes,
    body: msg,
    severityNumber: mcpToOtelSeverity[level],
    severityText: level,
  };
}

/** The OTel Logs API sink every written record is also emitted to, when attached. */
let otelLogSink: OtelLogSink | undefined;

/**
 * Attaches (or, with `undefined`, detaches) the OTel Logs API sink that every
 * record passing the logger's level filter and rate limit is also emitted to.
 * `initializeOpenTelemetry` attaches it when OTLP log export is configured
 * and `shutdownOpenTelemetry` detaches it.
 *
 * A module function rather than a `Logger` method, so the published `Logger`
 * type carries no telemetry-lifecycle hook.
 *
 * @internal Called by the telemetry lifecycle and tests. Not part of the public API.
 */
export function setOtelLogSink(sink: OtelLogSink | undefined): void {
  otelLogSink = sink;
}

/**
 * Singleton structured logger backed by Pino with RFC 5424 level semantics.
 *
 * Features:
 * - Environment-adaptive output: pretty-printed (pino-pretty) in HTTP development mode,
 *   JSON to stderr in stdio/production mode (MCP spec requires clean stdout).
 * - Optional file sinks: `combined.log` with every record the active level admits,
 *   `error.log` for errors and above, and `interactions.log` for structured
 *   interaction records. A file sink that cannot be opened at startup is dropped
 *   with one `warning` naming it; the process and the remaining sinks carry on.
 * - Optional OTel log export: once `initializeOpenTelemetry` attaches a Logs API
 *   sink, every record that passes the level filter and rate limit is also emitted
 *   there, with the same fields as the pino output — except the error argument,
 *   which is exported as the `exception.*` attributes instead of an `err` field.
 * - One walk over every record's data ({@link sanitizeLogBindings}), and the only
 *   redaction: each `Error`, under any key, written as `type`/`message`/`stack`
 *   (plus a string or `McpError` `code`, an `McpError`'s `data`, and `cause`/`errors`
 *   in the same shape, a stack shared with the parent error written once); objects
 *   kept through 15 levels below the record root and one 16 levels down written as
 *   `'[MaxDepth]'`; at most 400,000 reads — one per object and per other field or
 *   array element, ten per object at the depth bound — so data a getter, a Proxy, or a
 *   `toJSON()` builds on every read stops at `'[Truncated]'`; at most 16 MiB
 *   (16,777,216) characters of strings, field names, and primitives written, repeated
 *   or not, then `'[Truncated]'` and the walk stops, so a 10 MB string is written whole
 *   and a 20 MB one is not; repeated content — an object reached again through a shared
 *   reference, or a string or field name of 1,024 characters or more written again —
 *   also charged about the characters it writes against 1,000,000, and written as
 *   `'[Truncated]'` where that runs out; cycles written as `'[Circular]'`; a value
 *   whose read throws written as `'[Unreadable]'`; and every key the shared matcher
 *   (`isSensitiveKey`) matches redacted at every depth kept, except the correlation
 *   fields the record's context supplied, at its root.
 * - Rate limiting per level + message to suppress log storms, configurable via
 *   `MCP_LOG_RATE_LIMIT_THRESHOLD` (0 disables) and `MCP_LOG_RATE_LIMIT_WINDOW_MS`.
 *   Suppressed counts are flushed at `warning` once a window has elapsed, on
 *   the next log call or at {@link Logger.close} — traffic-driven rather than
 *   timer-driven, so the bookkeeping stays bounded on serverless runtimes. The
 *   framework's per-call telemetry lines (see `telemetryMessages.ts`) bypass the
 *   limiter, since their repetition is request throughput rather than a storm.
 * - Records emitted before {@link Logger.initialize} are held in a bounded buffer
 *   and replayed once the sinks exist, so boot-time lines from service
 *   composition and a consumer's `setup()` hook are not silently dropped.
 * - OpenTelemetry trace context is auto-injected via {@link RequestContext} fields.
 * - Serverless-safe: when `IS_SERVERLESS=true` or `process` is unavailable, falls
 *   back to minimal Pino config without file transports or Node.js APIs.
 *
 * Obtain the singleton via {@link logger} or `Logger.getInstance()`.
 */
export class Logger {
  private static readonly instance: Logger = new Logger();
  private pinoLogger?: PinoLogger;
  private interactionLogger?: PinoLogger | undefined;
  private initialized = false;
  private currentMcpLevel: McpLogLevel = 'info';
  private transportType: 'stdio' | 'http' | undefined;

  private rateLimitThreshold = config.logRateLimitThreshold;
  private rateLimitWindow = config.logRateLimitWindowMs;
  private messageCounts = new Map<string, { count: number; firstSeen: number }>();
  private suppressedMessages = new Map<string, number>();
  private lastSweep = Date.now();
  private pendingRecords: PendingRecord[] = [];
  private droppedPendingRecords = 0;
  private everInitialized = false;
  /** Set when the startup probe dropped `interactions.log`, which the startup warning already reported. */
  private interactionSinkDropped = false;

  private constructor() {
    // The constructor is now safe to call in a global scope.
  }

  /**
   * Returns the singleton `Logger` instance.
   *
   * Prefer importing the pre-resolved {@link logger} export rather than calling this directly.
   *
   * @returns The singleton `Logger` instance.
   * @example
   * ```ts
   * import { Logger } from '@/utils/internal/logger.js';
   * const log = Logger.getInstance();
   * ```
   */
  public static getInstance(): Logger {
    return Logger.instance;
  }

  private async createPinoLogger(
    level: McpLogLevel,
    transportType: 'stdio' | 'http' | undefined,
    fileSinks: FileSinkProbe['writable'],
  ): Promise<PinoLogger> {
    const pinoLevel = mcpToPinoLevel[level] ?? 'info';

    const pinoOptions: pino.LoggerOptions = {
      level: pinoLevel,
      base: processLogBase(),
      formatters: {
        log: sanitizeLogBindings,
      },
      serializers: PINO_SERIALIZERS,
    };

    if (isServerless()) {
      return pino(pinoOptions);
    }

    const transports: pino.TransportTargetOptions[] = [];
    const isDevelopment = config.environment === 'development';
    const isTest = config.environment === 'testing';

    // CRITICAL: STDIO transport MUST NOT output colored logs to stdout.
    // The MCP specification requires clean JSON-RPC on stdout with no ANSI codes.
    // Only use pretty/colored output for HTTP mode or when explicitly debugging.
    // Respect NO_COLOR environment variable (https://no-color.org/)
    const noColorEnv = process.env.NO_COLOR === '1' || process.env.FORCE_COLOR === '0';
    const useColoredOutput = isDevelopment && transportType !== 'stdio' && !noColorEnv;

    if (useColoredOutput && !isServerless()) {
      // Try to resolve 'pino-pretty' robustly even when bundled (e.g., Bun/ESM),
      // falling back to JSON stdout if resolution fails.
      try {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const prettyTarget = require.resolve('pino-pretty');
        transports.push({
          level: ALL_RECORDS_LEVEL,
          target: prettyTarget,
          options: { colorize: true, translateTime: 'yyyy-mm-dd HH:MM:ss' },
        });
      } catch (err) {
        // Only log to console if TTY to avoid polluting stderr in STDIO mode
        if (process.stderr?.isTTY) {
          console.warn(
            `[Logger Init] Pretty transport unavailable (${err instanceof Error ? err.message : String(err)}); falling back to stdout JSON.`,
          );
        }
        transports.push(fileTarget(1));
      }
    } else if (!isTest) {
      // CRITICAL: For STDIO transport, logs MUST go to stderr (fd 2), NOT stdout (fd 1).
      // The MCP specification requires only JSON-RPC messages on stdout.
      // For HTTP transport or production, we also use stderr to avoid polluting stdout.
      transports.push(fileTarget(2));
    }

    if (fileSinks['combined.log']) transports.push(fileTarget(fileSinks['combined.log']));
    if (fileSinks['error.log']) transports.push(fileTarget(fileSinks['error.log'], 'error'));

    return pino({ ...pinoOptions, transport: { targets: transports } });
  }

  private createInteractionLogger(destination: string | undefined): PinoLogger | undefined {
    if (!destination) return;

    return pino({
      formatters: {
        log: sanitizeLogBindings,
      },
      serializers: PINO_SERIALIZERS,
      transport: {
        target: 'pino/file',
        options: { destination },
      },
    });
  }

  /**
   * Initializes the logger, constructing Pino transports appropriate for the environment.
   *
   * Must be called once at server startup before any log methods are used. Subsequent calls
   * are no-ops (a warning is emitted instead). After initialization, a startup `info` entry
   * is written confirming the active level.
   *
   * @param level - MCP log level to apply. Defaults to `'info'`.
   * @param transportType - Active transport (`'stdio'` or `'http'`). Determines whether
   *   colored pretty-print output is enabled. In `'stdio'` mode, logs are always written
   *   to stderr (fd 2) to preserve stdout for MCP JSON-RPC.
   * @returns Promise that resolves when Pino transports and file sinks are ready.
   * @example
   * ```ts
   * await logger.initialize('debug', 'http');
   * ```
   */
  public async initialize(
    level: McpLogLevel = 'info',
    transportType?: 'stdio' | 'http',
  ): Promise<void> {
    if (this.initialized) {
      this.warning(
        'Logger already initialized.',
        requestContextService.createRequestContext({
          operation: 'loggerReinit',
        }),
      );
      return;
    }
    this.currentMcpLevel = level;
    this.transportType = transportType;
    const fileSinks: FileSinkProbe =
      !isServerless() && config.logsPath
        ? await probeFileSinks(config.logsPath)
        : { dropped: [], writable: {} };
    this.pinoLogger = await this.createPinoLogger(level, transportType, fileSinks.writable);
    this.interactionLogger = this.createInteractionLogger(fileSinks.writable['interactions.log']);
    this.interactionSinkDropped = fileSinks.dropped.some(
      (sink) => sink.name === 'interactions.log',
    );

    this.lastSweep = Date.now();
    this.initialized = true;
    this.everInitialized = true;
    this.info(
      `Logger initialized. MCP level: ${level}.`,
      requestContextService.createRequestContext({ operation: 'loggerInit' }),
    );
    this.reportDroppedFileSinks(fileSinks.dropped);
    this.replayPendingRecords();
  }

  /** Emits the one warning that names every file sink the startup probe dropped. */
  private reportDroppedFileSinks(dropped: readonly DroppedFileSink[]): void {
    if (dropped.length === 0) return;
    const detail = dropped.map((sink) => `${sink.path} (${sink.code})`).join(', ');
    this.warning(
      `File logging disabled for ${dropped.length} sink(s): ${detail}. Point LOGS_DIR at a writable directory to restore them.`,
      requestContextService.createRequestContext({
        operation: 'loggerInit',
        additionalContext: { droppedLogFiles: dropped },
      }),
    );
  }

  /**
   * Changes the active log level at runtime without restarting transports.
   *
   * Has no effect if the logger has not been initialized; a console error is emitted
   * to stderr when running in a TTY. After the level is updated, an `info` entry is
   * written to confirm the change.
   *
   * @param newLevel - The new MCP log level to apply.
   * @example
   * ```ts
   * logger.setLevel('debug');
   * ```
   */
  public setLevel(newLevel: McpLogLevel): void {
    if (!this.pinoLogger || !this.initialized) {
      // Only log to console if TTY to avoid polluting stderr in STDIO mode
      if (process.stderr?.isTTY) {
        console.error('Cannot set level: Logger not initialized.');
      }
      return;
    }
    this.currentMcpLevel = newLevel;
    this.pinoLogger.level = mcpToPinoLevel[newLevel] ?? 'info';
    this.info(
      `Log level changed to ${newLevel}.`,
      requestContextService.createRequestContext({
        operation: 'loggerSetLevel',
      }),
    );
  }

  /**
   * Implements the `AsyncDisposable` protocol (`await using logger`).
   *
   * Delegates to {@link close}. Allows the logger to be used with `await using` in
   * TypeScript 5.2+ explicit resource management contexts.
   *
   * @returns Promise that resolves when all transports have been flushed and closed.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    return await this.close();
  }

  /**
   * Reports a drain problem on the only channel available while the logger is
   * shutting down — and only an interactive one. In stdio mode stderr carries
   * the server's log stream, so a bare console line there is noise a host has
   * to filter; the pino instance that would normally carry it is the thing that
   * just failed.
   */
  private reportFlushProblem(message: string, detail?: unknown): void {
    if (typeof process === 'undefined') return;
    if (!process.stderr?.isTTY || this.transportType === 'stdio') return;
    if (detail === undefined) console.error(message);
    else console.error(message, detail);
  }

  /**
   * Flushes all pending log entries and shuts down transports gracefully.
   *
   * Flushes any outstanding suppressed message counts,
   * and waits for both the main Pino logger and the interaction logger to drain
   * before resolving. Safe to call multiple times — subsequent calls on an
   * already-closed logger resolve immediately.
   *
   * Each drain is bounded. A completing flush callback is awaited in full; a
   * runtime whose pino instance never calls back (workerd — #342) releases the
   * shutdown path after {@link FLUSH_DRAIN_TIMEOUT_MS} instead of hanging it.
   *
   * @returns Promise that resolves when all writes have completed.
   * @example
   * ```ts
   * process.on('SIGTERM', () => logger.close());
   * ```
   */
  public async close(): Promise<void> {
    if (!this.initialized) return Promise.resolve();
    this.info(
      'Logger shutting down.',
      requestContextService.createRequestContext({ operation: 'loggerClose' }),
    );
    this.flushSuppressedMessages();

    // Wait for pending writes, but never longer than the drain window.
    const flushPino = (pinoInstance: PinoLogger | undefined, label: string) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (pinoInstance != null) {
        const drainTimeout = setTimeout(() => {
          this.reportFlushProblem(
            `Timed out flushing ${label} after ${FLUSH_DRAIN_TIMEOUT_MS}ms; continuing shutdown.`,
          );
          resolve();
        }, FLUSH_DRAIN_TIMEOUT_MS);
        pinoInstance.flush((err) => {
          clearTimeout(drainTimeout);
          if (err) this.reportFlushProblem(`Error flushing ${label}:`, err);
          resolve();
        });
      } else {
        resolve();
      }
      return promise;
    };

    await Promise.all([
      flushPino(this.pinoLogger, 'main logger'),
      flushPino(this.interactionLogger, 'interaction logger'),
    ]);

    this.initialized = false;
  }

  /**
   * Returns whether the logger has been successfully initialized.
   *
   * Use this to guard code that should only run after {@link initialize} has resolved,
   * or to skip logging in contexts where initialization may not have occurred.
   *
   * @returns `true` if {@link initialize} has completed and {@link close} has not yet been called.
   * @example
   * ```ts
   * if (logger.isInitialized()) {
   *   logger.info('Server ready', ctx);
   * }
   * ```
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Returns whether a record at `level` passes the active level — the check that
   * gates every sink this logger writes and the `ctx.log` mirror to the client.
   *
   * Compares on the RFC 5424 order of the eight levels, not on the pino level a
   * record is emitted at, so a `notice` level drops `info` and a `crit` level
   * drops `error`. Returns `true` before {@link initialize}: the level is not
   * known yet, so filtering waits for it, as it does for the records held until then.
   *
   * @param level - The level a record would be logged at.
   * @returns `true` when a record at `level` would be written.
   * @example
   * ```ts
   * if (logger.isLevelEnabled('debug')) logger.debug('Cache state', withExtra(ctx, cache.dump()));
   * ```
   */
  public isLevelEnabled(level: McpLogLevel): boolean {
    if (!this.everInitialized) return true;
    return RFC5424_SEVERITY[level] <= RFC5424_SEVERITY[this.currentMcpLevel];
  }

  /**
   * Evicts expired rate-limit bookkeeping and flushes the suppression record.
   *
   * Replaces the `setInterval` this class used to arm in {@link initialize},
   * which was skipped entirely on serverless runtimes: with no timer and no
   * `close()` in a Worker isolate, `messageCounts` and `suppressedMessages`
   * grew for the isolate's whole lifetime and the "suppressed N times" record
   * was never emitted. Driving the sweep from log calls keeps the timer's
   * cadence wherever traffic exists and bounds the maps on every runtime,
   * without runtime-specific scheduling.
   *
   * @param now - Current epoch milliseconds, shared with the caller's window math.
   */
  private maybeSweep(now: number): void {
    const windowElapsed = now - this.lastSweep >= this.rateLimitWindow;
    if (!windowElapsed && this.messageCounts.size < MAX_TRACKED_LOG_KEYS) return;

    // Claim the sweep before emitting: flushing logs through `log()`, which
    // re-enters this method. Both guards are false by the time it does.
    this.lastSweep = now;

    for (const [key, entry] of this.messageCounts) {
      if (now - entry.firstSeen > this.rateLimitWindow) this.messageCounts.delete(key);
    }

    // A burst of distinct messages within a single window survives the expiry
    // pass. Drop the oldest — they are the closest to expiring anyway.
    const excess = this.messageCounts.size - MAX_TRACKED_LOG_KEYS + 1;
    if (excess > 0) {
      const oldestFirst = [...this.messageCounts.entries()].sort(
        (a, b) => a[1].firstSeen - b[1].firstSeen,
      );
      for (const [key] of oldestFirst.slice(0, excess)) this.messageCounts.delete(key);
    }

    this.flushSuppressedMessages();
  }

  private isRateLimited(level: McpLogLevel, message: string): boolean {
    // Threshold 0 disables rate limiting entirely.
    if (this.rateLimitThreshold === 0) return false;

    // Per-call telemetry lines are one-per-request by construction, so their
    // repetition is throughput rather than a storm. Limiting them would cap
    // log-derived call volume at the threshold and silently drop the rest.
    if (UNTHROTTLED_MESSAGES.has(message)) return false;

    const now = Date.now();
    this.maybeSweep(now);

    // Key on level + message: an error storm and ordinary info throughput that
    // happen to share a string are different events and must not share a budget.
    const key = `${level}:${message}`;
    const entry = this.messageCounts.get(key);
    if (!entry) {
      this.messageCounts.set(key, { count: 1, firstSeen: now });
      return false;
    }
    if (now - entry.firstSeen > this.rateLimitWindow) {
      this.messageCounts.set(key, { count: 1, firstSeen: now });
      return false;
    }
    entry.count++;
    if (entry.count > this.rateLimitThreshold) {
      this.suppressedMessages.set(key, (this.suppressedMessages.get(key) || 0) + 1);
      return true;
    }
    return false;
  }

  private flushSuppressedMessages(): void {
    // Snapshot and clear before emitting — each notice goes back through
    // `log()`, which can write to `suppressedMessages`, and mutating the map
    // mid-iteration would drop or double-count entries.
    const pending = [...this.suppressedMessages.entries()];
    this.suppressedMessages.clear();

    for (const [key, count] of pending) {
      // Emitted at `warning`, not `debug`: suppression happens at `info` and
      // above, so a debug-level notice is filtered out at exactly the levels
      // where lines are being dropped — leaving a truncated log that reads as
      // a quiet one. The threshold and window are included so the reader can
      // act on it (raise MCP_LOG_RATE_LIMIT_THRESHOLD, or set it to 0).
      this.warning(
        `Suppressed ${count} occurrences of "${key}" — rate limit is ${this.rateLimitThreshold} per ${this.rateLimitWindow}ms.`,
        requestContextService.createRequestContext({
          operation: 'loggerRateLimitFlush',
          additionalContext: {
            suppressedKey: key,
            suppressedCount: count,
            rateLimitThreshold: this.rateLimitThreshold,
            rateLimitWindowMs: this.rateLimitWindow,
          },
        }),
      );
    }
  }

  /**
   * Holds a record emitted before {@link initialize} so it can reach a sink
   * once one exists. Composition runs ahead of logger setup — a consumer's
   * `setup()` hook is the common case — and a record dropped there is exactly
   * the boot-time success announce or degrade-path warning an operator needs.
   *
   * Level filtering is deliberately deferred to the replay: the active level is
   * not known until {@link initialize} receives it.
   */
  private holdPendingRecord(
    level: McpLogLevel,
    msg: string,
    context?: RequestContext,
    error?: Error,
  ): void {
    // After a `close()`, the sinks are gone for good — nothing to replay into.
    if (this.everInitialized) return;
    if (this.pendingRecords.length >= PRE_INIT_BUFFER_LIMIT) {
      this.droppedPendingRecords++;
      return;
    }
    this.pendingRecords.push({
      level,
      msg,
      ...(context && { context }),
      ...(error && { error }),
    });
  }

  /** Replays held records through the now-live sinks, then reports any overflow. */
  private replayPendingRecords(): void {
    const pending = this.pendingRecords;
    const dropped = this.droppedPendingRecords;
    this.pendingRecords = [];
    this.droppedPendingRecords = 0;

    for (const record of pending) {
      this.log(record.level, record.msg, record.context, record.error);
    }

    if (dropped > 0) {
      this.warning(
        `Dropped ${dropped} record(s) logged before initialization — the pre-init buffer holds ${PRE_INIT_BUFFER_LIMIT}.`,
        requestContextService.createRequestContext({
          operation: 'loggerPreInitOverflow',
          additionalContext: { droppedRecords: dropped, bufferLimit: PRE_INIT_BUFFER_LIMIT },
        }),
      );
    }
  }

  /**
   * Writes any held pre-init records to stderr and clears them.
   *
   * For startup paths that end the process before {@link initialize} runs: the
   * records describe what the failing boot was doing, so they are worth more on
   * stderr than discarded. Never writes to stdout, which stdio transport owns.
   * An error's message is read through the walk, so one whose read throws is
   * written as `'[Unreadable]'`, one the walk writes no message for is left
   * off, and neither replaces the error that ended the boot.
   *
   * @example
   * ```ts
   * catch (err) { logger.drainPendingToStderr(); throw err; }
   * ```
   */
  public drainPendingToStderr(): void {
    if (this.pendingRecords.length === 0) return;
    // Checked before the records are cleared: a runtime with no stderr keeps them.
    if (typeof process === 'undefined' || typeof process.stderr?.write !== 'function') return;

    const lines = this.pendingRecords.map(({ error, level, msg }) => {
      const message = error && errorFields(error).message;
      return message === undefined
        ? `[pre-init ${level}] ${msg}`
        : `[pre-init ${level}] ${msg} — ${message}`;
    });
    if (this.droppedPendingRecords > 0) {
      lines.push(
        `[pre-init] ${this.droppedPendingRecords} further record(s) dropped — buffer holds ${PRE_INIT_BUFFER_LIMIT}.`,
      );
    }
    this.pendingRecords = [];
    this.droppedPendingRecords = 0;
    process.stderr.write(`${lines.join('\n')}\n`);
  }

  private log(level: McpLogLevel, msg: string, context?: RequestContext, error?: Error): void {
    if (!this.pinoLogger || !this.initialized) {
      this.holdPendingRecord(level, msg, context, error);
      return;
    }

    if (!this.isLevelEnabled(level) || this.isRateLimited(level, msg)) return;
    const pinoLevel = mcpToPinoLevel[level] ?? 'info';

    const bindings = toBindings(context);
    // The error argument rides the `err` key; pino's `formatters.log` walk writes
    // it like any other Error in the record, and the `err` serializer passes the result through.
    // It leads the record, so the walk, which works in key order, writes it before caller data
    // can spend the walk's bound. On that line `err` is the logger's own field, so a caller's
    // `err` moves aside like any line field.
    if (error && Object.hasOwn(bindings, 'err')) moveLineField(bindings, 'err');
    this.pinoLogger[pinoLevel](error ? { err: error, ...bindings } : bindings, msg);
    otelLogSink?.emit(toOtelLogRecord(level, msg, bindings, error));
  }

  private logWithError(
    level: McpLogLevel,
    msg: string,
    errorOrContext: Error | RequestContext,
    context?: RequestContext,
  ): void {
    if (isError(errorOrContext)) {
      this.log(level, msg, context, errorOrContext);
    } else {
      this.log(level, msg, errorOrContext);
    }
  }

  /**
   * Logs a diagnostic message at `debug` severity (RFC 5424 level 7).
   *
   * Suppressed unless the active log level is `'debug'`. Use for verbose tracing,
   * internal state dumps, and low-level request/response details.
   *
   * @param msg - Human-readable log message.
   * @param context - Optional request context providing `requestId`, `traceId`, and related fields.
   * @example
   * ```ts
   * logger.debug('Cache miss', ctx);
   * ```
   */
  public debug(msg: string, context?: RequestContext): void {
    this.log('debug', msg, context);
  }

  /**
   * Logs an informational message at `info` severity (RFC 5424 level 6).
   *
   * Use for normal operational events: server startup, request completions, configuration loaded.
   *
   * @param msg - Human-readable log message.
   * @param context - Optional request context.
   * @example
   * ```ts
   * logger.info('Server listening on :3000', ctx);
   * ```
   */
  public info(msg: string, context?: RequestContext): void {
    this.log('info', msg, context);
  }

  /**
   * Logs a notice-level message at `notice` severity (RFC 5424 level 5).
   *
   * Use for significant but non-error conditions: configuration changes, deprecation notices,
   * expected state transitions worth tracking. Maps to pino `info` level internally.
   *
   * @param msg - Human-readable log message.
   * @param context - Optional request context.
   * @example
   * ```ts
   * logger.notice('Feature flag toggled', ctx);
   * ```
   */
  public notice(msg: string, context?: RequestContext): void {
    this.log('notice', msg, context);
  }

  /**
   * Logs a warning message at `warning` severity (RFC 5424 level 4).
   *
   * Use for recoverable abnormal conditions: deprecated API usage, retried operations,
   * non-fatal misconfigurations. Maps to pino `warn` level internally.
   *
   * @param msg - Human-readable log message.
   * @param context - Optional request context.
   * @example
   * ```ts
   * logger.warning('Rate limit approaching', ctx);
   * ```
   */
  public warning(msg: string, context?: RequestContext): void {
    this.log('warning', msg, context);
  }

  /**
   * Logs an error-level message at `error` severity (RFC 5424 level 3).
   *
   * Use when an operation fails but the server can continue. The `errorOrContext`
   * parameter accepts either an `Error` (written under `err` as its `type`, `message`,
   * `stack`, and the other fields every logged Error carries — see {@link sanitizeLogBindings})
   * or a `RequestContext` when no error object is available. Maps to pino `error` level.
   *
   * @param msg - Human-readable description of the failure.
   * @param errorOrContext - The `Error` to serialize, or a `RequestContext` if no error object exists.
   * @param context - Request context; required when `errorOrContext` is an `Error`.
   * @example
   * ```ts
   * logger.error('Failed to fetch resource', err, ctx);
   * logger.error('Invalid state encountered', ctx);
   * ```
   */
  public error(
    msg: string,
    errorOrContext: Error | RequestContext,
    context?: RequestContext,
  ): void {
    this.logWithError('error', msg, errorOrContext, context);
  }

  /**
   * Logs a critical error at `crit` severity (RFC 5424 level 2).
   *
   * Use for serious failures that impair a subsystem but do not crash the process —
   * for example, a storage provider going offline. Maps to pino `error` level.
   *
   * @param msg - Human-readable description of the critical condition.
   * @param errorOrContext - The `Error` to serialize, or a `RequestContext` if no error object exists.
   * @param context - Request context; required when `errorOrContext` is an `Error`.
   * @example
   * ```ts
   * logger.crit('Database connection pool exhausted', err, ctx);
   * ```
   */
  public crit(msg: string, errorOrContext: Error | RequestContext, context?: RequestContext): void {
    this.logWithError('crit', msg, errorOrContext, context);
  }

  /**
   * Logs an alert-level message at `alert` severity (RFC 5424 level 1).
   *
   * Use when immediate human intervention is required — for example, a security breach
   * detected or critical data loss imminent. Maps to pino `fatal` level.
   *
   * @param msg - Human-readable description of the alert condition.
   * @param errorOrContext - The `Error` to serialize, or a `RequestContext` if no error object exists.
   * @param context - Request context; required when `errorOrContext` is an `Error`.
   * @example
   * ```ts
   * logger.alert('Unauthorized admin access detected', err, ctx);
   * ```
   */
  public alert(
    msg: string,
    errorOrContext: Error | RequestContext,
    context?: RequestContext,
  ): void {
    this.logWithError('alert', msg, errorOrContext, context);
  }

  /**
   * Logs an emergency-level message at `emerg` severity (RFC 5424 level 0).
   *
   * Use for conditions that render the system completely unusable — process about to exit,
   * unrecoverable internal state. Maps to pino `fatal` level.
   *
   * @param msg - Human-readable description of the emergency.
   * @param errorOrContext - The `Error` to serialize, or a `RequestContext` if no error object exists.
   * @param context - Request context; required when `errorOrContext` is an `Error`.
   * @example
   * ```ts
   * logger.emerg('Unrecoverable state — shutting down', err, ctx);
   * ```
   */
  public emerg(
    msg: string,
    errorOrContext: Error | RequestContext,
    context?: RequestContext,
  ): void {
    this.logWithError('emerg', msg, errorOrContext, context);
  }

  /**
   * Alias for {@link emerg}. Provided for callers familiar with the pino/winston `fatal` level.
   *
   * Maps to RFC 5424 `emerg` (level 0) and pino `fatal` internally.
   *
   * @param msg - Human-readable description of the fatal condition.
   * @param errorOrContext - The `Error` to serialize, or a `RequestContext` if no error object exists.
   * @param context - Request context; required when `errorOrContext` is an `Error`.
   * @example
   * ```ts
   * logger.fatal('Process terminating due to unhandled exception', err, ctx);
   * ```
   */
  public fatal(
    msg: string,
    errorOrContext: Error | RequestContext,
    context?: RequestContext,
  ): void {
    this.emerg(msg, errorOrContext, context);
  }

  /**
   * Writes a structured interaction record to the dedicated `interactions.log` file sink.
   *
   * Interaction logs capture high-level semantic events (tool invocations, resource reads,
   * prompt renders) as structured JSON, separate from the main operational log stream.
   * This sink is only available when `config.logsPath` is set and the runtime is not serverless;
   * a `warning` is emitted if the logger is called before the sink is ready.
   *
   * @param interactionName - Identifier for the interaction type (e.g., `'tool:my_tool'`).
   * @param data - Arbitrary structured data to include alongside `interactionName` in the log record.
   * @example
   * ```ts
   * logger.logInteraction('tool:echo_message', { requestId: ctx.requestId, input });
   * ```
   */
  public logInteraction(interactionName: string, data: Record<string, unknown>): void {
    let record: Record<string, unknown>;
    try {
      record = { interactionName, ...data };
    } catch {
      record = { interactionName, ...walkedFields(data, 'data') };
    }
    if (!this.interactionLogger) {
      if (!isServerless() && !this.interactionSinkDropped) {
        this.warning('Interaction logger not available.', record.context as RequestContext);
      }
      return;
    }
    this.interactionLogger.info(record);
  }
}

/**
 * Pre-resolved singleton logger instance. Import this directly rather than calling
 * `Logger.getInstance()` in most contexts.
 *
 * Must be initialized once at startup via `logger.initialize()` before any log methods
 * will produce output. Log calls made before initialization are held in a bounded
 * buffer and replayed once the sinks exist.
 *
 * @example
 * ```ts
 * import { logger } from '@/utils/internal/logger.js';
 *
 * // At startup:
 * await logger.initialize('debug', 'http');
 *
 * // In application code:
 * logger.info('Request received', ctx);
 * logger.error('Upstream failure', err, ctx);
 * ```
 */
export const logger = Logger.getInstance();
