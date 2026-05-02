# Agent Protocol

**Package:** `@cyanheads/mcp-ts-core` · **Version:** 0.8.10
**npm:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) · **Docker:** [ghcr.io/cyanheads/mcp-ts-core](https://ghcr.io/cyanheads/mcp-ts-core)

> **Developer note:** Never assume. Read related files and docs before making changes. Read full file content for context. Never edit a file before reading it.

---

## Core Rules

- **Logic throws, framework catches.** Pure, stateless `handler` functions. No `try...catch`. Throw on failure — plain `Error` is fine; the framework catches, classifies, and formats. Use `McpError(code, message, data, options?)` only when you need a specific JSON-RPC error code or structured data payload. The optional 4th arg accepts `{ cause }` for error chaining.
- **Full-stack observability.** The framework automatically instruments every tool/resource call — OTel span, duration/payload/memory metrics, structured completion log. Use `ctx.log` for additional domain-specific logging within handlers (external API calls, multi-step operations, business events). `requestId`, `traceId`, `tenantId` auto-correlated. No `console` calls.
- **Unified Context.** Handlers receive `ctx` with logging (`ctx.log`), tenant-scoped storage (`ctx.state`), optional protocol capabilities (`ctx.elicit`, `ctx.sample`), and cancellation (`ctx.signal`).
- **Decoupled storage.** `ctx.state` for tenant-scoped KV. Never access persistence backends directly.
- **Runtime parity.** All features work with `stdio`/`http` and Worker bundle. Guard non-portable deps via `runtimeCaps` from `@cyanheads/mcp-ts-core/utils` — a frozen capability object (`isNode`, `isBun`, `isWorkerLike`, `hasBuffer`, `hasProcess`, etc.) computed once at module load. Prefer runtime-agnostic abstractions (Hono + `@hono/mcp`, Fetch APIs).
- **Startup validation.** `createApp()` runs the definition linter before proceeding — errors (spec violations) throw `ConfigurationError` and block startup; warnings are logged. Also available standalone via `bun run lint:mcp` and as a devcheck step. Every diagnostic links to the rule reference in `api-linter` skill; see that skill for the full rule catalog.
- **Elicitation for missing input.** Use `ctx.elicit` when the client supports it.

---

## Exports Reference

| Subpath | Key Exports | Purpose |
|:--------|:------------|:--------|
| `@cyanheads/mcp-ts-core` | `createApp`, `tool`, `resource`, `prompt`, `appTool`, `appResource`, `APP_RESOURCE_MIME_TYPE`, `Context`, `createFail`, `createRecoveryFor`, `TypedFail`, `TypedRecoveryFor`, `ReasonOf`, `HandlerContext`, `z` | Main entry point |
| `/worker` | `createWorkerHandler`, `CloudflareBindings` | Cloudflare Workers entry |
| `/tools` | `ToolDefinition`, `AnyToolDefinition`, `ToolAnnotations` | Tool definition types |
| `/resources` | `ResourceDefinition`, `AnyResourceDefinition` | Resource definition types |
| `/prompts` | `PromptDefinition` | Prompt definition type |
| `/tasks` | `TaskToolDefinition`, `isTaskToolDefinition` | Task tool escape hatch |
| `/errors` | `McpError`, `JsonRpcErrorCode`, `notFound`, `validationError`, `unauthorized`, ... | Error types, codes, and factory functions |
| `/config` | `AppConfig`, `config`, `parseConfig`, `parseEnvConfig`, `resetConfig`, `ConfigSchema`, `FRAMEWORK_NAME`, `FRAMEWORK_VERSION` | Zod-validated config, framework identity, env-var helper |
| `/auth` | `checkScopes` | Dynamic scope checking |
| `/storage` | `StorageService` | Storage abstraction |
| `/storage/types` | `IStorageProvider` | Provider interface |
| `/canvas` | `DataCanvas`, `CanvasInstance`, `CanvasRegistry`, `IDataCanvasProvider`, `DuckdbProvider`, `assertReadOnlyQuery`, `quoteIdentifier`, ... | DataCanvas primitive (Tier 3, optional peer dep `@duckdb/node-api`); SQL/analytical workspace |
| `/utils` | formatting, encoding, network, pagination, logging, runtime, telemetry, token counting, parsers†, sanitization†, scheduling† | All utilities (†optional peer deps) |
| `/services` | `OpenRouterProvider`, `SpeechService`, `createSpeechProvider`, `ElevenLabsProvider`, `WhisperProvider`, `GraphService`, provider interfaces and types | LLM, Speech (TTS/STT), Graph services |
| `/linter` | `validateDefinitions`, `LintReport`, `LintDiagnostic`, `LintInput`, `LintSeverity` | Definition validation |
| `/testing` | `createMockContext` | Test helpers |
| `/testing/fuzz` | `fuzzTool`, `fuzzResource`, `fuzzPrompt`, `zodToArbitrary`, `adversarialArbitrary`, `ADVERSARIAL_STRINGS` | Fuzz testing |

All subpaths prefixed with `@cyanheads/mcp-ts-core`. **†Tier 3 modules** require optional peer dependencies — see `package.json` `peerDependencies`. Tier 3 methods that lazy-load deps are **async**.

### Import conventions

```ts
// Framework (from node_modules) — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code (via path alias)
import { getMyService } from '@/services/my-domain/my-service.js';
```

Build configs exported for consumer extension: `tsconfig.json` extends `@cyanheads/mcp-ts-core/tsconfig.base.json`, `biome.json` extends `@cyanheads/mcp-ts-core/biome`, `vitest.config.ts` spreads from `@cyanheads/mcp-ts-core/vitest.config`.

---

## Entry Points

### Node.js — `createApp(options)`

```ts
import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/index.js';
import { allResourceDefinitions } from './mcp-server/resources/index.js';
import { allPromptDefinitions } from './mcp-server/prompts/index.js';

await createApp({
  name: 'my-mcp-server',           // overrides package.json / MCP_SERVER_NAME
  version: '0.1.0',                // overrides package.json / MCP_SERVER_VERSION
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  extensions: {                     // SEP-2133 extensions advertised in capabilities
    'vendor/my-extension': { /* extension config */ },
  },
  setup(core) {                     // runs after core services init, before transport starts
    initMyService(core.config, core.storage);
  },
});
```

### Cloudflare Workers — `createWorkerHandler(options)`

```ts
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

export default createWorkerHandler({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  setup(core) { initMyService(core.config, core.storage); },
  extraEnvBindings: [['MY_API_KEY', 'MY_API_KEY']],       // string values → process.env
  extraObjectBindings: [['MY_CUSTOM_KV', 'MY_CUSTOM_KV']], // KV/R2/D1 → globalThis
  onScheduled: async (controller, env, ctx) => { /* cron */ },
});
```

Per-request `McpServer` factory (security: SDK GHSA-345p-7cg4-v4c7). Requires `compatibility_flags = ["nodejs_compat"]` and `compatibility_date >= "2025-09-01"` in `wrangler.toml`. Only `in-memory`, `cloudflare-r2`, `cloudflare-kv`, `cloudflare-d1` storage in Workers. See `api-workers` skill for full details.

### Interfaces

`createApp()` returns `Promise<ServerHandle>`. `createWorkerHandler()` returns an `ExportedHandler`.

```ts
interface CoreServices {
  config: AppConfig;
  logger: Logger;
  storage: StorageService;
  rateLimiter: RateLimiter;
  llmProvider?: ILlmProvider;
  speechService?: SpeechService;
  supabase?: SupabaseClient;
}

interface ServerHandle {
  shutdown(signal?: string): Promise<void>;
  readonly services: CoreServices;
}
```

---

## Server Structure

```text
src/
  index.ts                              # createApp() entry point
  worker.ts                             # createWorkerHandler() (if using Workers)
  config/
    server-config.ts                    # Server-specific env vars (own Zod schema)
  services/
    [domain]/
      [domain]-service.ts               # Domain service (init/accessor pattern)
      types.ts                          # Domain types
  mcp-server/
    tools/definitions/
      [tool-name].tool.ts               # Tool definitions
      index.ts                          # allToolDefinitions barrel
    resources/definitions/
      [resource-name].resource.ts       # Resource definitions
      index.ts                          # allResourceDefinitions barrel
    prompts/definitions/
      [prompt-name].prompt.ts           # Prompt definitions
      index.ts                          # allPromptDefinitions barrel
```

**File suffixes:** `.tool.ts` (standard or task), `.resource.ts`, `.prompt.ts`, `.app-tool.ts` (UI-enabled), `.app-resource.ts` (UI resource linked to app tool).

**Scaffold a new server:** `npx @cyanheads/mcp-ts-core init [name]` copies `templates/` into a new project. After running, consult the `setup` skill.

**`templates/` directory:** Scaffolding source for the init CLI. Contents are copied into new consumer servers — includes starter `package.json`, `tsconfig`, `biome.json`, `vitest.config.ts`, `.env.example`, `Dockerfile`, `CLAUDE.md`/`AGENTS.md`, and example tool/resource/prompt definitions. Files prefixed with `_` (e.g. `_.gitignore`, `_tsconfig.json`) are renamed on copy (strip `_` prefix). Changes here affect every newly scaffolded server.

---

## Adding a Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

export const myTool = tool('my_tool', {
  description: 'Does something useful.',
  annotations: { readOnlyHint: true },
  input: z.object({ query: z.string().describe('Search query') }),
  output: z.object({
    items: z.array(z.object({
      id: z.string().describe('Item ID'),
      name: z.string().describe('Item name'),
      status: z.string().describe('Current status'),
      description: z.string().optional().describe('Item description'),
    })).describe('Matching items'),
    totalCount: z.number().describe('Total matches before pagination'),
  }),
  auth: ['tool:my_tool:read'],

  async handler(input, ctx) {
    const data = await fetchFromApi(input.query);
    ctx.log.info('Query resolved', { query: input.query, resultCount: data.items.length });
    return data;
  },

  format: (result) => {
    const lines = [`**${result.totalCount} results**\n`];
    for (const item of result.items) {
      lines.push(`### ${item.name}`);
      lines.push(`**ID:** ${item.id} | **Status:** ${item.status}`);
      if (item.description) lines.push(item.description);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

**Steps:** Create `src/mcp-server/tools/definitions/[name].tool.ts` (kebab-case) → use `tool('snake_case', {...})` with Zod `.describe()` on all fields → implement `handler(input, ctx)` (pure, throws on failure) → add `auth`/`format` if needed → register in `definitions/index.ts` → `bun run devcheck` → smoke-test with `bun run rebuild && bun run start:stdio` (or `start:http`).

**Schema constraint:** Input/output schemas must use JSON-Schema-serializable Zod types only. The MCP SDK converts schemas to JSON Schema for `tools/list` — non-serializable types (`z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`) cause a hard runtime failure. Use structural equivalents instead (e.g., `z.string()` with `.describe('ISO 8601 date')` instead of `z.date()`). The linter validates this at startup.

**Form-client safety:** Form-based MCP clients (MCP Inspector, web UIs) send optional object fields with empty-string inner values instead of `undefined`. Don't reject with `.min(1)` on optional fields — guard for meaningful values in the handler (`if (input.dateRange?.minDate && input.dateRange?.maxDate)`). Test with both omitted and empty-value payloads. Alternative when schema-level constraints (regex/length) matter enough to surface in the JSON Schema: wrap in a union with a `z.literal('')` sentinel — `z.union([z.literal(''), z.string().regex(...).describe(...)])`. The linter exempts literal variants from `describe-on-fields`; the LLM sees the regex/length via the non-literal branch.

**`format`**: Maps output to MCP `content[]`. Different MCP clients forward different surfaces to the model — some (e.g., Claude Code) read `structuredContent` from `output`, others (e.g., Claude Desktop) read `content[]` from `format()`. **Both must be content-complete** so every client sees the same data — `format()` is the markdown-rendered twin of `structuredContent`, not a separate payload. A thin `format()` (count or title only) leaves `content[]`-only clients blind to data that `structuredContent` clients can see. Enforced at lint time: every terminal field in `output` must appear in `format()`'s rendered text (via sentinel injection), or startup fails with a `format-parity` error. Primary fix: render the missing field in `format()` (use `z.discriminatedUnion` for list/detail variants — each branch is validated separately). Escape hatch: if the output schema was over-typed for a genuinely dynamic upstream API, relax it (`z.object({}).passthrough()`) rather than maintaining aspirational typing — passthrough still flows data to `structuredContent`. Omit `format` entirely for JSON stringify fallback. Additional formatters: `markdown()` (builder), `diffFormatter` (async), `tableFormatter`, `treeFormatter` from `/utils`.

**Task tools:** Add `task: true` for long-running async operations. Framework manages lifecycle: creates task → returns ID immediately → runs handler in background with `ctx.progress` → stores result/error → `ctx.signal` for cancellation. See `add-tool` skill for full example.

---

## Adding a Resource

**Tool coverage.** Not all MCP clients expose resources — many are tool-only. Verify that resource data is also reachable via the tool surface before relying on resources as an access path.

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';

export const myResource = resource('myscheme://{itemId}/data', {
  description: 'Retrieve item data by ID.',
  mimeType: 'application/json',
  params: z.object({ itemId: z.string().describe('Item identifier') }),
  auth: ['item:read'],
  async handler(params, ctx) {
    return { id: params.itemId, status: 'active' };
  },
  list: async () => ({
    resources: [{ uri: 'myscheme://all', name: 'All Items', mimeType: 'application/json' }],
  }),
});
```

Handler receives `(params, ctx)` — URI on `ctx.uri` if needed. Optional `size` (bytes) for content size metadata. Large lists must use `extractCursor`/`paginateArray` from `/utils`.

---

## Adding a Prompt

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const codeReview = prompt('code_review', {
  description: 'Review code for security and best practices.',
  args: z.object({
    code: z.string().describe('Code to review'),
    language: z.string().optional().describe('Programming language'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Review this ${args.language ?? ''} code:\n${args.code}` } },
  ],
});
```

Prompts are pure message templates — no `Context`, no auth, no side effects.

---

## Adding a Service

Init/accessor pattern — initialized in `setup()`, accessed at request time.

```ts
export class MyService {
  constructor(private readonly config: AppConfig, private readonly storage: StorageService) {}
  async doWork(input: string, ctx: Context): Promise<string> {
    ctx.log.debug('Working', { input });
    return `done: ${input}`;
  }
}

