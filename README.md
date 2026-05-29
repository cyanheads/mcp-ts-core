<div align="center">
  <h1>@cyanheads/mcp-ts-core</h1>
  <p><b>Agent-native TypeScript framework for building MCP servers. Build tools, not infrastructure. Declarative definitions with auth, multi-backend storage, OpenTelemetry, and first-class support for Bun/Node/Cloudflare Workers.</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.12-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2025--11--25-8A2BE2.svg?style=flat-square)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/changelog.mdx)

[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## What is this?

`@cyanheads/mcp-ts-core` is the infrastructure layer for TypeScript MCP servers. Install it as a dependency — don't fork it. Your agent collaborates with you to design and build the tools, resources, and prompts for your server.

The framework handles the plumbing: transports, auth, config, logging, telemetry, & more. Define your domain logic with the builders and let the framework take care of the rest.

```ts
import { createApp, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

const greet = tool('greet', {
  description: 'Greet someone by name and return a personalized message.',
  annotations: { readOnlyHint: true },
  input: z.object({
    name: z.string().describe('Name of the person to greet'),
  }),
  output: z.object({
    message: z.string().describe('The greeting message'),
  }),
  errors: [
    {
      reason: 'name_blocked',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The provided name is on the configured block list.',
      recovery: 'Use a different name that is not on the block list.',
    },
  ],
  handler: async (input, ctx) => {
    if (isBlocked(input.name)) throw ctx.fail('name_blocked', `"${input.name}" is blocked`);
    return { message: `Hello, ${input.name}!` };
  },
});

await createApp({ tools: [greet] });
```

That's a complete MCP server. Every tool call is automatically logged with duration, payload sizes, and request correlation — no instrumentation code needed. `createApp()` handles config parsing, logger init, transport startup, signal handlers, and graceful shutdown.

## Quick start

```bash
bunx @cyanheads/mcp-ts-core init my-mcp-server
cd my-mcp-server
bun install
```

You get a scaffolded project with `CLAUDE.md`, Agent Skills, plugin metadata (Codex + Claude Code), and a `src/` tree ready for your tools. Infrastructure — transports, auth, storage, telemetry, lifecycle, linting — lives in `node_modules`. What's left is domain: which APIs to wrap, which workflows to expose.

Start your coding agent (i.e. Claude Code, Codex) and describe what you want. The agent knows what to do from there. The included Agent Skills cover the full cycle: `setup`, `design-mcp-server`, scaffolding, testing, `security-pass`, `release-and-publish`, `maintenance`, & more.

### What you get

Here's what tool definitions look like. Add `format()` to render structured output as markdown — different MCP clients read different surfaces (`structuredContent` vs `content[]`), and `format()` ensures both carry the same data:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

export const search = tool('search', {
  description: 'Search for items by query.',
  input: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().default(10).describe('Max results'),
  }),
  output: z.object({
    items: z.array(z.string()).describe('Search results'),
  }),
  async handler(input) {
    const results = await doSearch(input.query, input.limit);
    return { items: results };
  },
});
```

And resources:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';

export const itemData = resource('items://{itemId}', {
  description: 'Retrieve item data by ID.',
  params: z.object({
    itemId: z.string().describe('Item ID'),
  }),
  async handler(params, ctx) {
    return await getItem(params.itemId);
  },
});
```

