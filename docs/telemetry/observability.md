# Observability — OpenTelemetry

`@cyanheads/mcp-ts-core` ships full OpenTelemetry instrumentation out of the box. Tool, resource, prompt, storage, LLM, speech, and graph calls each get their own span; HTTP server requests pick up spans from `HttpInstrumentation` (or `@hono/otel` on the HTTP transport). Auth checks, session lifecycle, and task lifecycle are tracked as metrics only — auth decorates the active HTTP span with attributes, sessions and task transitions emit counters. Across all of it, `requestId`/`traceId`/`tenantId` correlate automatically, and logs emitted via the framework logger get `trace_id`/`span_id` injected so a single trace ID stitches traces, metrics, and logs together.

This doc is the catalog of what's emitted and how to listen to it. For the API surface (`createCounter`, `withSpan`, attribute constants), see `src/utils/telemetry/`. For an example Grafana dashboard and vendor-agnostic query recipes (Datadog, New Relic, Honeycomb), see [`dashboards.md`](./dashboards.md).

---

## Enabling export

OTel is **off by default**. Setting `OTEL_ENABLED=true` alone does nothing — you also need an OTLP endpoint. Without an endpoint, the SDK is configured but nothing leaves the process.

| Env var | Default | Purpose |
|:--------|:--------|:--------|
| `OTEL_ENABLED` | `false` | Master switch. Must be `true` to start the SDK. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — | OTLP/HTTP traces endpoint (e.g. `http://localhost:4318/v1/traces`). |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | — | OTLP/HTTP metrics endpoint (e.g. `http://localhost:4318/v1/metrics`). |
| `OTEL_SERVICE_NAME` | `createApp` `name` → `package.json` `name` | `service.name` resource attribute. Seeded from `createApp({ name })` when unset; an env value set before startup wins. |
| `OTEL_SERVICE_VERSION` | `package.json` `version` | `service.version` resource attribute. |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | Trace sampling ratio (0–1) for `TraceIdRatioBasedSampler`. |
| `OTEL_LOG_LEVEL` | `INFO` | OTel diagnostic logger level (`NONE`/`ERROR`/`WARN`/`INFO`/`DEBUG`/`VERBOSE`/`ALL`). |

Metrics are pushed via `PeriodicExportingMetricReader` every **15 seconds**. Traces use `BatchSpanProcessor`.

### Quick local stack

```bash
docker run --rm -p 4318:4318 -p 16686:16686 \
  -e COLLECTOR_OTLP_ENABLED=true \
  jaegertracing/all-in-one:latest

# .env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
```

Open Jaeger at `http://localhost:16686`, pick the service, see traces.

For a richer setup (Prometheus + Grafana for metrics, Jaeger or Tempo for traces), point both endpoints at an OTel Collector and fan out from there.

---

## Runtime caveats

| Runtime | Behavior |
|:--------|:---------|
| **Node.js / Bun** | Full `NodeSDK`. Auto-instrumentations: HTTP server (Node http hooks; skips `/healthz`), Pino logs (`trace_id`/`span_id` injection). On the HTTP transport, when OTel is enabled and `@hono/otel` is installed, `httpInstrumentationMiddleware` is also wired onto the MCP endpoint — this fills the gap on Bun, where the Node http auto-instrumentation silently no-ops. Manual spans, custom metrics, and OTLP export all work on Bun regardless. |
| **Cloudflare Workers / V8 isolates** | `NodeSDK` is unavailable. SDK init no-ops silently. Calls to `createCounter`/`createHistogram`/`withSpan` still work via the global OTel API but produce no output unless you wire a Worker-compatible exporter and `ctx.waitUntil()` for flush. |

Cloud platform detection auto-populates resource attributes:

| Detected | Attributes set |
|:---------|:--------------|
| Cloudflare Workers | `cloud.provider=cloudflare`, `cloud.platform=cloudflare_workers` |
| AWS Lambda | `cloud.provider=aws`, `cloud.platform=aws_lambda`, `cloud.region` from `AWS_REGION` |
| GCP Cloud Run / Functions | `cloud.provider=gcp`, `cloud.platform=gcp_cloud_run` (or `gcp_cloud_functions`), `cloud.region` from `GCP_REGION` |
| All | `deployment.environment.name` from `config.environment` |