let _service: MyService | undefined;
export function initMyService(config: AppConfig, storage: StorageService): void {
  _service = new MyService(config, storage);
}
export function getMyService(): MyService {
  if (!_service) throw new Error('MyService not initialized — call initMyService() in setup()');
  return _service;
}
```

Usage: `getMyService().doWork(input.query, ctx)`. Convention: `ctx.elicit`/`ctx.sample` only from tool handlers, not services.

**API efficiency:** Prefer batch endpoints over N+1 individual requests. Use field selection to minimize payload. Cross-reference batch responses against requested IDs to detect missing items. See `add-service` skill for patterns.

---

## Context

```ts
interface Context {
  readonly requestId: string;
  readonly timestamp: string;
  readonly tenantId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly auth?: AuthContext;
  readonly log: ContextLogger;                // auto-correlated: requestId, traceId, tenantId
  readonly state: ContextState;               // tenant-scoped KV storage
  readonly elicit?: (message: string, schema: z.ZodObject<any>) => Promise<ElicitResult>;
  readonly sample?: (messages: SamplingMessage[], opts?: SamplingOpts) => Promise<CreateMessageResult>;
  readonly notifyResourceListChanged?: (() => void) | undefined;   // resource list changed
  readonly notifyResourceUpdated?: ((uri: string) => void) | undefined; // resource content changed
  readonly signal: AbortSignal;               // cancellation
  readonly progress?: ContextProgress;        // present when task: true
  readonly uri?: URL;                         // present for resource handlers
  recoveryFor(reason: string): { recovery: { hint: string } } | {};  // opt-in contract resolver
}
```

### `ctx.log`

Opt-in domain-specific logging. Methods: `debug`, `info`, `notice`, `warning`, `error`. Auto-includes `requestId`, `traceId`, `tenantId`, `spanId`. Use `ctx.log` in handlers; global `logger` for startup/shutdown/background.

### `ctx.state`

Tenant-scoped KV. Accepts any serializable value — no manual `JSON.stringify`/`JSON.parse` needed.

```ts
await ctx.state.set('item:123', { name: 'Widget', count: 42 });
await ctx.state.set('item:123', data, { ttl: 3600 });           // with TTL (seconds)
const item = await ctx.state.get<Item>('item:123');              // T | null
const safe = await ctx.state.get('item:123', ItemSchema);        // Zod-validated T | null
await ctx.state.delete('item:123');
const values = await ctx.state.getMany<Item>(['item:1', 'item:2']); // Map<string, T>
const page = await ctx.state.list('item:', { cursor, limit: 20 });  // { items, cursor? }
```

Throws `McpError(InvalidRequest)` if `tenantId` missing. Tenant ID resolution:

| Mode | `tenantId` source |
|:-----|:------------------|
| stdio (any auth) | `'default'` |
| HTTP + `MCP_AUTH_MODE=none` | `'default'` (single-tenant by design) |
| HTTP + `MCP_AUTH_MODE=jwt`/`oauth` | JWT `'tid'` claim — fail-closed if absent |

### `ctx.elicit` / `ctx.sample`

Check for presence before calling:

```ts
if (ctx.elicit) {
  const result = await ctx.elicit('What format?', z.object({
    format: z.enum(['json', 'csv']).describe('Output format'),
  }));
  if (result.action === 'accept') useFormat(result.data.format);
}
```

### `ctx.progress`

Present when `task: true`. Methods: `setTotal(n)`, `increment(amount?)`, `update(message)`.

See `api-context` skill for full details.

---

## Error Handling

**Recommended path: declare a typed error contract.** Add `errors: [{ reason, code, when, recovery, retryable? }]` to `tool()` / `resource()`. The handler then receives `ctx.fail(reason, msg?, data?)` typed against the reason union — `ctx.fail('typo')` is a TypeScript error. The runtime auto-populates `data.reason` for observability and the linter enforces conformance against the handler body. The `recovery` field is required (≥5 words, lint-validated) — it's the single source of truth for the recovery hint that flows to the wire. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text). Override with explicit `{ recovery: { hint: '...' } }` when runtime context matters.

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No PMID returned data',
    recovery: 'Try pubmed_search_articles to discover valid PMIDs first.' },
  { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited,
    when: 'Queue at capacity', retryable: true,
    recovery: 'Wait 30 seconds before retrying or reduce batch size.' },
],
async handler(input, ctx) {
  // Static recovery — pulled from the contract via ctx.recoveryFor.
  if (queue.full()) throw ctx.fail('queue_full', undefined, { ...ctx.recoveryFor('queue_full') });
  // Dynamic recovery — interpolate runtime context, override the contract default.
  if (!matched) throw ctx.fail('no_match', `No data for ${input.pmids.length} PMIDs`, {
    pmids: input.pmids,
    recovery: { hint: `Use pubmed_search_articles to discover valid PMIDs.` },
  });
}
```

