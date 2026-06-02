# Developer Protocol

**Package:** `@cyanheads/mcp-ts-core`
**Version:** 0.9.21
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3
**GitHub:** [cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core)
**npm:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
**Docker:** [ghcr.io/cyanheads/mcp-ts-core](https://ghcr.io/cyanheads/mcp-ts-core)

> **Developer note:** Never assume. Read related files and docs before making changes. Read full file content for context. Never try to edit a file before reading it.

---

## Consumers

This package serves two consumer paths. When making changes, know which audience your change affects:

| Path | On-ramp | Affected by changes to |
|:--|:--|:--|
| **Direct package import** — existing project pulls in the package | `bun add @cyanheads/mcp-ts-core` → `import { createApp, tool, z } from '@cyanheads/mcp-ts-core'` | Public API surface (`src/`) — existing consumers feel changes immediately on upgrade |
| **Init-scaffolded server** — fresh project bootstrapped from this repo's templates | `bunx @cyanheads/mcp-ts-core init [name]` copies `templates/` into the new directory | `templates/` — only affects newly scaffolded servers, not existing ones |

Both paths share the same public API. Init copies starter `package.json`, configs (`tsconfig`, `biome.json`, `vitest.config.ts`), `.env.example`, `Dockerfile`, `CLAUDE.md`/`AGENTS.md`, and example definitions. `_`-prefixed files (e.g. `_.gitignore`) drop the prefix on copy. After init, consult the `setup` skill.

---

## Core Rules

- **Logic throws, framework catches.** Pure, stateless `handler` functions, no `try/catch`. Plain `Error` works — framework catches, classifies, formats. Use `McpError(code, message, data, options?)` only when you need a specific JSON-RPC code or structured data; 4th arg `{ cause }` chains.
- **Full-stack observability.** The framework automatically instruments every tool/resource call — OTel span, duration/payload/memory metrics, structured completion log. Use `ctx.log` for additional domain-specific logging within handlers (external API calls, multi-step operations, business events). `requestId`, `traceId`, `tenantId` auto-correlated. No `console` calls.
- **Unified Context.** Handlers receive `ctx` with logging (`ctx.log`), tenant-scoped storage (`ctx.state`), optional protocol capabilities (`ctx.elicit`, `ctx.sample`), and cancellation (`ctx.signal`).
- **Decoupled storage.** `ctx.state` for tenant-scoped KV. Never access persistence backends directly.
- **Canvas tokens are capabilities, not tenant-scoped state.** A `canvasId` is a 10-char URL-safe token; possession grants full read/write/drop. Shareable between agents and across users in single-tenant deployments. Tools accept token in `input` (omit to create fresh) and return in `output`; collaboration is opt-in via token exchange.
- **Runtime parity.** All features work across `stdio`/`http`/Worker. Guard non-portable deps via `runtimeCaps` from `/utils` (`isNode`, `isBun`, `isWorkerLike`, `hasBuffer`, `hasProcess`, etc.). Prefer runtime-agnostic abstractions (Hono, Fetch APIs).
- **Definition linting is build-time only.** Run `bun run lint:mcp` (standalone) or `bun run devcheck` (gate). Not invoked at server startup — new lint rules are additive and never break deployed servers. Every diagnostic links to the rule reference in `api-linter` skill; see that skill for the full rule catalog.
- **Elicitation for missing input.** Use `ctx.elicit` when the client supports it.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Exports Reference

| Subpath | Key Exports | Purpose |
|:--------|:------------|:--------|
| `@cyanheads/mcp-ts-core` | `createApp`, `tool`, `resource`, `prompt`, `appTool`, `appResource`, `APP_RESOURCE_MIME_TYPE`, `Context`, `createFail`, `createRecoveryFor`, `TypedFail`, `TypedRecoveryFor`, `ReasonOf`, `HandlerContext`, `Enrich`, `EnrichHelpers`, `TypedEnrich`, `z` | Main entry point |
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
| `/canvas` | `DataCanvas`, `CanvasInstance`, `CanvasRegistry`, `IDataCanvasProvider`, `DuckdbProvider`, `spillover`, `inferSchemaFromRows`, `assertReadOnlyQuery`, `quoteIdentifier`, ... | DataCanvas primitive (Tier 3, optional peer dep `@duckdb/node-api`); SQL/analytical workspace + source-agnostic spillover helper |
| `/mirror` | `defineMirror`, `sqliteMirrorStore`, `buildSchemaSql`, `openSqliteHandle`, `Mirror`, `MirrorStore`, `MirrorDefinition`, `SyncContext`, `SyncPage`, ... | MirrorService primitive (Tier 3, optional peer dep `better-sqlite3` on Node; `bun:sqlite` built-in on Bun); persistent self-refreshing local mirror of a bulk upstream dataset (embedded SQLite + FTS5). Node/Bun only |
| `/utils` | formatting, encoding, network, pagination, logging, runtime, telemetry, token counting, parsers†, sanitization†, scheduling† | All utilities (†optional peer deps) |
| `/services` | `OpenRouterProvider`, `SpeechService`, `createSpeechProvider`, `ElevenLabsProvider`, `WhisperProvider`, `GraphService`, provider interfaces and types | LLM, Speech (TTS/STT), Graph services |
| `/linter` | `validateDefinitions`, `LintReport`, `LintDiagnostic`, `LintInput`, `LintSeverity` | Definition validation |
| `/testing` | `createMockContext`, `getEnrichment` | Test helpers |
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
  instructions:                     // server-level orientation, sent on every initialize
    'Pre-configured shortcuts:\n- `default` → production API\n' +
    'Other endpoints reachable via `connect({ baseUrl })`.',
  extensions: {                     // SEP-2133 extensions advertised in capabilities
    'vendor/my-extension': { /* extension config */ },
  },
  setup(core) {                     // runs after core services init, before transport starts
    initMyService(core.config, core.storage);
  },
});
```

**`instructions`** — Optional server-level orientation, surfaced on every `initialize` response as session-level system context. Use for deployment-specific guidance (connection aliases, regional notes, scope hints) instead of repeating in tool descriptions. Client adoption uneven but no downside when set.

### Cloudflare Workers — `createWorkerHandler(options)`

```ts
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

