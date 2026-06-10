# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.10.2](changelog/0.10.x/0.10.2.md) — 2026-06-10

Per-table TTL for DataCanvas; ctx.enrich.truncated() helper; canvas-consumer and capped-list-no-truncation lint rules; scaffold Dockerfile pre-creates writable data dirs.

## [0.10.1](changelog/0.10.x/0.10.1.md) — 2026-06-08 · 🛡️ Security

Security: DataCanvas SQL gate fails closed on non-SELECT and denies pragma_* table functions; scaffold/packaging fixes and actionable scheduler peer error.

## [0.10.0](changelog/0.10.x/0.10.0.md) — 2026-06-05

Outline-on-overflow helper for oversized document payloads; env booleans parse via Zod stringbool (rejects unrecognized values); built Docker images stamp image.version.

## [0.9.21](changelog/0.9.x/0.9.21.md) — 2026-06-02

HTTP transport per-request log context fixed — handlers now derive a fresh requestId/timestamp + live trace/span IDs instead of the frozen boot context

## [0.9.20](changelog/0.9.x/0.9.20.md) — 2026-06-01 · 🛡️ Security

Security: fetchWithTimeout redacts query-string secrets; error-contract lint scoped to throw sites; list-changed notifications routed via request scope under HTTP

## [0.9.19](changelog/0.9.x/0.9.19.md) — 2026-05-31

withRetry fail-fast on data.retryable === false; bun run release:github enforces v<VERSION>: <subject> title; Gate after column in workflow phase tables

## [0.9.18](changelog/0.9.x/0.9.18.md) — 2026-05-31