---

## Spans

Every handler call gets a span. Nested operations (storage, graph, LLM) become child spans on the same trace.

| Span name | Source | Key attributes |
|:----------|:-------|:---------------|
| `tool_execution:<tool>` | every tool call | `mcp.tool.input_bytes`, `mcp.tool.output_bytes`, `mcp.tool.duration_ms`, `mcp.tool.success`, `mcp.tool.error_code`, `mcp.tool.partial_success`, `mcp.tool.batch.{succeeded,failed}_count` (tool name is in the span name + `code.function.name`) |
| `resource_read:<resource>` | every resource handler | `mcp.resource.uri`, `mcp.resource.mime_type`, `mcp.resource.size_bytes`, `mcp.resource.duration_ms`, `mcp.resource.success`, `mcp.resource.error_code` |
| `prompt_generation:<prompt>` | every prompt handler | `mcp.prompt.input_bytes`, `mcp.prompt.output_bytes`, `mcp.prompt.message_count`, `mcp.prompt.duration_ms`, `mcp.prompt.success`, `mcp.prompt.error_code` |
| `storage:<op>` | `StorageService` (every call) | `mcp.storage.operation`, `mcp.storage.duration_ms`, `mcp.storage.success`, `mcp.storage.key_count` (batch ops) |
| `graph:<op>` | `GraphService` (every call) | `mcp.graph.operation`, `mcp.graph.duration_ms`, `mcp.graph.success` |
| `gen_ai.chat_completion` | OpenRouter LLM provider | `gen_ai.system=openrouter`, `gen_ai.request.model`, `gen_ai.request.{max_tokens,temperature,top_p,streaming}`, `gen_ai.response.model`, `gen_ai.usage.{input,output,total}_tokens` |
| `speech:tts` | ElevenLabs provider | `mcp.speech.provider`, `mcp.speech.operation`, `mcp.speech.input_bytes`, `mcp.speech.output_bytes`, `mcp.speech.duration_ms`, `mcp.speech.success` |
| `speech:stt` | Whisper provider | same as `speech:tts` |

All spans also carry `code.function.name` and `code.namespace` for code-attribution. Errors are recorded via `span.recordException()` and `SpanStatusCode.ERROR`; `McpError` codes are surfaced as the `*.error_code` attribute.

Trace context propagates across boundaries via W3C `traceparent` headers. Helpers in `src/utils/telemetry/trace.ts`:

| Helper | Use |
|:-------|:----|
| `withSpan(name, fn, attrs?)` | Manual instrumentation. Auto-records exceptions, sets status. |
| `buildTraceparent(ctx?)` | Build a `traceparent` header from the active context. |
| `extractTraceparent(headers)` | Parse an incoming `traceparent`. |
| `createContextWithParentTrace(headers, op)` | Continue a distributed trace from incoming HTTP. |
| `injectCurrentContextInto(carrier)` | Inject context into outgoing headers (uses `propagation.inject`). |
| `runInContext(ctx, fn)` | Carry the active OTel context across async boundaries. |

---

## Metrics

All custom metrics are namespaced `mcp.*` (or `process.*`/`http.client.*` where standard semconv applies). Lazy-initialized on first emission, but the universal ones are eagerly created at startup so series exist from the first export cycle.

