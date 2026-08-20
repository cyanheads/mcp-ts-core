# Dashboards

`mcp-ts-core-dashboard.json` (this directory) is an example Grafana dashboard for the framework's OTel metrics. It targets a Prometheus-compatible backend and uses labels the framework emits.

For the underlying metric catalog, span list, and env config, see [`observability.md`](./observability.md).

---

## Import quickstart (Grafana)

1. Wire OTel export to a Prometheus-compatible store (Prometheus, VictoriaMetrics, Mimir, Thanos, Cortex, …). On the MCP server, set `OTEL_ENABLED=true` and the OTLP endpoints — see [`observability.md`](./observability.md) for the env vars.
2. In Grafana → **Dashboards** → **New** → **Import** → paste the JSON or upload the file.
3. Pick the Prometheus data source on import. Save.
4. Open the dashboard. Adjust the `Service` template variable (default `.+`) if you want to scope to one server. The regex automatically tolerates an `@scope/` prefix — entering `mcp-ts-core` matches both `mcp-ts-core` and `@cyanheads/mcp-ts-core`.

Panels populate within ~30s of metrics flowing (the framework pushes via `PeriodicExportingMetricReader` every 15s).

---

## Naming convention assumed

The dashboard targets the **OTel Collector → Prometheus exporter** translation rules with `add_metric_suffixes: true` (default).

| OTel metric | Prometheus name |
|:------------|:----------------|
| Counter `mcp.tool.calls` | `mcp_tool_calls_total` |
| Histogram `mcp.tool.duration` (`ms`) | `mcp_tool_duration_milliseconds_{bucket,sum,count}` |
| Histogram `mcp.session.duration` (`s`) | `mcp_session_duration_seconds_{bucket,sum,count}` |
| Histogram `mcp.tool.input_bytes` | `mcp_tool_input_bytes_{bucket,sum,count}` |
| UpDownCounter `mcp.requests.active` | `mcp_requests_active` |
| Observable gauge `mcp.sessions.active` | `mcp_sessions_active` |
| Observable gauge `process.event_loop.utilization` (unit `1`) | `process_event_loop_utilization_ratio` |
| Resource attribute `service.name` | label `service_name` |
| Attribute key `mcp.tool.name` | label `mcp_tool_name` |

Dots become underscores everywhere. Counters get `_total`. Histograms with physical units (`s`, `ms`, `bytes`) get the unit appended; non-physical units (`{calls}`, `{requests}`) get nothing. Dimensionless ratio (unit `1`) becomes `_ratio`.

---

## Row guide

| Row | What it tells you |
|:----|:------------------|
| **Live activity** | At-a-glance health: tool calls/min, in-flight requests, active sessions, tool error %. Plus tool call rate and tool errors-by-category over time. The error % stat is thresholded green/yellow/red at 0/1/5 %. |
| **Tools** | Per-tool call rate, p95 duration, and p95 input/output payload size. Spot the tools that dominate traffic, the slow ones, and the chatty ones. |
| **Resources** | Per-resource read rate, p95 duration, error rate, and p95 output bytes. Same shape as Tools but keyed on `mcp_resource_name`. |
| **Prompts** | Generation rate, p95 duration, error rate by category, and p95 message count. Useful for prompts that fan out — high message count is often the explanation for slow responses. |
| **Storage / LLM / Speech / Graph** | Op rate and p95 latency for each service. LLM also shows tokens/sec by type (`input`/`output`) — multiply by your provider's $/Mtoken to see live cost. |
| **HTTP server & client** | Server: req rate by method, p50/p95/p99 latency, status code distribution. Client: p95 duration by upstream `server_address`. |
| **Sessions / Auth** | Session events (`created`/`terminated`/`rejected`/`stale_cleanup`), heartbeat failures by transport, auth attempts and p95 by outcome (`success`/`failure`/`missing`). |
| **Errors & rate limits** | Classified errors keyed on JSON-RPC code (`-32603`, `-32001`, …), and rate-limit rejections by key. |
| **Process health** | RSS / heap used / heap total, event loop p99 delay (thresholded 50/200 ms), event loop utilization (thresholded 0.7/0.9), and process uptime. |

---

## Vendor-agnostic query recipes