export default createWorkerHandler({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: (env) => `Region: ${env.ENVIRONMENT ?? 'production'}`,  // string | (env) => string
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

**Form-client safety:** Form-based clients (MCP Inspector, web UIs) send optional fields as empty strings, not `undefined`. Don't reject with `.min(1)` on optional fields — guard for meaningful values in the handler (`if (input.dateRange?.minDate && input.dateRange?.maxDate)`). Test with both omitted and empty-value payloads. When schema-level constraints (regex/length) need to surface in the JSON Schema, wrap in a union with a `z.literal('')` sentinel: `z.union([z.literal(''), z.string().regex(...).describe(...)])` — the linter exempts the literal variant from `describe-on-fields`.

**`format`**: Maps output to MCP `content[]`. Different clients forward different surfaces to the agent — some (Claude Code) read `structuredContent` from `output`, others (Claude Desktop) read `content[]` from `format()`. `format()` is the markdown twin of `structuredContent`, not a reduced summary.

- **Parity is enforced.** Every terminal field in `output` must appear in `format()`'s rendered text (via sentinel injection), or startup fails with a `format-parity` lint error.
- **Primary fix:** render the missing field in `format()`. Use `z.discriminatedUnion` for list/detail variants — each branch is validated separately.
- **Escape hatch:** if the schema was over-typed for a genuinely dynamic upstream API, relax it (`z.object({}).passthrough()`) — passthrough still flows data to `structuredContent`.
- **Fallback:** omit `format` for JSON stringify. Additional formatters in `/utils`: `markdown()` (builder), `diffFormatter` (async), `tableFormatter`, `treeFormatter`.

**`enrichment`** (optional): The success-path counterpart to `errors[]` — a `ZodRawShape` of agent-facing context (empty-result notices, query/filter echo, pagination totals) that must reach both client surfaces. Populate via `ctx.enrich(...)` (or `ctx.enrich.notice()` / `.total()` / `.echo()`) in the handler or service layer. The framework merges it into `structuredContent`, advertises `output.extend(enrichment)` as `outputSchema`, and mirrors it into a `content[]` trailer — so it reaches `structuredContent`-only and `content[]`-only clients alike, with no `format()` entry. Keys must be disjoint from `output`; a required field never populated fails the effective-output parse. See `api-context`'s `ctx.enrich`.

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
  readonly enrich: Enrich;                    // success-path agent context → structuredContent + content[]; typed on HandlerContext<R, E>
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
  if (result.action === 'accept') useFormat(result.content.format);
}
```

### `ctx.progress`

Present when `task: true`. Methods: `setTotal(n)`, `increment(amount?)`, `update(message)`.

See `api-context` skill for full details.

---

## Error Handling

**Recommended path: declare a typed error contract.** Add `errors: [{ reason, code, when, recovery, retryable? }]` to `tool()` / `resource()`. Handler gets `ctx.fail(reason, msg?, data?)` typed against the reason union — typos fail at compile time. Runtime auto-populates `data.reason` for observability; linter enforces conformance against the handler body. `recovery` is required (≥5 words, lint-validated) — the single source of truth for the wire hint. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire (framework mirrors `data.recovery.hint` into `content[]` text); override with explicit `{ recovery: { hint: '...' } }` when runtime context matters.

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

**`ctx.recoveryFor(reason)`** returns `{}` when no contract exists (spread-safe). Typed against the declared reason union on `HandlerContext<R>`. Works in services: `throw validationError(msg, { reason: 'X', ...ctx.recoveryFor('X') })`. Opt-in — author spreads explicitly.

**Contracts are inline, per-tool.** Don't extract shared `errors[]` constants — locality is the point, and dynamic `recovery` hints need tool-specific context. Declare domain-specific failures only; **baseline codes** (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) are auto-allowed by conformance lint. The lint scans handler source only — service-layer throws still reach clients via auto-classification.

**Fallback for ad-hoc throws** (no contract entry fits, prototype tools, service-layer code): use error factories.

```ts
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId: '123' });
throw validationError('Missing required field: name', { field: 'name' });
```

Available factories: `invalidParams`, `invalidRequest`, `notFound`, `forbidden`, `unauthorized`, `validationError`, `conflict`, `rateLimited`, `timeout`, `serviceUnavailable`, `configurationError`, `internalError`, `serializationError`, `databaseError`. All accept `(message, data?, options?)` where `options` is `{ cause?: unknown }`.

For HTTP responses from upstream APIs, use `httpErrorFromResponse(response, { service, data })` from `/utils` — maps the full status table (401/403/408/422/429/5xx) and captures body + `Retry-After`.

**Auto-classification.** Plain `Error`, `ZodError`, and any other thrown value are caught and classified automatically. Resolution order: `McpError` code (preserved as-is) → JS constructor name (`TypeError` → `ValidationError`) → provider patterns (HTTP status codes, AWS errors, DB errors) → common message patterns → `AbortError` name → `InternalError` fallback.

**Error-path parity.** Tool errors: `content[]` carries markdown with `data.recovery.hint`; `structuredContent.error` carries `{ code, message, data? }`. No `_meta.error`. Resources re-throw via JSON-RPC error envelope.

**Lint rules** (all warnings, surfaced in `devcheck`): `prefer-mcp-error-in-handler`, `prefer-error-factory`, `preserve-cause-on-rethrow`, `no-stringify-upstream-error`, `error-contract-conformance`, `error-contract-prefer-fail`. See `api-linter` skill.

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

**Granted scopes** union `scp`, `scope`, and `mcp_tool_scopes` JWT claims. `mcp_tool_scopes` is the OIDC escape hatch (Authentik, Keycloak < 26.5, Zitadel). `MCP_AUTH_DISABLE_SCOPE_CHECKS=true` bypasses scope checks while preserving auth-context verification (signature/audience/issuer/expiry). Logs `WARNING` at startup.

---

## Configuration

### Core config

Managed by `@cyanheads/mcp-ts-core`. Validated via Zod. Precedence: `createApp()` overrides > env vars > `package.json` (reads `name` → `MCP_SERVER_NAME`, `version` → `MCP_SERVER_VERSION`).

| Category | Key Variables |
|:---------|:-------------|
| Transport | `MCP_TRANSPORT_TYPE` (`stdio`\|`http`), `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_ENDPOINT_PATH` |
| Auth | `MCP_AUTH_MODE`, `MCP_AUTH_SECRET_KEY`, `MCP_AUTH_DISABLE_SCOPE_CHECKS`, `OAUTH_*` |
| Storage | `STORAGE_PROVIDER_TYPE` (`in-memory`\|`filesystem`\|`supabase`\|`cloudflare-r2`\|`cloudflare-kv`\|`cloudflare-d1`) |
| LLM | `OPENROUTER_API_KEY`, `OPENROUTER_APP_URL/NAME`, `LLM_DEFAULT_*` |
| Telemetry | `OTEL_ENABLED`, `OTEL_SERVICE_NAME/VERSION`, `OTEL_EXPORTER_OTLP_*` |

### Server config (separate schema)

Own Zod schema for domain-specific env vars. **Never merge with core's schema.** Lazy-parse — Workers inject env at request time via `injectEnvVars()`, so no top-level `process.env` reads. Prefer `parseEnvConfig(schema, envMap)` from `/config` over `schema.parse(...)` — it maps schema paths to env var names (`MY_API_KEY is missing` vs. `apiKey: expected string`). Raw `ZodError` from `setup()` is still caught and converted, but messages are worse. See `api-config` skill.

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

### Skill versioning

Each `skills/<name>/SKILL.md` carries `metadata.version` in frontmatter. The `maintenance` skill's Phase A uses this to sync consumer copies — replaces the **entire skill directory** as one unit. Without a version bump, Phase A skips the skill (content-hash backstop catches drift, but noisier).

**Policy:** Bump `metadata.version` when changing any file under `skills/<name>/` — SKILL.md is the single version knob for the directory. Typo/whitespace fixes exempt. One bump per release cycle suffices. Enforced by `bun run devcheck` (`scripts/check-skill-versions.ts`): a SKILL.md body change vs `HEAD` without a `metadata.version` bump surfaces as a warning; whitespace-only edits are ignored, and `devcheck.config.json` `skillVersions.ignore` opts out the typo-fix carve-out.

Skills live in `skills/<name>/SKILL.md`. Read the relevant skill before starting a task it covers. The full list is discoverable via the agent's skill registry at session start.

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
- **`format()` completeness:** must carry the same data as `output` (parity is lint-enforced — see Adding a Tool)
- **Auth:** via `auth: ['scope']` on definitions (not HOF wrapper)
- **Presence checks:** `ctx.elicit`/`ctx.sample` checked before use
- **Task tools:** use `task: true` flag
- **Pagination:** large resource lists use `extractCursor`/`paginateArray`
- **Registration:** definitions exported in `definitions/index.ts` barrel
- **Tests:** `createMockContext()`, `.handler()` tested directly
- **Gate:** `bun run devcheck` passes (includes MCP definition linting)
- **Smoke-test:** `bun run rebuild && bun run start:stdio` (or `start:http`)

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Build library output (`scripts/build.ts`) |
| `bun run rebuild` | Clean and rebuild (`scripts/clean.ts` + `build`) |
| `bun run devcheck` | **Use often.** Lint, format, typecheck, MCP definition linting, `bun audit`, `bun outdated` |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run format` | Auto-fix Biome lint/format issues (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior, not just formatting |
| `bun run test` | Unit/integration tests |
| `bun run start:stdio` | Production mode (stdio, after build) |
| `bun run start:http` | Production mode (HTTP, after build) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync with `changelog/` (used by devcheck) |

After `bun update --latest`, run the `maintenance` skill to investigate changelogs, adopt upstream changes, and sync project skills.

---

## Changelog

Directory-based. Source of truth: `changelog/<major.minor>.x/<version>.md` — one file per release (e.g. `changelog/0.5.x/0.5.4.md`), shipped in the npm package for direct agent access. `changelog/template.md` is the format reference (never edited).

`CHANGELOG.md` is a **navigation index** — clickable headers + one-line summaries from frontmatter. Regenerated by `bun run changelog:build`; `changelog:check` hard-fails on drift in devcheck. Never hand-edit — edit the per-version file and rerun the build.

### Per-version file format

```markdown
---
summary: "One-line headline, ≤350 chars, no markdown"  # required
breaking: false                                         # optional, default false
security: false                                         # optional, default false
---

# 0.5.4 — 2026-04-20

## Added

- ...
```

**Frontmatter fields:**

| Field | Required | Purpose |
|:------|:---------|:--------|
| `summary` | yes | Rollup index line. ≤350 chars, no markdown, single line. Write like a GitHub Release title. |
| `breaking` | no (default `false`) | Flags releases with breaking changes. Renders as `· ⚠️ Breaking` badge in the rollup. Agents running the `maintenance` skill read this to prioritize review. |
| `security` | no (default `false`) | Flags releases with security fixes. Renders as `· 🛡️ Security` badge in the rollup so users can triage upgrade urgency. Pairs with the `## Security` body section. |
| `agent-notes` | no | Free-form adoption notes for downstream `maintenance` agents — new files to create, fields to populate, skills to re-run, one-time migration steps. Not rendered in `CHANGELOG.md`; consumed only by agents running the `maintenance` skill on consumer projects. Omit when there's nothing to say. |

Badge order when both set: `· ⚠️ Breaking · 🛡️ Security`. Summary > 350 chars or malformed boolean fails `changelog:check`.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Omit empty sections. Pre-release versions consolidate as sub-headers inside the final version's file — no separate files per pre-release.

---

## Publishing

If the user requests it, run the `release-and-publish` skill — it runs the verification gate (`devcheck`, `rebuild`, `test:all`), pushes commits and tags, and publishes to every applicable destination. After pushing, create a GitHub Release via `bun run release:github` — no `manifest.json` here so no assets to attach, but the Release surfaces the tag's notes with the correct `v<VERSION>: <subject>` title. **Skip the Docker build/push step** — this framework package is consumed via npm, not as a container image.

**Tag annotations render as GitHub Release bodies** via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject must omit the version number (GitHub prepends `v<VERSION>:`). Body uses Keep a Changelog sections with bullets. See `changelog/template.md` for the full format reference including an example.