Two devcheck enforcement gates: a metadata.version bump check for SKILL.md body changes (#99), and an AST check for open-indexed-named interfaces (#123).

## [0.9.17](changelog/0.9.x/0.9.17.md) — 2026-05-30

MirrorService — persistent, self-refreshing local mirror of a bulk upstream dataset (embedded SQLite + FTS5) via new @cyanheads/mcp-ts-core/mirror subpath

## [0.9.16](changelog/0.9.x/0.9.16.md) — 2026-05-29

enrichmentTrailer.render switched to method syntax so tools declaring an enrichment block stay assignable to AnyToolDefinition — fixes the 0.9.15 createApp({ tools }) typecheck regression for every enrichment tool

## [0.9.15](changelog/0.9.x/0.9.15.md) — 2026-05-29

enrichmentTrailer per-field rendering, ctx.enrich.delta, three new enrichment lint rules, skill-sync prune for upstream-deleted skills, AGENTS.md shipped in npm package, safe format script

## [0.9.14](changelog/0.9.x/0.9.14.md) — 2026-05-29

The enrichment block on tool(): a typed, success-path contract for agent-facing context — empty-result notices, query echo, pagination totals — populated via ctx.enrich() and surfaced to both structuredContent and content[] without a format() entry. The success-path counterpart to errors[].

## [0.9.13](changelog/0.9.x/0.9.13.md) — 2026-05-28 · 🛡️ Security

HTTP transport hardening: configurable request body limit (413 guard) and auth-gated landing page inventory by default

## [0.9.12](changelog/0.9.x/0.9.12.md) — 2026-05-29

GET /mcp surfaces package.json keywords; orchestrations and maintenance-release workflow updates; openai patch

## [0.9.11](changelog/0.9.x/0.9.11.md) — 2026-05-28

code-simplifier skill, orchestrations skill restructure, init --help flag, MCPB user_config default guidance

## [0.9.10](changelog/0.9.x/0.9.10.md) — 2026-05-26

HTTP session-init gate, expected client error log-level split, plugin metadata scaffolding, skill updates

## [0.9.9](changelog/0.9.x/0.9.9.md) — 2026-05-24

fuzzTool Phase 1 pre-parse, ZodArray minLength, fast-check → optional peer dep, packaging cleanup

## [0.9.8](changelog/0.9.x/0.9.8.md) — 2026-05-24

Docs fixes, README context table updates, skill sync, @hono/node-server ^2.0.3 → ^2.0.4

## [0.9.7](changelog/0.9.x/0.9.7.md) — 2026-05-23

biome noDuplicateDependencies off, structured tag annotation format, release artifact verification, skills updates

## [0.9.6](changelog/0.9.x/0.9.6.md) — 2026-05-23

lint-packaging validates manifest name scope and user_config fields; multi-server-orchestration and polish-docs-meta skill gaps from pipeline run 2

## [0.9.5](changelog/0.9.x/0.9.5.md) — 2026-05-23

mcpbignore recursive-match fix, zod promoted to dependencies, polish-docs-meta MCPB step, maintenance template-file adoption, CLAUDE.md condensed

## [0.9.4](changelog/0.9.x/0.9.4.md) — 2026-05-22

Opt-in `MCP_GC_PRESSURE_INTERVAL_MS` forced-GC loop (Bun-only) drains the per-request `McpServer`/`McpSessionTransport` cycle under sustained low-traffic HTTP load (#50). Skill-versioning policy extended to reference files. README install-button URLs switched to HTTPS endpoints.

## [0.9.3](changelog/0.9.x/0.9.3.md) — 2026-05-22

`RequestContextLike` — closed-field projection canvas methods now accept, so handler `Context` passes straight to `DataCanvas`/`CanvasInstance`/`IDataCanvasProvider` without a slice helper (#108).

## [0.9.2](changelog/0.9.x/0.9.2.md) — 2026-05-22 · ⚠️ Breaking

`zod` → peerDep (consumers must `bun add zod`). MCPB bundle support (`bundle` script + `lint:packaging`). `field-test`: zsh `status` clash + per-agent helper paths. `multi-server-orchestration` skill + `list-skills`. `format-parity` walks each union branch. `fast-xml-parser` unpinned `^5.8.0`. Dep refresh: `@hono/mcp` `^0.3.0`, vitest `^4.1.7`.

## [0.9.1](changelog/0.9.x/0.9.1.md) — 2026-05-15

Gate experimental `tasks` capability on actual task-tool registration — clients pinned to MCP spec 2025-06-18 strict-parse and fail on the unknown key. Add `notifyPromptListChanged`/`notifyToolListChanged` to `Context`. OTel semconv `^1.40 → ^1.41` (stable `deployment.environment.name`). Pin `fast-xml-parser` to `5.7.3`.

## [0.9.0](changelog/0.9.x/0.9.0.md) — 2026-05-11 · ⚠️ Breaking · 🛡️ Security

Workers boot under `nodejs_compat` (#124), adds `instructions` on entry points (#91), cross-vendor portability lint family (#132), definition linting moves to build-time only. Plus RFC 8414 §3 well-known mount, SSRF hardening, tenant-id boundary check.

## [0.8.20](changelog/0.8.x/0.8.20.md) — 2026-05-09

`mcp_tool_scopes` claim union + `MCP_AUTH_DISABLE_SCOPE_CHECKS` bypass ([#128](https://github.com/cyanheads/mcp-ts-core/issues/128)) — operator escape hatches for OIDC providers that can't inject scopes into `scope`.

## [0.8.19](changelog/0.8.x/0.8.19.md) — 2026-05-08

Telemetry visualization docs ([#125](https://github.com/cyanheads/mcp-ts-core/issues/125)) — example Grafana dashboard JSON, vendor-agnostic query recipes, new `api-telemetry` skill. Engines bumped to Bun ≥1.3.0 / Node ≥24.0.0.

## [0.8.18](changelog/0.8.x/0.8.18.md) — 2026-05-06

Fix `ctx.auth.token` strip in `toAuthContext` ([#121](https://github.com/cyanheads/mcp-ts-core/issues/121)) — typed `token?: string` on `AuthContext`, forwarded by `withAuthInfo` and the ALS bridge so handlers can relay the bearer upstream.

## [0.8.17](changelog/0.8.x/0.8.17.md) — 2026-05-05

Surface `ctx.sessionId` on `Context` for HTTP handlers ([#116](https://github.com/cyanheads/mcp-ts-core/issues/116)) — fail-closed under stateless mode with `createApp({ context: { exposeStatelessSessionId } })` opt-in.

## [0.8.16](changelog/0.8.x/0.8.16.md) — 2026-05-05

Fix HTTP SSE per-request retention leak ([#50](https://github.com/cyanheads/mcp-ts-core/issues/50)) — bind `closePerRequestInstances` to the request `AbortSignal` so ungraceful client disconnects close the per-request McpServer/Transport pair.

## [0.8.15](changelog/0.8.x/0.8.15.md) — 2026-05-05

Source-agnostic `spillover()` helper exported from /canvas (#113); engine-agnostic `inferSchemaFromRows` lifted into canvas/core; api-canvas, add-tool, design-mcp-server skills updated.

## [0.8.14](changelog/0.8.x/0.8.14.md) — 2026-05-04

disabledTool/DisabledMetadata re-exported from package root (#109); new tool-defs-analysis skill (#111); Worker-runtime test harness via @cloudflare/vitest-pool-workers; example definitions polished; storage provider behavior table in README.

## [0.8.13](changelog/0.8.x/0.8.13.md) — 2026-05-03

Canvas registerView and importFrom; CanvasObjectKind discriminator on TableInfo and DescribeOptions; SQL gate allowlist refreshed against DuckDB v1.5.x operator names; spatial-extension hardening pre-staged.

## [0.8.12](changelog/0.8.x/0.8.12.md) — 2026-05-02

SQL gate blocks read_json*/read_parquet* file disclosure (#100); appendValue routes TIMESTAMP/DATE/BLOB to typed appenders (#102); CANVAS_IDENTIFIER_REGEX + SQL_GATE_REASONS exported (#104); RequestContext widened to accept handler Context (#105).

## [0.8.11](changelog/0.8.x/0.8.11.md) — 2026-05-02

disabledTool() wrapper for feature-flagged tools (#96); landing page gains an `unspecified` mutability bucket so unannotated tools no longer infer as `write` (#92); skill-versioning policy in CLAUDE.md/AGENTS.md with 7 retroactive bumps (#98).

## [0.8.10](changelog/0.8.x/0.8.10.md) — 2026-05-02

Canvas source relocated to src/services/canvas/ matching graph/llm/speech layout (consumer subpath @cyanheads/mcp-ts-core/canvas unchanged); design / add-tool / security-pass skills surface it as an option for tabular API servers.

## [0.8.9](changelog/0.8.x/0.8.9.md) — 2026-05-02

DataCanvas primitive lands as a Tier 3 SQL/analytical workspace backed by DuckDB ([#97](https://github.com/cyanheads/mcp-ts-core/issues/97)) — opt-in via CANVAS_PROVIDER_TYPE, fails closed on Cloudflare Workers.

## [0.8.8](changelog/0.8.x/0.8.8.md) — 2026-05-01

ErrorHandler stops double-writing ended OTel spans (recordException/setStatus); storage decodeCursor no longer leaks server stack traces through McpError.data on malformed cursors.

## [0.8.7](changelog/0.8.x/0.8.7.md) — 2026-04-29

Remove `dev` watch script (finishes 0.8.6 dev-vs-prod cleanup); fix field-test helper state collision when concurrent sessions run from different project directories.

## [0.8.6](changelog/0.8.x/0.8.6.md) — 2026-04-29

Remove `dev:stdio`/`dev:http` watch scripts from framework and template `package.json`; smoke-test path standardized to `bun run rebuild && bun run start:stdio` across docs and skills.

## [0.8.5](changelog/0.8.x/0.8.5.md) — 2026-04-29

HTTP+MCP_AUTH_MODE=none defaults tenantId to 'default' so ctx.state works without minting JWTs. New ctx.recoveryFor opt-in contract resolver carries the contract recovery onto the wire — single source of truth for handler and service throws.

## [0.8.4](changelog/0.8.x/0.8.4.md) — 2026-04-29 · ⚠️ Breaking

ErrorContract.recovery is now required (≥ 5 words, lint-validated). Decoupled from runtime data.recovery.hint — no auto-population, just a forcing function for thoughtful authoring.

## [0.8.3](changelog/0.8.x/0.8.3.md) — 2026-04-29 · ⚠️ Breaking

Tool error responses gain structuredContent.error parity with content[]; recovery hint mirrors into text; _meta.error and _meta['mcp-ts-core/errors'] wire publication dropped

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-04-28

Landing page tools section grouped by mutability with chip + search filter; status strip gains repo link; add-app-tool host-theming guidance; maintenance v2.0 hard-rule on framework adoption

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-04-28

Skills sync — service-thrown contract reasons (pass `data: { reason }` from factories), field-test helper hardening, maintenance skill-version paradox check, factory-choice semantic audit

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-04-28

Typed error contracts — declarative `errors[]` on tools/resources, typed `ctx.fail(reason)`, advertised in `tools/list`. New `httpErrorFromResponse` and `partialResult` utilities, three more error factories, handler-body + conformance lints

## [0.7.6](changelog/0.7.x/0.7.6.md) — 2026-04-27

maintenance skill Phase C enumerates package scripts/ instead of a hardcoded list (closes #69); skill git references made tool-agnostic; templates ship runner-friendly start script + bun engine

## [0.7.5](changelog/0.7.x/0.7.5.md) — 2026-04-25

init scaffold derives script list from package.json files: (closes #73); field-test and design-mcp-server skills audit descriptions for implementation leaks, meta-coaching, and consumer-aware phrasing (closes #74)

## [0.7.4](changelog/0.7.x/0.7.4.md) — 2026-04-24

linter exempts z.literal union variants from describe-on-fields; landing connect snippets resist Cloudflare email rewriting and accept operator overrides; maintenance skill surfaces new/changed skills

## [0.7.3](changelog/0.7.x/0.7.3.md) — 2026-04-24

format-parity numeric normalization rejects lossy digit-shift transforms while preserving locale support; fetchWithTimeout SSRF guard documented as best-effort with DNS-rebinding caveat

## [0.7.2](changelog/0.7.x/0.7.2.md) — 2026-04-24

Ship vitest.config subpath export as .mjs (fixes Node 22.7+ type-strip failure under node_modules); new devcheck step guards against SDK-coupling antipatterns

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-04-24

Security hardening — fail-closed Origin guard (loopback-only default), validated landing-page bearer check, raw-payload logging removed, opt-in LLM transcripts

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-04-24

Issue-cleanup release — flat ZodError messages with structured issues, locale-aware format-parity, devcheck changelog guard, skill protocol refinements, and GitHub label + template scaffolding

## [0.6.17](changelog/0.6.x/0.6.17.md) — 2026-04-24

HTTP transport hardening for issue #50 — per-server notifier race fix, bounded-timeout close with close_failures metric, and FinalizationRegistry diagnostic for per-request McpServer/transport retention

## [0.6.16](changelog/0.6.x/0.6.16.md) — 2026-04-23

Linter `describe-on-fields` recurses into nested objects, array elements, and union variants and now covers resource outputs; `maintenance` skill adds Phase C to sync framework scripts from package to consumer

## [0.6.15](changelog/0.6.x/0.6.15.md) — 2026-04-23

Scaffolded devcheck passes green on a fresh `init` (depcheck wired up); security-pass skill v1.1 expands coverage to resources, prompts, HTTP deployment surface, sampling, roots, telemetry, and schema strictness

## [0.6.14](changelog/0.6.x/0.6.14.md) — 2026-04-23

New security-pass skill (8-axis MCP server audit) and devcheck Skills Sync step verifying skills/ propagated to local agent mirrors

## [0.6.13](changelog/0.6.x/0.6.13.md) — 2026-04-23

PdfParser.extractText now accepts raw bytes directly, skipping the pdf-lib round-trip for text-only callers (unpdf-only path)

## [0.6.12](changelog/0.6.x/0.6.12.md) — 2026-04-23

Enrich report-issue-framework and report-issue-local skills with Writing Well-Structured Issues guidance and an expanded feature-request template

## [0.6.11](changelog/0.6.x/0.6.11.md) — 2026-04-23

Add HtmlExtractor Tier 3 utility — wraps defuddle + linkedom for extracting main article content and metadata from raw HTML into Markdown or cleaned HTML

## [0.6.10](changelog/0.6.x/0.6.10.md) — 2026-04-23

Rename release skill to release-and-publish with an end-to-end ship workflow, expand setup skill scaffolding docs, and bump @cloudflare/workers-types, @supabase/supabase-js, and vite

## [0.6.9](changelog/0.6.x/0.6.9.md) — 2026-04-22

Landing page refactored into a modular directory, CSS-injection guard promoted to manifest-build time, Content-Security-Policy header added, per-request rendering memoized when publicUrl is set, and accessibility hygiene cleanups

## [0.6.8](changelog/0.6.x/0.6.8.md) — 2026-04-22

Landing page visual polish — dual-accent token system (--accent-2, --accent-glow), animated border beam on the connect card, brighter dark mode, and a new CSS-injection guard on landing.theme.accent

## [0.6.7](changelog/0.6.x/0.6.7.md) — 2026-04-22

Template polish — echo app tool wired up in scaffold, version placeholder/gitignore/dockerignore fixes, stale `unreleased.md` doc references corrected, @types/bun + @types/node patch bumps

## [0.6.6](changelog/0.6.x/0.6.6.md) — 2026-04-22

MCP_PUBLIC_URL override for TLS-terminating proxies; design-mcp-server v2.7 — flexible tool naming, tiered subsections, server-as-service coverage, diversified examples; changelog/unreleased.md → template.md

## [0.6.5](changelog/0.6.x/0.6.5.md) — 2026-04-22

README "Let the agent drive" scaffolding pitch, package description tightened, dependency sweep (ext-apps 1.7, vitest 4.1.5, workers-types)

## [0.6.4](changelog/0.6.x/0.6.4.md) — 2026-04-21

Fix landing-page connect snippets for hosted HTTP deployments — drop no-op env block from HTTP config, retarget Claude tab at the HTTP endpoint

## [0.6.3](changelog/0.6.x/0.6.3.md) — 2026-04-21

Expose sourceUrl override on Tool/Resource/Prompt definitions — closes the type/runtime gap for landing-page view-source links

## [0.6.2](changelog/0.6.x/0.6.2.md) — 2026-04-21

Soften directory-based changelog prescription for downstream; clarify unreleased.md is a pristine format reference; landing page polish

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-04-21

Landing page polish — terminal-chrome connect card with tabbed snippets, envExample config, dot-separated status strip, ambient accent hairline

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-04-21

Landing page + SEP-1649 Server Card at /, unified server manifest, directory-based changelog system

## [0.5.4](changelog/0.5.x/0.5.4.md) — 2026-04-20

Lint rule discoverability — reference doc covering every rule, diagnostic breadcrumbs, fix dangling devcheck tip

## [0.5.3](changelog/0.5.x/0.5.3.md) — 2026-04-20

Dual-surface format-parity messaging, docs-sync devcheck step — CLAUDE.md/AGENTS.md drift detection, @hono/node-server v2

## [0.5.2](changelog/0.5.x/0.5.2.md) — 2026-04-20

format-parity lint rule enforces format/structuredContent coverage at startup — sentinel injection, 16 new tests, example tools updated

## [0.5.1](changelog/0.5.x/0.5.1.md) — 2026-04-20

Documentation polish — README conventions rewrite for polish-docs-meta skill, retroactive version bumps for api-config and setup skills

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-04-20

Actionable startup errors — ZodError converted to ConfigurationError banner, parseEnvConfig helper, maintenance skill rewrite, dep sync

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-04-19

Full OTel instrumentation for MCP prompts — spans, six new metrics, ATTR_MCP_PROMPT_* constants, active-requests gauge coverage

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-19

Modernized testing surface — createMockLogger, createInMemoryStorage, custom Vitest matchers, Vitest 4 projects config, shared test helpers

## [0.3.8](changelog/0.3.x/0.3.8.md) — 2026-04-19

Fix doubled Error prefix in tool/resource error content — McpError.message now carries original message verbatim, operation context preserved in logs

## [0.3.7](changelog/0.3.x/0.3.7.md) — 2026-04-19

Fix pino-redact crash on Node 25 when AbortSignal in log payload — sanitizeLogBindings, 14 new tests

## [0.3.6](changelog/0.3.x/0.3.6.md) — 2026-04-19

Security patches for critical protobufjs and moderate hono advisories, OTel peer dep range alignment, dependency sweep to latest

## [0.3.5](changelog/0.3.x/0.3.5.md) — 2026-04-13

Skill doc improvements for add-test and design-mcp-server, add-app-tool added to consumer templates, dependency updates

## [0.3.4](changelog/0.3.x/0.3.4.md) — 2026-04-08

MCP Apps resource metadata and read-time formatting fixes, skill and template guidance refresh, minor dependency updates

## [0.3.3](changelog/0.3.x/0.3.3.md) — 2026-04-08

Static-URI resource registration fix — ResourceRegistry uses SDK string overload for non-template URIs, MCP Apps template cleanup, dependency updates

## [0.3.2](changelog/0.3.x/0.3.2.md) — 2026-04-06

Richer GET /mcp status response — protocolVersions, extensions, framework homepage, mcpServerHomepage config field

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-04-06

Promote @opentelemetry/api to direct dependency, add structural test guarding against eager optional peer dep imports

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-06

MCP Apps integration — appTool and appResource builders, _meta passthrough, linter pairing rules, template echo app, and comprehensive test coverage

## [0.2.12](changelog/0.2.x/0.2.12.md) — 2026-04-03

OTel metricReaders deprecation fix, form-client safety guidance for empty-string optional fields, dependency updates

## [0.2.11](changelog/0.2.x/0.2.11.md) — 2026-04-01

SEP-2133 extensions support, resource size metadata, HTTP protocol error handling, startup log consolidation

## [0.2.10](changelog/0.2.x/0.2.10.md) — 2026-03-30

Task session isolation fixes, devcheck audit resilience, and broad test coverage across app lifecycle, CLI scaffold, task registration, auth, and HTTP authz

## [0.2.9](changelog/0.2.x/0.2.9.md) — 2026-03-29

Cache negative lazy-import results to eliminate optional peer dep metric spam — new lazyImport utility, OpenRouter tryCatch fix

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-03-28

Heartbeat disabled by default — stdio servers no longer self-terminate in dev mode or simple harnesses without a client

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-03-28

Stdio heartbeat monitor for dead connection detection, session duration histogram, new OTel attributes and counters

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-03-28

Empty server handler init fix, OpenTelemetry API moved to optional peer dep, expanded unit and integration test coverage

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-03-28

Batch partial success telemetry with auto-detection, new OTel attribute constants, tools-first design philosophy, expanded error classification guidance

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-03-28

Server.json manifest linter with full spec validation, API efficiency patterns in service skill, dependency security overrides

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-03-28

format() content-completeness guidance across docs and scaffolding, echo template clarification, minor dependency update

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-03-26

Error category telemetry — new ErrorCategory type and classifier, mcp.tool.error_category OTel attribute, OpenTelemetry and SDK dependency bumps

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-03-25

Docker build fix for optional peer deps — local FxpModule interface replaces static type reference, unblocks multi-platform builds

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-03-24

Fuzz testing framework with schema-aware property-based testing, retry utility with exponential backoff, GitHub issue templates, and issue reporting skills

## [0.1.29](changelog/0.1.x/0.1.29.md) — 2026-03-24

Linter fix for idempotentHint false positive, skill doc improvements for design and polish-docs-meta, dependency updates

## [0.1.28](changelog/0.1.x/0.1.28.md) — 2026-03-23

TypeScript 6 migration — upgraded from 5.9 to 6.0, removed baseUrl from tsconfigs, switched path mappings to relative syntax, cleaned up duplicate typescript dependency

## [0.1.27](changelog/0.1.x/0.1.27.md) — 2026-03-23

Expanded OTel metrics instrumentation — tool/resource I/O histograms, HTTP client duration, eager metric initialization, comprehensive metrics test suite

## [0.1.26](changelog/0.1.x/0.1.26.md) — 2026-03-23

Resource notification support — ctx.notifyResourceUpdated and ctx.notifyResourceListChanged for dynamic resource subscriptions, mock context support, dependency updates

## [0.1.25](changelog/0.1.x/0.1.25.md) — 2026-03-21

Consumer identity resolution — parseConfig reads consumer package.json, OTEL service identity propagated from createApp name and version

## [0.1.24](changelog/0.1.x/0.1.24.md) — 2026-03-21

Docker OTel enabled by default, Worker transport type fix, SessionAwareTaskStore async correctness

## [0.1.23](changelog/0.1.x/0.1.23.md) — 2026-03-21

Config correctness and transport resilience — env boolean coercion fix, optional OTel startup hardening, Docker OTel opt-in build arg

## [0.1.22](changelog/0.1.x/0.1.22.md) — 2026-03-21

Linter hardening — schema serializability, auth scope, annotation coherence, and URI template-params alignment checks added, tool name format upgraded to error

## [0.1.21](changelog/0.1.x/0.1.21.md) — 2026-03-21

Template test scaffolding, explicit stdio transport defaults, js-yaml v4 peer dep upgrade

## [0.1.20](changelog/0.1.x/0.1.20.md) — 2026-03-21

Template scaffolding improvements — dynamic framework version pinning, server.json manifest, slimmed gitignore focused on TypeScript/Node.js

## [0.1.19](changelog/0.1.x/0.1.19.md) — 2026-03-21

Devcheck config externalization, field-test skill reference, template guidance additions, MCP_SESSION_MODE docs

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-03-21

Devcheck output visibility improvements, expanded template .gitignore, added VS Code config to scaffolded projects

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-03-21

Three bug fixes for HTTP duplicate registration, stale tsbuildinfo cleanup, and missing tsconfig.build.json in scaffold

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-03-21

Security patch for flatted prototype pollution CVE-2026-33228, rebranded framework description, condensed agent protocol in CLAUDE.md

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-03-21

MCP definition linter at startup, standalone lint:mcp script, runtime-agnostic devcheck, npm-first templates

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-03-21

Skill documentation overhaul — maintenance, migration, polish, and release skills updated with expanded guidance and examples, msw bumped

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-03-20

Test suite reorganization into unit, integration, compliance, smoke, and helpers tiers — vitest config updated, helper files consolidated

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-03-20 · ⚠️ Breaking

Required output schemas, OAuth algorithm pinning, resource metric cardinality fix

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-03-20

Security hardening across auth, sessions, and error data — HMAC cursors, auth-gated metadata, JWT issuer/audience validation, public API barrel, zod promoted to direct dependency

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-03-20

Security hardening — prevent HTTP error data leaks, drop raw token from AuthContext, concurrency-safe config overrides, cancellation in ContextState and LLM provider

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-03-20

Markdown linting and formatting compliance — markdownlint config, 14 skill/doc fixes, labeled code blocks, biome schema bump

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-03-20

Tool output validation, HTTP graceful shutdown hardening, add-test and polish-docs-meta skills, design-mcp-server v2 rewrite

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-03-17

Telemetry slim-down — focused MCP attribute keys replace semconv, lighter OTel instrumentation, removed per-call memory profiling and unused metric exports

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-03-16

Task manager lifecycle fix, error metadata on responses, resource output validation, HTTP tenant isolation hardening, config override timing

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-03-14

Security hardening and task tool auth fixes — scope enumeration prevention, ALS context capture for background handlers, structuredContent gating, HTTP session header correction

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-03-14

Rebrand from mcp-ts-template to mcp-ts-core — Dockerfile labels, package metadata, repository URLs, and smithery command updated throughout

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-03-14

Housekeeping release — regex fix for skill audience extraction, version alignment, removal of obsolete planning docs and schemas

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-03-14

Reliability fixes for lifecycle, transport, storage, and telemetry — new design-mcp-server skill, onboarding improvements in consumer templates

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-03-14

Scaffold and build portability — Node-portable build script, shared config extensions for tsconfig/biome/vitest, template overhaul, init CLI improvements

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-14

Initial stable pre-release — builder API for tools/resources/prompts, unified Context, createApp lifecycle, Cloudflare Workers support, 25+ subpath exports