The dashboard is Prometheus-flavored, but the underlying OTel metrics work in any backend. The translation pattern is the same: pick the equivalent rate/histogram primitive, use the same attribute keys (with each vendor's quirks for label naming).

### Datadog

Datadog ingests OTel metrics natively or via the OTel Collector's `datadog` exporter. Attribute keys land as Datadog tags.

| Prometheus query | Datadog equivalent |
|:-----------------|:-------------------|
| `sum by (mcp_tool_name) (rate(mcp_tool_calls_total[5m]))` | `sum:mcp.tool.calls{*} by {mcp_tool_name}.as_rate()` |
| `histogram_quantile(0.95, sum by (mcp_tool_name, le) (rate(mcp_tool_duration_milliseconds_bucket[5m])))` | `p95:mcp.tool.duration{*} by {mcp_tool_name}` (Datadog auto-aggregates histograms when ingested as distribution metrics) |
| `sum(mcp_requests_active)` | `sum:mcp.requests.active{*}` |
| `sum(rate(mcp_tool_errors_total[5m])) / sum(rate(mcp_tool_calls_total[5m]))` | `sum:mcp.tool.errors{*}.as_rate() / sum:mcp.tool.calls{*}.as_rate()` |

Service filter: `service:mcp-ts-core` (Datadog populates `service` from `service.name`).

### New Relic (NRQL)

OTel metrics flow through New Relic's OTLP endpoint. They land in the `Metric` event with original names preserved (no Prometheus suffixing).

| Prometheus query | NRQL equivalent |
|:-----------------|:----------------|
| `sum by (mcp_tool_name) (rate(mcp_tool_calls_total[5m]))` | `SELECT rate(sum(mcp.tool.calls), 1 second) FROM Metric FACET mcp.tool.name SINCE 1 hour ago TIMESERIES` |
| `histogram_quantile(0.95, sum by (le) (rate(mcp_tool_duration_milliseconds_bucket[5m])))` | `SELECT percentile(mcp.tool.duration, 95) FROM Metric FACET mcp.tool.name SINCE 1 hour ago TIMESERIES` |
| `sum(mcp_requests_active)` | `SELECT latest(mcp.requests.active) FROM Metric SINCE 5 minutes ago` |

Service filter: `WHERE service.name = 'mcp-ts-core'`.

### Honeycomb

Honeycomb is span-first. Metric values land as fields on the synthetic span produced by the OTel Collector's `honeycomb` exporter — but the more productive path is to query the **trace data** directly, since the framework already emits per-call spans.

| Goal | Honeycomb query |
|:-----|:----------------|
| Tool call rate by name | `VISUALIZE: COUNT, GROUP BY: name, FILTER: name starts-with "tool_execution:"` |
| Tool p95 duration by name | `VISUALIZE: P95(duration_ms), GROUP BY: name, FILTER: name starts-with "tool_execution:"` |
| Tool error rate | `VISUALIZE: COUNT, GROUP BY: mcp.tool.error_code, FILTER: name starts-with "tool_execution:" AND mcp.tool.success = false` |
| Resource throughput | `VISUALIZE: COUNT, GROUP BY: mcp.resource.name, FILTER: name starts-with "resource_read:"` |
| LLM token cost | `VISUALIZE: SUM(gen_ai.usage.total_tokens), GROUP BY: gen_ai.request.model, FILTER: name = "gen_ai.chat_completion"` |

Service filter: `FILTER: service.name = "mcp-ts-core"`. Honeycomb's `bubbleup` feature makes outlier triage on these spans particularly effective — point it at the slowest 1 % of tool calls and let it surface the differentiating attributes.

---

## Adapting

| Symptom | Fix |
|:--------|:----|
| HTTP server panels empty | Older `@opentelemetry/instrumentation-http` emits `http.server.duration` (ms) instead of `http.server.request.duration` (s). Replace `http_server_request_duration_seconds` with `http_server_duration_milliseconds` in the JSON. |
| Dashboard empty on Cloudflare Workers | `NodeSDK` doesn't run in V8 isolates and the framework no-ops metric emission unless a Worker-compatible exporter is wired. See [`observability.md`](./observability.md) for runtime caveats. |

For other mismatches (different service label, `add_metric_suffixes: false`, custom attribute filters), inspect one query against your actual metric names and find/replace from there.