### Tools, resources, prompts

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.tool.calls` | counter | `{calls}` | `mcp.tool.name`, `mcp.tool.success` |
| `mcp.tool.duration` | histogram | `ms` | `mcp.tool.name`, `mcp.tool.success` |
| `mcp.tool.errors` | counter | `{errors}` | `mcp.tool.name`, `mcp.tool.error_category` (`upstream`/`server`/`client`) |
| `mcp.tool.input_bytes` | histogram | `bytes` | `mcp.tool.name` |
| `mcp.tool.output_bytes` | histogram | `bytes` | `mcp.tool.name` |
| `mcp.tool.param.usage` | counter | `{uses}` | `mcp.tool.name`, `mcp.tool.param` (top-level keys supplied by caller) |
| `mcp.resource.reads` | counter | `{reads}` | `mcp.resource.name`, `mcp.resource.success` |
| `mcp.resource.duration` | histogram | `ms` | `mcp.resource.name`, `mcp.resource.success` |
| `mcp.resource.errors` | counter | `{errors}` | `mcp.resource.name` |
| `mcp.resource.output_bytes` | histogram | `bytes` | `mcp.resource.name` |
| `mcp.prompt.generations` | counter | `{generations}` | `mcp.prompt.name`, `mcp.prompt.success` |
| `mcp.prompt.duration` | histogram | `ms` | `mcp.prompt.name`, `mcp.prompt.success` |
| `mcp.prompt.errors` | counter | `{errors}` | `mcp.prompt.name`, `mcp.prompt.error_category` |
| `mcp.prompt.input_bytes` | histogram | `bytes` | `mcp.prompt.name` |
| `mcp.prompt.output_bytes` | histogram | `bytes` | `mcp.prompt.name` |
| `mcp.prompt.message_count` | histogram | `{messages}` | `mcp.prompt.name` |
| `mcp.requests.active` | up/down counter | `{requests}` | — (in-flight handler executions, all three types) |

### Storage, LLM, speech, graph

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.storage.operations` | counter | `{ops}` | `mcp.storage.operation`, `mcp.storage.success` |
| `mcp.storage.duration` | histogram | `ms` | `mcp.storage.operation`, `mcp.storage.success` |
| `mcp.storage.errors` | counter | `{errors}` | `mcp.storage.operation` |
| `mcp.llm.requests` | counter | `{requests}` | `gen_ai.system`, `gen_ai.request.model` |
| `mcp.llm.duration` | histogram | `ms` | `gen_ai.system`, `gen_ai.request.model` |
| `mcp.llm.errors` | counter | `{errors}` | `gen_ai.system`, `gen_ai.request.model` |
| `mcp.llm.tokens` | counter | `{tokens}` | `gen_ai.request.model`, `gen_ai.token.type` (`input`/`output`) |
| `mcp.speech.operations` | counter | `{ops}` | `mcp.speech.operation` (`tts`/`stt`), `mcp.speech.provider`, `mcp.speech.success` |
| `mcp.speech.duration` | histogram | `ms` | `mcp.speech.operation`, `mcp.speech.provider` |
| `mcp.speech.errors` | counter | `{errors}` | `mcp.speech.operation`, `mcp.speech.provider` |
| `mcp.graph.operations` | counter | `{ops}` | `mcp.graph.operation`, `mcp.graph.success` |
| `mcp.graph.duration` | histogram | `ms` | `mcp.graph.operation`, `mcp.graph.success` |
| `mcp.graph.errors` | counter | `{errors}` | `mcp.graph.operation` |

### Transport, auth, sessions, tasks

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.auth.attempts` | counter | `{attempts}` | `mcp.auth.outcome` (`success`/`failure`/`missing`), `mcp.auth.failure_reason` |
| `mcp.auth.duration` | histogram | `ms` | `mcp.auth.outcome`, `mcp.auth.failure_reason` |
| `mcp.sessions.events` | counter | `{events}` | `mcp.session.event` (`created`/`terminated`/`rejected`/`stale_cleanup`) |
| `mcp.session.duration` | histogram | `s` | — |
| `mcp.sessions.active` | observable gauge | `{sessions}` | — |
| `mcp.heartbeat.failures` | counter | `{failures}` | `mcp.connection.transport` (`stdio`/`http`) |
| `mcp.http.close_failures` | counter | `{failures}` | `surface` (`transport`/`server`), `trigger` (`success`/`error`/`sse-abort`) — per-request close threw or timed out |
| `mcp.http.per_request.created` | counter | `{instances}` | `kind` (`server`/`transport`) — per-request `McpServer` and `McpSessionTransport` instances created |
| `mcp.http.per_request.finalized` | counter | `{instances}` | `kind` (`server`/`transport`) — per-request instances reclaimed by GC; persistent gap vs `created` indicates a leak |
| `mcp.tasks.created` | counter | `{tasks}` | `mcp.task.store_type` (`in-memory`/`storage`) |
| `mcp.tasks.status_changes` | counter | `{transitions}` | `mcp.task.status`, `mcp.task.store_type` |
| `mcp.tasks.active` | observable gauge | `{tasks}` | — (in-memory store only) |

### Errors, rate limits, HTTP client

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.errors.classified` | counter | `{errors}` | `mcp.error.classified_code` (JSON-RPC code), `operation` |
| `mcp.ratelimit.rejections` | counter | `{rejections}` | `mcp.rate_limit.key` |
| `http.client.request.duration` | histogram | `s` | `http.request.method`, `server.address`, `http.response.status_code` (when > 0; absent on network errors before a response is received) |