And contracts for failure modes — typed at compile time, surfaced to clients with recovery hints the model can act on:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export const search = tool('search', {
  // ...input, output as above
  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'The query returned zero items from the upstream index.',
      recovery: 'Broaden the query — close matches by edit distance are in `data.suggestions`.',
    },
  ],
  async handler(input, ctx) {
    const { items, suggestions } = await doSearch(input.query, input.limit);
    if (items.length === 0) throw ctx.fail('no_match', `No matches for "${input.query}"`, { suggestions });
    return { items };
  },
});
```

The linter cross-checks `errors[]` against the handler body, contracts publish in `tools/list` so clients can preview failure modes, and `data.recovery.hint` mirrors into the markdown `content[]` so tool-only clients see it too.

Everything registers through `createApp()` in your entry point:

```ts
await createApp({
  name: 'my-mcp-server',
  version: '0.1.0',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: 'Brief composition hints for the model.', // optional, sent on every `initialize`
});
```

It also works on Cloudflare Workers with `createWorkerHandler()` — same definitions, different entry point.

## Features

- **Declarative definitions** — `tool()`, `resource()`, `prompt()` builders with Zod schemas; `appTool()`/`appResource()` add interactive HTML UIs.
- **Server-level orientation** — `instructions` on `createApp`/`createWorkerHandler` rides every `initialize` for the model. Cross-tool composition hints, regional notes, scope guidance — without leaking text into every tool description.
- **Unified Context** — one `ctx` for logging, tenant-scoped storage, elicitation, sampling, cancellation, and task progress.
- **Auth** — `auth: ['scope']` on definitions, checked before dispatch (no wrapper code). Modes: `none`, `jwt`, or `oauth` (local secret or JWKS).
- **Task tools** — `task: true` for long-running ops; framework manages create/poll/progress/complete/cancel.
- **Definition linter** — validates names, schemas, auth scopes, annotations, format-parity, and cross-vendor JSON Schema portability at build time. Run via `lint:mcp` or `devcheck` — not invoked at server startup.
- **Typed error contracts** — declare `errors: [{ reason, code, when, recovery, retryable? }]` and handlers get a typed `ctx.fail(reason, …)`. Contracts publish in `tools/list` so clients preview failure modes; the linter cross-checks the handler. Factories (`notFound()`, `httpErrorFromResponse()`, …) cover ad-hoc throws; plain `Error` auto-classifies.
- **Multi-backend storage** — `in-memory`, filesystem, Supabase, Cloudflare D1/KV/R2. Swap via env var; handlers don't change.
- **DataCanvas (optional)** — Tier 3 SQL/analytical workspace backed by DuckDB. Register tabular data from upstream APIs, run SQL across registered tables, export CSV/Parquet/JSON. Token-sharing model (opaque `canvas_id`) for multi-agent collaboration; sliding TTL + per-tenant scoping. Opt-in via `CANVAS_PROVIDER_TYPE=duckdb`; fails closed on Workers.
- **Observability** — Pino logging + optional OpenTelemetry traces/metrics. Request correlation and tool metrics automatic.
- **Tiered dependencies** — parsers, OTEL SDK, Supabase, OpenAI as optional peers. Install what you use.
- **Agent-first DX** — ships `CLAUDE.md` / `AGENTS.md` and Agent Skills that give your coding agent full framework knowledge — it can scaffold tools, write tests, run security audits, and ship releases without you writing the boilerplate.

## Server structure

```text
my-mcp-server/
  src/
    index.ts                              # createApp() entry point
    worker.ts                             # createWorkerHandler() (optional)
    config/
      server-config.ts                    # Server-specific env vars
    services/
      [domain]/                           # Domain services (init/accessor pattern)
    mcp-server/
      tools/definitions/                  # Tool definitions (.tool.ts)
      resources/definitions/              # Resource definitions (.resource.ts)
      prompts/definitions/                # Prompt definitions (.prompt.ts)
  package.json
  tsconfig.json                           # extends @cyanheads/mcp-ts-core/tsconfig.base.json
  CLAUDE.md                               # Points to core's CLAUDE.md for framework docs