**`ctx.recoveryFor(reason)`** is the first member of a planned family of opt-in resolution helpers (future: `troubleshootingFor`, `userMessageFor`, …). Always present on `Context` (returns `{}` when no contract is attached or the reason is unknown — spread-safe), strictly typed on `HandlerContext<R>` against the declared reason union. The same resolver works in services that accept `ctx`: `throw validationError(msg, { reason: 'X', ...ctx.recoveryFor('X') })`. No auto-population — author opts in by typing the helper.

The contract describes the **public failure surface** — declare domain-specific failures only. **Baseline codes** (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble from anywhere and are auto-allowed by the conformance lint, so you don't need to enumerate them per-tool. The conformance lint scans handler source text only — failures thrown from called services aren't visible to it (still reach the client correctly via the auto-classifier, just without lint enforcement).

**Fallback for ad-hoc throws** (no contract entry fits, prototype tools, service-layer code): use error factories.

```ts
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId: '123' });
throw validationError('Missing required field: name', { field: 'name' });
```

Available factories: `invalidParams`, `invalidRequest`, `notFound`, `forbidden`, `unauthorized`, `validationError`, `conflict`, `rateLimited`, `timeout`, `serviceUnavailable`, `configurationError`, `internalError`, `serializationError`, `databaseError`. All accept `(message, data?, options?)` where `options` is `{ cause?: unknown }`.

For HTTP responses from upstream APIs, use `httpErrorFromResponse(response, { service, data })` from `/utils` — maps the full status table (401/403/408/422/429/5xx) and captures body + `Retry-After`.

**Auto-classification.** Plain `Error`, `ZodError`, and any other thrown value are caught and classified automatically. Resolution order: `McpError` code (preserved as-is) → JS constructor name (`TypeError` → `ValidationError`) → provider patterns (HTTP status codes, AWS errors, DB errors) → common message patterns → `AbortError` name → `InternalError` fallback.

**Error-path parity.** Tool errors mirror the success-path `format-parity` invariant — both surfaces clients forward to the agent carry the same payload:
- `content[]` (read by clients like Claude Desktop) — markdown rendering of the error, with `data.recovery.hint` mirrored into the text when present
- `structuredContent.error` (read by clients like Claude Code) — JSON `{ code, message, data? }` carrying the error code, message, and any structured data from the thrown `McpError` or `ZodError`

`_meta.error` is **not** emitted on tool errors — error data lives on `structuredContent.error`. Resources re-throw to the SDK, which routes them through the JSON-RPC error envelope (no parity wiring needed there).

The startup linter checks handler bodies for `prefer-mcp-error-in-handler`, `prefer-error-factory`, `preserve-cause-on-rethrow`, `no-stringify-upstream-error`, plus contract conformance (`error-contract-conformance` for undeclared non-baseline codes, `error-contract-prefer-fail` for declared codes thrown directly instead of via `ctx.fail`) — all warnings, surfaced in `bun run devcheck`.

See `api-errors` skill for the full pattern-matching table, error code reference, and detailed examples.

---

## Auth

Inline `auth` on definitions (primary pattern): `auth: ['tool:my_tool:read']`. Handler factory checks scopes before calling handler. Dynamic scopes via `checkScopes(ctx, [...])` from `/auth`.

**Scope naming:** colon-delimited strings. Conventions used in this codebase:

| Surface | Pattern | Example |
|:--------|:--------|:--------|
| Tools | `tool:<snake_name>:<verb>` | `tool:inventory_search:read` |
| Resources | `resource:<kebab-name>:<verb>` *or* domain-led `<domain>:<verb>` | `resource:echo-app-ui:read`, `inventory:read` |

Pick one convention per server and stay consistent. Verbs are typically `read`, `write`, `admin`.

**Modes** (`MCP_AUTH_MODE`): `none` (default) | `jwt` (local secret via `MCP_AUTH_SECRET_KEY`) | `oauth` (JWKS via `OAUTH_ISSUER_URL`, `OAUTH_AUDIENCE`). See `api-auth` skill for claims, CORS, and detailed config.

---

## Configuration

### Core config

Managed by `@cyanheads/mcp-ts-core`. Validated via Zod. Precedence: `createApp()` overrides > env vars > `package.json` (reads `name` → `MCP_SERVER_NAME`, `version` → `MCP_SERVER_VERSION`).

| Category | Key Variables |
|:---------|:-------------|
| Transport | `MCP_TRANSPORT_TYPE` (`stdio`\|`http`), `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_ENDPOINT_PATH` |
| Auth | `MCP_AUTH_MODE`, `MCP_AUTH_SECRET_KEY`, `OAUTH_*` |
| Storage | `STORAGE_PROVIDER_TYPE` (`in-memory`\|`filesystem`\|`supabase`\|`cloudflare-r2`\|`cloudflare-kv`\|`cloudflare-d1`) |
| LLM | `OPENROUTER_API_KEY`, `OPENROUTER_APP_URL/NAME`, `LLM_DEFAULT_*` |
| Telemetry | `OTEL_ENABLED`, `OTEL_SERVICE_NAME/VERSION`, `OTEL_EXPORTER_OTLP_*` |

### Server config (separate schema)

Own Zod schema for domain-specific env vars. **Never merge with core's schema.** Lazy-parse — do not eagerly parse `process.env` at top-level (Workers inject env at request time via `injectEnvVars()`). Prefer `parseEnvConfig(schema, envMap)` from `/config` over `schema.parse(...)` — it maps schema paths to env var names so errors say `MY_API_KEY is missing` instead of `apiKey: expected string`. Raw `ZodError` thrown from `setup()` is still caught and converted by the framework, but `parseEnvConfig` produces better messages. See `api-config` skill for example.

---

## Testing

```ts
import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { myTool } from '@/mcp-server/tools/definitions/my-tool.tool.js';

describe('myTool', () => {
  it('returns expected output', async () => {
    const ctx = createMockContext();
    const result = await myTool.handler(myTool.input.parse({ query: 'hello' }), ctx);
    expect(result.result).toBe('Found: hello');
  });
});
```

**`createMockContext` options:** `createMockContext()` (minimal), `{ tenantId: 'test-tenant' }` (enables state), `{ sample: vi.fn() }`, `{ elicit: vi.fn() }`, `{ progress: true }` (task progress).

**Fuzz testing:** `fuzzTool`/`fuzzResource`/`fuzzPrompt` from `/testing/fuzz` generate valid and adversarial inputs from Zod schemas via `fast-check`, then assert handler invariants (no crashes, no prototype pollution, no stack trace leaks). Returns a `FuzzReport` for custom assertions.

```ts
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';

it('survives fuzz testing', async () => {
  const report = await fuzzTool(myTool, { numRuns: 100 });
  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
```

Options: `numRuns` (valid inputs, default 50), `numAdversarial` (adversarial inputs, default 30), `seed` (reproducibility), `timeout` (per-call ms, default 5000), `ctx` (`MockContextOptions` for stateful handlers). Also exports `zodToArbitrary(schema)` for custom property-based tests and `ADVERSARIAL_STRINGS` for targeted injection testing.

**Vitest config:** Extend core config, add `@/` alias: `resolve: { alias: { '@/': new URL('./src/', import.meta.url).pathname } }`. Construct deps in `beforeEach`. Re-init services per suite.

---

## API Quick References

Detailed method signatures, options, and examples live in skill files. Read the relevant skill before starting a task it covers.

| Skill | Path | Covers |
|:------|:-----|:-------|
| `api-utils` | `skills/api-utils/SKILL.md` | formatting, parsing, security, network, pagination, runtime, scheduling, types, logger, requestContext, errorHandler, telemetry |
| `api-services` | `skills/api-services/SKILL.md` | LLM (OpenRouter), Speech (ElevenLabs TTS, Whisper STT), Graph (CRUD, traversal, pathfinding) |
| `api-context` | `skills/api-context/SKILL.md` | Context interface, createContext, ContextLogger/State/Progress |
| `api-errors` | `skills/api-errors/SKILL.md` | McpError, JsonRpcErrorCode, error handling patterns |
| `api-auth` | `skills/api-auth/SKILL.md` | Auth modes, scopes, JWT/OAuth strategies |
| `api-config` | `skills/api-config/SKILL.md` | AppConfig, parseConfig, env vars |
| `api-testing` | `skills/api-testing/SKILL.md` | createMockContext, test patterns, MockContextOptions |
| `api-workers` | `skills/api-workers/SKILL.md` | createWorkerHandler, CloudflareBindings, Worker runtime |
| `api-canvas` | `skills/api-canvas/SKILL.md` | DataCanvas primitive: acquire/register/query/export, token-sharing model, SQL gate, lifecycle |
| `api-linter` | `skills/api-linter/SKILL.md` | Definition lint rules (`format-parity`, `schema-*`, `name-*`, `server-json-*`, …) — look here when devcheck reports a lint diagnostic |
| `add-tool` | `skills/add-tool/SKILL.md` | Scaffold a new MCP tool definition |
| `add-app-tool` | `skills/add-app-tool/SKILL.md` | Scaffold an MCP App tool + UI resource pair |
| `add-resource` | `skills/add-resource/SKILL.md` | Scaffold a new MCP resource definition |
| `add-prompt` | `skills/add-prompt/SKILL.md` | Scaffold a new MCP prompt definition |
| `add-service` | `skills/add-service/SKILL.md` | Scaffold a new domain service |
| `add-test` | `skills/add-test/SKILL.md` | Scaffold test file for a tool, resource, or service |
| `field-test` | `skills/field-test/SKILL.md` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | `skills/security-pass/SKILL.md` | Review server for MCP-flavored security gaps: output injection, scope blast radius, elicit gaps, upstream auth, input sinks, tenant isolation, leakage, resource bounds |
| `add-provider` | `skills/add-provider/SKILL.md` | Add a new provider implementation |
| `add-export` | `skills/add-export/SKILL.md` | Add a new subpath export |
| `design-mcp-server` | `skills/design-mcp-server/SKILL.md` | Design tool surface, resources, and service layer for a new server |
| `setup` | `skills/setup/SKILL.md` | Initialize a new consumer server from the template |
| `polish-docs-meta` | `skills/polish-docs-meta/SKILL.md` | Finalize docs, README, metadata, and agent protocol for shipping |
| `report-issue-framework` | `skills/report-issue-framework/SKILL.md` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | `skills/report-issue-local/SKILL.md` | File a bug or feature request against this server's own repo via `gh` CLI |
| `release-and-publish` | `skills/release-and-publish/SKILL.md` | Post-wrapup ship workflow: verification gate, push, publish to npm/MCP Registry/GHCR |
| `maintenance` | `skills/maintenance/SKILL.md` | Dependency updates, housekeeping tasks |
| `migrate-mcp-ts-template` | `skills/migrate-mcp-ts-template/SKILL.md` | Migrate legacy template fork to package dependency |

---

## Code Style & Checklist

- **Validation:** Zod schemas, all fields need `.describe()`. See Adding a Tool for the JSON-Schema-serializable constraint and form-client safety.
- **Logging:** Framework auto-instruments all handler calls. `ctx.log` for domain-specific logging in handlers, global `logger` for lifecycle/background
- **Errors:** handlers throw — error factories (`notFound()`, `validationError()`, etc.) when the code matters, plain `Error` for don't-care cases. Framework catches and classifies.
- **Secrets:** server config only — no hardcoded credentials
- **Naming:** kebab-case files, snake_case tool/resource/prompt names, correct suffix
- **JSDoc:** `@fileoverview` + `@module` required on every file
- **No fabricated signal:** Don't invent synthetic scores or arbitrary "confidence percentages." Surface real signal.
- **Builders:** `tool()`/`resource()`/`prompt()` with correct fields (`handler`, `input`, `output`, `format`, `auth`, `args`)
- **`format()` completeness:** different clients forward different surfaces (Claude Code reads `structuredContent`, Claude Desktop reads `content[]`) — both must carry the same data; `format()` is the markdown twin of `structuredContent`, not a reduced summary
- **Auth:** via `auth: ['scope']` on definitions (not HOF wrapper)
- **Presence checks:** `ctx.elicit`/`ctx.sample` checked before use
- **Task tools:** use `task: true` flag
- **Pagination:** large resource lists use `extractCursor`/`paginateArray`
- **Registration:** definitions exported in `definitions/index.ts` barrel
- **Tests:** `createMockContext()`, `.handler()` tested directly
- **Gate:** `bun run devcheck` passes (includes MCP definition linting)
- **Smoke-test:** `bun run rebuild && bun run start:stdio` (or `start:http`)

---

## Git

**Safety:** NEVER `git stash`. NEVER destructive commands (`reset --hard`, `checkout -- .`, `restore .`, `clean -f`) unless user explicitly requests. Read-only is always safe.

**Commits:** Plain `-m` strings, no heredoc/command substitution. [Conventional Commits](https://www.conventionalcommits.org/): `feat|fix|refactor|chore|docs|test|build(scope): message`. Group related changes atomically.

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build library output (`scripts/build.ts`) |
| `bun run rebuild` | Clean and rebuild (`scripts/clean.ts` + `build`) |
| `bun run devcheck` | **Use often.** Lint, format, typecheck, MCP definition linting, `bun audit`, `bun outdated` |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run format` | Auto-fix Biome lint/format issues |
| `bun run test` | Unit/integration tests |
| `bun run start:stdio` | Production mode (stdio, after build) |
| `bun run start:http` | Production mode (HTTP, after build) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync with `changelog/` (used by devcheck) |

After `bun update --latest`, run the `maintenance` skill to investigate changelogs, adopt upstream changes, and sync project skills.

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` — one standalone file per released version (e.g. `changelog/0.5.x/0.5.4.md`), shipped in the npm package so agents can read a specific version from `node_modules/@cyanheads/mcp-ts-core/changelog/<major.minor>.x/<version>.md` without parsing a monolithic file. At release time, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. Read it to remember the frontmatter + section layout when scaffolding a new per-version file.

`CHANGELOG.md` is a **navigation index**, not a copy of bodies — each entry is a clickable header + one-line summary pulled from the per-version file's frontmatter. Regenerated by `bun run changelog:build`. Devcheck runs `changelog:check` and hard-fails on drift. Never hand-edit `CHANGELOG.md` — edit the per-version file and rerun the build.

### Per-version file format

```markdown
---
summary: One-line headline, ≤250 chars, no markdown  # required
breaking: false                                       # optional, default false
---

# 0.5.4 — 2026-04-20

Optional narrative intro (1-3 sentences).

## Added

- ...
```

**Frontmatter fields:**

| Field | Required | Purpose |
|:------|:---------|:--------|
| `summary` | yes | Rollup index line. Max 250 chars, no markdown, single line. Write like a GitHub Release title. |
| `breaking` | no (default `false`) | Flags releases with breaking changes. Renders as `· ⚠️ Breaking` badge in the rollup. Agents running the `maintenance` skill read this to prioritize review. |

Summary > 250 chars or malformed `breaking` fails `changelog:check`. Missing `summary` emits a warning and renders the rollup entry as header-only.

Pre-release versions (`0.6.0-beta.1`, `0.6.0-rc.1`, etc.) are consolidated as `##`/`###` sub-headers inside the final version's per-version file (`changelog/0.6.x/0.6.0.md`) when the final ships — they share the final version's frontmatter, no separate files per pre-release.

---

## Publishing

Run the `release-and-publish` skill — it runs the verification gate (`devcheck`, `rebuild`, `test:all`), pushes commits and tags, and publishes to every applicable destination. The full reference:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/mcp-ts-core:<version> \
  -t ghcr.io/cyanheads/mcp-ts-core:latest \
  --push .

mcp-publisher publish
```

