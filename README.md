<div align="center">
  <h1>@cyanheads/mcp-ts-core</h1>
  <p><b>Agent-native TypeScript framework for building MCP servers.</b></p>
  <p>Runtime infrastructure for your server, and the agent skills to build, test, and ship it.</p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.13.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2026--07--28-8A2BE2.svg?style=flat-square)](https://modelcontextprotocol.io/specification/2026-07-28)

[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

[Quick start](#quick-start) · [Capabilities](#what-comes-with-it) · [API reference](#api-overview) · [Examples](#examples)

</div>

---

## Build AI tools for anything you can describe

Connect an API, a dataset, or a workflow to an AI agent through the Model Context Protocol (MCP). Your project holds the domain code; `@cyanheads/mcp-ts-core` handles the auth, storage, logging, and transports underneath it.

**Agent-native.** Every scaffold ships the framework reference and a set of Agent Skills: workflows for designing tools, writing tests, reviewing security, and cutting releases. You decide what the server does; your agent follows the skills to build it.

**The framework stays a dependency.** Infrastructure fixes arrive as package upgrades. Run the `maintenance` skill and your agent bumps core, syncs the latest skills, and adopts what changed.

## Quick start

Servers run on Bun, Node.js 24+, or Cloudflare Workers.

```bash
bunx @cyanheads/mcp-ts-core init my-mcp-server
cd my-mcp-server
bun install
```

The scaffold includes a source tree, build and test configuration, `CLAUDE.md`/`AGENTS.md`, Agent Skills, and plugin metadata for Claude Code and Codex. Open it in Claude Code, Codex, or another agent and describe what you want:

> Build an MCP server for my team's inventory API. We need to find products, check stock across warehouses, investigate stock movements, and record adjustments and transfers. Let's get started.

Already have a TypeScript project? Run `bun add @cyanheads/mcp-ts-core` and register your definitions with `createApp()`.

## A tool is a schema and a function

This is a complete server that searches a three-item catalog. To try it, replace the scaffold's `src/index.ts` with it:

```ts
import { createApp, tool, z } from '@cyanheads/mcp-ts-core';

const catalog = ['Notebook', 'Mechanical pencil', 'Desk lamp'];

const search = tool('catalog_search', {
  description: 'Search catalog item names. An empty query lists all items.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.string().describe('Text to find in an item name'),
  }),
  output: z.object({
    items: z.array(z.string()).describe('Matching item names'),
  }),
  async handler({ query }) {
    return {
      items: catalog.filter((name) =>
        name.toLowerCase().includes(query.toLowerCase()),
      ),
    };
  },
});

await createApp({ name: 'catalog-mcp-server', title: 'catalog-mcp-server', tools: [search] });
```

Build and run it over HTTP:

```bash
bun run rebuild
bun run start:http
```

Point your MCP client at `http://127.0.0.1:3010/mcp` (Streamable HTTP), or have the client launch it over stdio with `bun /absolute/path/to/dist/index.js`.

## What comes with it

| You need to… | The framework provides |
|:------------|:-----------------------|
| Give an assistant useful capabilities | Typed builders for tools, resources, prompts, and interactive MCP Apps |
| Help an agent use those capabilities correctly | Server instructions, result enrichment, and declared errors with recovery guidance |
| Control access and keep state | JWT/OAuth, per-definition scopes, and tenant-scoped storage with swappable backends |
| Run locally or host a service | stdio and HTTP on Bun/Node.js; a separate entry point for Cloudflare Workers |
| Understand failures and catch mistakes | Structured logs, optional OpenTelemetry, definition linting, contract tests, and fuzz testing |

Optional integrations (DuckDB, Supabase, the OpenTelemetry SDK) are peer dependencies; install them when you need them.

## Give agents useful results

Two declared contracts shape what an agent gets back. `enrichment` carries success-path context (totals, the parsed query, empty-result notices), populated with `ctx.enrich()`. `errors` lists each expected failure with its recovery guidance, and the handler throws one with the typed `ctx.fail()`.

`runSearch(query, limit)` stands in for your search backend. It returns `{ items, total, parsed }`, or `null` when the index is down:

```ts
import { createApp, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

const search = tool('search', {
  description: 'Search the catalog and return ranked matches.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.string().describe('Search terms'),
    limit: z.number().int().min(1).default(10).describe('Max results'),
  }),
  output: z.object({
    items: z.array(z.string()).describe('Matching item names, best first'),
  }),
  enrichment: {
    effectiveQuery: z.string().describe('Query as the server parsed it'),
    totalCount: z.number().describe('Total matches before the limit'),
    notice: z.string().optional().describe('Guidance when nothing matched'),
  },
  errors: [
    {
      reason: 'index_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The upstream search index is unreachable.',
      retryable: true,
      recovery: 'Retry in a few seconds — the index may be briefly unavailable.',
    },
  ],
  handler: async (input, ctx) => {
    const res = await runSearch(input.query, input.limit);
    if (!res) {
      throw ctx.fail('index_unavailable', undefined, ctx.recoveryFor('index_unavailable'));
    }
    ctx.enrich({ effectiveQuery: res.parsed, totalCount: res.total });
    if (res.items.length === 0) {
      ctx.enrich({ notice: `No matches for "${input.query}". Try broader terms.` });
    }
    return { items: res.items }; // enrichment never rides in the domain return
  },
});

await createApp({ tools: [search] });
```

Both contracts are advertised in `tools/list`, so clients see them before calling, and the definition linter checks the handler against them. `ctx.recoveryFor()` adds the declared recovery hint to the error response.

### Same data across client surfaces

MCP hosts differ in which part of a tool result they hand the agent: `structuredContent` (JSON), `content[]` (text), or both. The framework fills both with the same data, so the agent sees the same result on any host.

`format()` renders the text side; without one, `content[]` gets JSON. The format-parity lint rule fails `lint:mcp` if any output field is missing from the rendered text. Enrichment needs no `format()` entry, because the framework adds it to both surfaces. This formatter renders the items as a markdown list:

```ts
format: (result) => [{
  type: 'text',
  text: result.items.length > 0
    ? result.items.map((name) => `- ${name}`).join('\n')
    : 'No matching items.',
}],
```

### Resources

Resources expose data at a URI. This one reads from your own `getItem()` service:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';

export const itemData = resource('items://{itemId}', {
  description: 'Retrieve item data by ID.',
  params: z.object({
    itemId: z.string().describe('Item ID'),
  }),
  async handler(params) {
    return await getItem(params.itemId);
  },
});
```

Everything registers through `createApp()` in your entry point:

```ts
await createApp({
  name: 'my-mcp-server',
  title: 'my-mcp-server', // display name in client UIs
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: 'Brief composition hints for the model.', // optional, sent on every `initialize`
});
```

On Cloudflare Workers, `createWorkerHandler()` takes the same definitions from a separate entry point.

## Runtime and integration details

- **Auth and storage:** Declare `auth: ['scope']` on a definition and the scope is checked, under JWT or OAuth, before the handler runs. `ctx.state` is tenant-scoped storage over in-memory, filesystem, Supabase, or Cloudflare D1/KV/R2, chosen by config.
- **Client interaction:** Return `ctx.requestInput(...)` to ask the user for input, the client's model for a sample, or the client for its roots. The handler runs again with the answers on `ctx.inputs`.
- **Protocol compatibility:** HTTP serves 2026-07-28 clients (per-request `_meta` envelope) and session-based 2025-era clients. The SDK's compatibility layer handles input requests for the older ones.
- **Server presentation:** `instructions` gives the model server-wide guidance once, at `initialize`, instead of in every tool description. Identity fields (`title`, `websiteUrl`, `description`, `icons`) populate the client's server info, the `/.well-known/mcp.json` server card, and the HTTP landing page.
- **Definition checks:** `lint:mcp` checks names, schemas, scopes, annotations, format parity, and JSON Schema portability. It runs at build time, never at startup, so a new rule can't break a deployed server.
- **DataCanvas:** An optional DuckDB workspace where agents run SQL across staged API results and export CSV, Parquet, or JSON. Agents share a workspace by passing its canvas token. Enable it with `CANVAS_PROVIDER_TYPE=duckdb` and `@duckdb/node-api` (Bun or Node.js only). [brapi-mcp-server](https://github.com/cyanheads/brapi-mcp-server#working-with-dataframes) walks through loading API results into a dataframe and querying it.
- **Mirror:** The `/mirror` module keeps a persistent local copy of a bulk upstream dataset in embedded SQLite with an optional FTS5 index, so tools query it locally instead of paging the live API on every call. You write the `sync` ingester and the schema; the framework handles storage, resumable initial loads, and incremental refreshes. Bun or Node.js only (`better-sqlite3` is an optional peer on Node). [faa-aircraft-registry-mcp-server](https://github.com/cyanheads/faa-aircraft-registry-mcp-server) serves the full FAA registry this way.

See the [framework reference](CLAUDE.md) for configuration and handler patterns, and the [observability guide](docs/telemetry/observability.md) for Pino logging and OpenTelemetry traces and metrics.

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
  CLAUDE.md / AGENTS.md                   # Server conventions; points to core's framework reference
```

Framework infrastructure lives in `node_modules`; your source tree holds the server's definitions, configuration, and domain services.

## Configuration

Core config comes from environment variables, validated with Zod. Server-specific variables get their own schema, parsed lazily so Workers can inject env at request time.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server hostname | `127.0.0.1` |
| `MCP_AUTH_MODE` | `none`, `jwt`, or `oauth` | `none` |
| `MCP_AUTH_SECRET_KEY` | JWT signing secret (required for `jwt` mode) | — |
| `STORAGE_PROVIDER_TYPE` | `in-memory`, `filesystem`, `supabase`, `cloudflare-d1`/`kv`/`r2` | `in-memory` |
| `CANVAS_PROVIDER_TYPE` | `none` or `duckdb` (optional peer dependency `@duckdb/node-api`) | `none` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |
| `OPENROUTER_API_KEY` | API key for the optional OpenRouter LLM provider (`/services`) | — |

See [CLAUDE.md/AGENTS.md](CLAUDE.md) for the full configuration reference.

## API overview

### Entry points

| Function | Purpose |
|:---------|:--------|
| `createApp(options)` | Bun or Node.js server; manages startup and shutdown |
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

Tool and resource handlers receive a `Context`. `ctx.enrich` and `ctx.fail` are typed against the definition's declared contracts:

| Property | Type | Description |
|:---------|:-----|:------------|
| `ctx.log` | `ContextLogger` | Request-scoped logger (auto-correlates requestId, traceId, tenantId); also mirrored to the client as `notifications/message` |
| `ctx.state` | `ContextState` | Tenant-scoped key-value storage |
| `ctx.requestInput` | `(spec) => never` | Suspend and ask the caller for more input; the handler is re-entered with the answers |
| `ctx.inputs` | `ContextInputs` | Reader over a retried request's responses — `.accepted()`, `.view()`, `.state()`, `.dropped` |
| `ctx.enrich` | `Enrich` / `TypedEnrich<E>` | Add declared result context to structured output and text content |
| `ctx.content` | `ContentCollect` | Attach image/audio blocks to `content[]` — `content.image(data, mimeType)`, `content.audio(...)`, or a raw block |
| `ctx.fail` | `(reason, msg?, data?) => McpError` | Creates an error for `throw ctx.fail(...)`; available with a declared `errors` contract |
| `ctx.recoveryFor` | `(reason) => object` | Resolves a declared recovery hint to `{ recovery: { hint } }`, for `ctx.fail`'s data argument |
| `ctx.signal` | `AbortSignal` | Cancellation signal |
| `ctx.notifyResourceUpdated` | `Function?` | Notify subscribed clients a resource changed |
| `ctx.notifyResourceListChanged` | `Function?` | Notify clients the resource list changed |
| `ctx.notifyPromptListChanged` | `Function?` | Notify clients the prompt list changed |
| `ctx.notifyToolListChanged` | `Function?` | Notify clients the tool list changed |
| `ctx.requestId` | `string` | Unique request ID |
| `ctx.tenantId` | `string?` | Tenant ID (JWT `tid` claim, or `'default'` for stdio and HTTP+`MCP_AUTH_MODE=none`) |
| `ctx.auth` | `AuthContext?` | Token claims and scopes when the request is authenticated |
| `ctx.sessionId` | `string?` | HTTP session ID in stateful/`auto` session mode — a scoping key, not an authorization principal |
| `ctx.uri` | `URL?` | The parsed resource URI; set in resource handlers only |

### Subpath exports

```ts
import { createApp, tool, resource, prompt } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { McpError, JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { checkScopes } from '@cyanheads/mcp-ts-core/auth';
import { markdown, fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { OpenRouterProvider, GraphService } from '@cyanheads/mcp-ts-core/services';
import type { DataCanvas, CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { mcpTest, toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { fuzzTool, fuzzResource, fuzzPrompt } from '@cyanheads/mcp-ts-core/testing/fuzz';
```

See [CLAUDE.md/AGENTS.md](CLAUDE.md) for the complete exports reference.

## Examples

`examples/` holds a reference server built only on the public exports. `examples/index.ts` (Node/Bun) and `examples/worker.ts` (Cloudflare Workers) register the same `definitions/index.ts` barrels.

| Kind | Name | Pattern |
|:-----|:-----|:--------|
| Tool | `template_echo_message` | `errors[]` contract with `ctx.fail`, `inputAliases`, full-fidelity `format()` |
| Tool | `template_cat_fact` | `fetchWithTimeout`, a typed not-found contract, enrichment echo |
| Tool | `template_image_test` | `ctx.content.image` |
| Tool | `template_madlibs_elicitation` | `return ctx.requestInput`, a declined-input contract with `severity` |
| Tool | `template_data_explorer` | `appTool`/`appResource`, host theming, `cacheHint` |
| Resource | `echo://{message}` | Templated resource |
| Resource | `ui://template-data-explorer/app.html` | UI resource paired with `template_data_explorer` |
| Prompt | `code_review` | `completable()` argument, `code` argument |

## Testing

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { myTool } from '@/mcp-server/tools/definitions/my-tool.tool.js';

const ctx = createMockContext();
const input = myTool.input.parse({ query: 'test' });
const result = await myTool.handler(input, ctx);
```

`createMockContext()` gives you a recording `log`, a `signal`, and a `state` backed by a real `StorageService` over an in-memory provider, so key validation, TTL expiry, and the JSON round-trip of stored values behave as they do in production: a `Date` reads back as its ISO string, and a value JSON cannot encode rejects. It uses tenant `'default'` unless you pass `{ tenantId }`. Pass `{ errors: myTool.errors }` for a typed `ctx.fail`, or `{ inputResponses, requestState }` to start a multi-round-trip handler at its second round.

`/testing` also exports `createMockSession()` for session-bound contexts, `createFetchMock()` as a strict fake for upstream HTTP, and `runToolContract()`, which runs a definition through schema, handler, formatting, and error-envelope checks. `/testing/vitest` adds the `mcpTest` fixtures (`ctx`, `session`, `fetchMock`, `storage`) and `toolContractSuite()`.

`/testing/fuzz` uses `fast-check` to generate valid inputs from your Zod schemas plus adversarial payloads, then checks for crashes, stack-trace leaks, and prototype pollution:

```ts
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';

const report = await fuzzTool(myTool, { numRuns: 100 });
expect(report.crashes).toHaveLength(0);
expect(report.leaks).toHaveLength(0);
expect(report.prototypePollution).toBe(false);
```

It also exports `fuzzResource`, `fuzzPrompt`, `zodToArbitrary`, and `ADVERSARIAL_STRINGS` for custom property-based tests.

## Documentation

- **[CLAUDE.md/AGENTS.md](CLAUDE.md)**: the framework reference, covering exports, patterns, `Context`, error codes, auth, config, and testing. It ships in the npm package, so your agent reads it from `node_modules` after `init`.
- **[docs/telemetry/](docs/telemetry/)**: every span, metric, and attribute the framework emits ([observability.md](docs/telemetry/observability.md)), plus an example Grafana dashboard and query recipes for Datadog, New Relic, and Honeycomb ([dashboards.md](docs/telemetry/dashboards.md)).
- **[CHANGELOG.md](CHANGELOG.md)**: version history, indexing one file per release under `changelog/`. Each has a summary, migration notes, and links to commits and issues; releases that need downstream changes carry `agent-notes` for the `maintenance` skill to act on.

## Development

```bash
bun run rebuild        # clean + build (scripts/clean.ts + scripts/build.ts)
bun run devcheck       # full gate: lint/format, typecheck, MCP defs, framework antipatterns, docs/skills/changelog sync, audit, outdated, secrets/TODO scan
bun run lint:mcp       # validate MCP definitions against spec
bun run test:all       # rebuild + coverage + Node.js + Workers + integration
bun run test:package   # pack the tarball and consume it as an external project would
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