### Process

Auto-registered when `process.memoryUsage`/`process.uptime`/`perf_hooks` are available (Node/Bun, not Workers). The three memory gauges share a single `process.memoryUsage()` snapshot per collection cycle (refreshed at most every 100 ms).

| Metric | Type | Unit | Notes |
|:-------|:-----|:-----|:------|
| `process.memory.rss` | observable gauge | `bytes` | Resident set size |
| `process.memory.heap_used` | observable gauge | `bytes` | V8 heap used |
| `process.memory.heap_total` | observable gauge | `bytes` | V8 total heap |
| `process.uptime` | observable gauge | `s` | Process uptime |
| `process.event_loop.delay` | observable gauge | `ms` | p99 delay (`monitorEventLoopDelay` resolution=20) |
| `process.event_loop.utilization` | observable gauge | `1` | 0 = idle, 1 = saturated |

---

## Logs

Pino logs are auto-instrumented by `@opentelemetry/instrumentation-pino`. When a span is active, `trace_id` and `span_id` are injected into the record. Combined with the framework logger's automatic `requestId`/`tenantId` correlation, every log line is searchable by trace.

For domain logging inside handlers, use `ctx.log` (`debug`/`info`/`notice`/`warning`/`error`). It auto-includes `requestId`, `traceId`, `tenantId`, `spanId`. The completion log emitted at the end of every handler carries a `metrics` payload, with fields tuned to each surface:

| Handler | Log message | `metrics` fields |
|:--------|:------------|:-----------------|
| Tool | `Tool execution finished.` | `durationMs`, `isSuccess`, `errorCode`, `inputBytes`, `outputBytes`, plus `partialSuccess`/`batchSucceeded`/`batchFailed` when the result is a partial-success batch |
| Resource | `Resource read finished.` | `durationMs`, `isSuccess`, `errorCode`, `outputBytes`, `uri`, `mimeType` |
| Prompt | `Prompt generation finished.` (or `failed.`) | `durationMs`, `isSuccess`, `errorCode`, `inputBytes`, `outputBytes`, `messageCount` |

---

## Custom instrumentation

Need a span or metric for your own service? Use the helpers in `@cyanheads/mcp-ts-core/utils`:

```ts
import { withSpan, createCounter, createHistogram } from '@cyanheads/mcp-ts-core/utils';

const myOps = createCounter('myservice.operations', 'My service ops', '{ops}');
const myDuration = createHistogram('myservice.duration', 'My service duration', 'ms');

export async function doWork() {
  return withSpan('myservice.do_work', async (span) => {
    const t0 = performance.now();
    try {
      const result = await reallyDoWork();
      span.setAttribute('myservice.items', result.length);
      return result;
    } finally {
      const ms = performance.now() - t0;
      myDuration.record(ms);
      myOps.add(1);
    }
  }, { 'myservice.region': 'us-west' });
}
```

Span context propagates automatically — `withSpan` calls inside a `tool_execution:*` span will appear as children.

---

## Cardinality discipline

Cardinality discipline matters — these series are cheap to emit but expensive to store and query. The framework deliberately keeps high-cardinality identifiers off metric attributes and on spans only:

- ✅ `mcp.resource.name` (URI template) on metrics
- ❌ `mcp.resource.uri` (full URI with IDs) only on spans
- ✅ `gen_ai.request.model` on metrics
- ❌ `mcp.tenant.id`, `mcp.client.id`, `mcp.auth.subject` only on spans/logs

When adding your own metric attributes, follow the same rule: bounded enums and template names go on metrics; per-request unique IDs stay on spans.