```

No `src/utils/`, no `src/storage/`, no `src/types-global/`, no `src/mcp-server/transports/` — infrastructure lives in `node_modules`.

## Configuration

All core config is Zod-validated from environment variables. Server-specific config uses a separate Zod schema with lazy parsing.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server hostname | `127.0.0.1` |
| `MCP_AUTH_MODE` | `none`, `jwt`, or `oauth` | `none` |
| `MCP_AUTH_SECRET_KEY` | JWT signing secret (required for `jwt` mode) | — |
| `STORAGE_PROVIDER_TYPE` | `in-memory`, `filesystem`, `supabase`, `cloudflare-d1`/`kv`/`r2` | `in-memory` |
| `CANVAS_PROVIDER_TYPE` | `none` or `duckdb` (Tier 3, optional peer dep `@duckdb/node-api`) | `none` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |
| `OPENROUTER_API_KEY` | OpenRouter LLM API key | — |

See [CLAUDE.md](CLAUDE.md) for the full configuration reference.

## API overview

### Entry points

| Function | Purpose |
|:---------|:--------|
| `createApp(options)` | Node.js server — handles full lifecycle |
| `createWorkerHandler(options)` | Cloudflare Workers — returns an `ExportedHandler` |

### Builders

| Builder | Usage |
|:--------|:------|
| `tool(name, options)` | Define a tool with `handler(input, ctx)` |
| `resource(uriTemplate, options)` | Define a resource with `handler(params, ctx)` |
| `prompt(name, options)` | Define a prompt with `generate(args)` |
| `appTool(name, options)` | Define an MCP Apps tool with auto-populated `_meta.ui` |
| `appResource(uriTemplate, options)` | Define an MCP Apps HTML resource with the correct MIME type and `_meta.ui` mirroring for read content |

### Context

Handlers receive a unified `Context` object:

| Property | Type | Description |
|:---------|:-----|:------------|
| `ctx.log` | `ContextLogger` | Request-scoped logger (auto-correlates requestId, traceId, tenantId) |
| `ctx.state` | `ContextState` | Tenant-scoped key-value storage |
| `ctx.elicit` | `Function?` | Ask the user for input (when client supports it) |
| `ctx.sample` | `Function?` | Request LLM completion from the client |
| `ctx.fail` | `(reason, msg?, data?) => McpError` | Typed error throw — reason checked against `errors[]` contract at compile time |
| `ctx.signal` | `AbortSignal` | Cancellation signal |
| `ctx.notifyResourceUpdated` | `Function?` | Notify subscribed clients a resource changed |
| `ctx.notifyResourceListChanged` | `Function?` | Notify clients the resource list changed |
| `ctx.notifyPromptListChanged` | `Function?` | Notify clients the prompt list changed |
| `ctx.notifyToolListChanged` | `Function?` | Notify clients the tool list changed |
| `ctx.progress` | `ContextProgress?` | Task progress reporting (when `task: true`) |
| `ctx.requestId` | `string` | Unique request ID |
| `ctx.tenantId` | `string?` | Tenant ID (JWT `tid` claim, or `'default'` for stdio and HTTP+`MCP_AUTH_MODE=none`) |

### Subpath exports

```ts
import { createApp, tool, resource, prompt } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { McpError, JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { checkScopes } from '@cyanheads/mcp-ts-core/auth';
import { markdown, fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { OpenRouterProvider, GraphService } from '@cyanheads/mcp-ts-core/services';
import type { DataCanvas, CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fuzzTool, fuzzResource, fuzzPrompt } from '@cyanheads/mcp-ts-core/testing/fuzz';
```

See [CLAUDE.md/AGENTS.md](CLAUDE.md) for the complete exports reference.

## Examples

The `examples/` directory contains a reference server consuming core through public exports, demonstrating all patterns:

| Tool | Pattern |
|:-----|:--------|
| `template_echo_message` | Basic tool with `format`, `auth` |
| `template_cat_fact` | External API call, error factories |
| `template_madlibs_elicitation` | `ctx.elicit` for interactive input |
| `template_code_review_sampling` | `ctx.sample` for LLM completion |
| `template_image_test` | Image content blocks |
| `template_async_countdown` | `task: true` with `ctx.progress` |
| `template_data_explorer` | MCP Apps with linked UI resource via `appTool()`/`appResource()` builders |

## Testing

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { myTool } from '@/mcp-server/tools/definitions/my-tool.tool.js';

const ctx = createMockContext({ tenantId: 'test-tenant' });
const input = myTool.input.parse({ query: 'test' });
const result = await myTool.handler(input, ctx);
```

`createMockContext()` provides stubbed `log`, `state`, and `signal`. Pass `{ tenantId }` for state operations, `{ sample }` for LLM mocking, `{ elicit }` for elicitation mocking, `{ progress: true }` for task tools.

### Fuzz testing

Schema-aware fuzz testing via `fast-check`. Generates valid inputs from Zod schemas and adversarial payloads (prototype pollution, injection strings, type confusion) to verify handler invariants.

```ts
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';

const report = await fuzzTool(myTool, { numRuns: 100 });
expect(report.crashes).toHaveLength(0);
expect(report.leaks).toHaveLength(0);
expect(report.prototypePollution).toBe(false);
```

Also exports `fuzzResource`, `fuzzPrompt`, `zodToArbitrary`, and `ADVERSARIAL_STRINGS` for custom property-based tests.

## Documentation

- **[CLAUDE.md/AGENTS.md](CLAUDE.md)** — Framework reference: exports catalog, patterns, Context interface, error codes, auth, config, testing. Ships in the npm package and is auto-accessible in your project after `init`.
- **[docs/telemetry/](docs/telemetry/)** — OpenTelemetry: full catalog of spans, metrics, and attributes the framework emits ([observability.md](docs/telemetry/observability.md)), plus an example Grafana dashboard and vendor-agnostic query recipes for Datadog, New Relic, Honeycomb ([dashboards.md](docs/telemetry/dashboards.md)).
- **[CHANGELOG.md](CHANGELOG.md)** — Version history. Each entry includes a summary, migration notes, and links to commits/issues.

## Development

```bash
bun run rebuild        # clean + build (scripts/clean.ts + scripts/build.ts)
bun run devcheck       # full gate: lint/format, typecheck, MCP defs, framework antipatterns, docs/skills/changelog sync, tests, audit, outdated, secrets/TODO scan
bun run lint:mcp       # validate MCP definitions against spec
bun run test:all       # vitest: unit + Workers pool + integration
```

## Contributing

Issues and pull requests welcome. Run checks before submitting:

```bash
bun run devcheck
bun run test:all
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).

---

<div align="center">
  <p>
    <a href="https://github.com/sponsors/cyanheads">Sponsor this project</a> •
    <a href="https://www.buymeacoffee.com/cyanheads">Buy me a coffee</a>
  </p>
</div>
