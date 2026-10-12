# Threat model: @cyanheads/mcp-ts-core

Notes for an automated security audit. `CLAUDE.md` at the repository root is the full developer reference; `.github/SECURITY.md` is the disclosure policy.

## What this project does and where untrusted input enters

mcp-ts-core is a TypeScript framework for building Model Context Protocol (MCP) servers, published to npm as `@cyanheads/mcp-ts-core`. A server author writes tool, resource, and prompt definitions (Zod schemas plus handler functions) and calls `createApp()` (Bun or Node 24+) or `createWorkerHandler()` (Cloudflare Workers). The framework owns everything between the wire and the handler: transports, authentication, sessions, argument validation, error envelopes, logging, tenant-scoped storage, and optional subsystems (DataCanvas SQL workspace, MirrorService, parsers, fetch helpers).

**Trusted:** the server author's definitions, handler code, `createApp()` options, and environment variables. **Untrusted:**

1. **Everything on the HTTP transport** (`src/mcp-server/transports/http/`): method, path, headers (`Origin`, `Host`, `Authorization`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Last-Event-ID`, `Mcp-Param-*`), and the JSON-RPC body. The defaults are `MCP_HTTP_HOST=127.0.0.1` and `MCP_AUTH_MODE=none`, so the client is anonymous. The Docker images this repository and its scaffold template ship run `MCP_TRANSPORT_TYPE=http`, `MCP_HTTP_HOST=0.0.0.0`, `MCP_SESSION_MODE=stateless`; treat that as the exposed configuration.
2. **Tool, resource, and prompt arguments on every transport, stdio included.** The MCP client is usually an LLM agent that may be acting on prompt-injected content, so arguments are attacker-chosen even when the client process is local. Covers argument handling (`src/mcp-server/tools/utils/arguments/`: `prevalidation.ts` drops client-added root keys (`_meta`, `toolCallId`, `tool_call_description`, undeclared `_`-prefixed keys) and rewrites aliases, `repair.ts` repairs value representations and re-parses after a failed Zod parse, `rejection.ts` and `bounds.ts` build the bounded rejection), `toolHandlerFactory.ts` and `toolResult.ts`, resource URIs and the template variables the SDK extracts from them (`src/mcp-server/resources/`, `resources/subscribe` included), list cursors (`src/utils/pagination/`), prompt arguments, and completion requests.
3. **Multi-round-trip input** (`src/mcp-server/inputRequired.ts`, `src/core/context.ts`): echoed `requestState`, and elicitation, sampling, and roots responses, including replays of an earlier `requestState` and responses the client's declared capabilities do not cover.
4. **Bearer tokens** under `MCP_AUTH_MODE=jwt` (HS256 with `MCP_AUTH_SECRET_KEY`) and `oauth` (remote JWKS; RS256/ES256/PS256; issuer and audience required): `src/mcp-server/transports/auth/`.
5. **SQL text sent to the DataCanvas** (`src/services/canvas/`). Servers pass caller-written SQL to `query()` and `registerView()` on the `CanvasInstance` that `DataCanvas.acquire()` returns. The read-only gate in `core/sqlGate.ts` (function deny-list, single statement, `SELECT` only, a parse-tree check against DuckDB's own `json_serialize_sql`, `EXPLAIN` plan-walk allowlist) screens that SQL before it reaches an in-process DuckDB instance. The instance runs with extension auto-install/auto-load off, `enable_external_access=false`, `allowed_directories` limited to the export root and a private scratch directory, and `lock_configuration=true`.
6. **Upstream data and caller-supplied URLs:** responses that handlers feed through `src/utils/parsing/` (XML, YAML, CSV, HTML, PDF, JSON, frontmatter), `src/utils/security/sanitization.ts`, and `src/utils/network/` (`fetchWithTimeout` with `rejectPrivateIPs: true` is the SSRF guard for user-controlled URLs, covering DNS resolution and redirects).
7. **FTS5 `match` expressions and filter values** passed to MirrorService (`src/services/mirror/`).

## Components that matter most / least

| Priority | Path | Look for |
| --- | --- | --- |
| 1 | `src/mcp-server/transports/http/` (`httpTransport.ts`, `sessionStore.ts`, `eventStore.ts`), `src/mcp-server/transports/auth/` | Origin guard bypass (loopback-only by default), body-cap bypass (1 MiB default), session use across identities, token or scope check bypass, SSE replay of another session's events |
| 1 | `src/mcp-server/tools/utils/`, `src/mcp-server/resources/`, `src/mcp-server/prompts/` | Arguments reaching the handler unvalidated or altered, prototype pollution, unbounded CPU or output from a rejection, internal state in error envelopes |
| 1 | `src/services/canvas/` (`core/sqlGate.ts`, `providers/duckdb/`) | Gate bypass that reads host files, reaches the network, loads an extension, runs DDL/DML or a utility statement, or reads another canvas; export path escape (`exportWriter.ts`) |
| 1 | `src/storage/` (`core/storageValidation.ts`, `core/StorageService.ts`, `providers/fileSystem/`) | Cross-tenant reads or writes, path traversal, cursor forgery |
| 2 | `src/core/context.ts`, `src/mcp-server/inputRequired.ts` | Forging a sealed `requestState` (`MCP_REQUEST_STATE_KEY`), crossing a consent gate with a pre-answered or replayed response |
| 2 | `src/utils/network/`, `src/utils/internal/error-handler/`, `src/utils/security/`, logging | SSRF guard bypass, secrets/stack traces/host paths reaching a client or log line past the redaction walk |
| 2 | `src/core/worker.ts` | State shared across requests in a Worker isolate, env binding injection |
| 2 | `src/utils/parsing/`, `src/services/mirror/` | Unbounded input, code evaluation (YAML tags, XML entities), FTS5 syntax that escapes the query |
| 2 | `src/mcp-server/transports/http/landing-page/`, `serverCard.ts`, `protectedResourceMetadata.ts`, `src/mcp-server/apps/` | `Host` or other request-derived values reflected into HTML or metadata, missing escaping, app `ui://` resource CSP |
| 3 | `templates/` | Copied into every server scaffolded by `bunx @cyanheads/mcp-ts-core init`, so a vulnerable pattern here propagates into third-party code |
| out | `src/linter/`, `src/cli/`, `src/testing/`, `scripts/`, `tests/`, `examples/`, `docs/`, `framework-skills/`, `changelog/` | Development-time code with trusted input |

Advisories in dependencies (MCP SDK, Hono, jose, DuckDB, Zod, pino) are out of scope unless mcp-ts-core's own code makes them reachable or skips a mitigation the dependency documents.

## How to exercise it

- The image is `oven/bun:1.4.3` (Debian 13, the production base) with the Node 24 binary added, plus curl, jq, git, and a C++ toolchain; dependencies are installed and the build is in `/src/dist`. npm is not installed.
- `bun run test` runs the unit, leak-gate, compliance, smoke, contract, fuzz, and typecheck Vitest projects on Bun; `bun run test:unit` (or `:smoke`, `:fuzz`, …) runs one, and `bun run test:unit <file>` runs one file on Bun. `bunx vitest run <file>` runs it on Node, since the image has a real `node`.
- `bun run test:integration` starts real servers over stdio and loopback HTTP from the built `dist/` and refuses a stale one, so run `bun run build` after editing `src/`. `bun run test:node` runs the suites under real Node; `bun run test:worker` runs the Worker entry under real `workerd`.
- Offline gaps: `bun run test:package` installs from the npm registry, and `tests/integration/mcp-apps-render.int.test.ts` needs a `chrome-headless-shell` build the image does not include, so that suite fails rather than skips.
- Tests named "in time linear in …" or "at about the cost of the parse" compare thread-CPU costs across input sizes. A failure that reproduces when the test is re-run alone (`bun run test:unit <file> -t '<name>'`) is a real super-linear cost.
- A runnable server: `examples/index.ts` wires the example definitions in `examples/mcp-server/`. Start it with `MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun examples/index.ts` and send JSON-RPC to `http://127.0.0.1:3010/mcp` (an `initialize` request first, with `Accept: application/json, text/event-stream`). It declares `sessionMode: { require: 'stateful' }` and refuses to start under `MCP_SESSION_MODE=stateless`; for the stateless configuration, `MCP_SESSION_MODE=stateless bun run start:http` serves the same transport with no definitions.
- Configuration that changes the attack surface: `MCP_AUTH_MODE`, `MCP_ALLOWED_ORIGINS`, `MCP_SESSION_MODE`, `MCP_HTTP_MAX_BODY_BYTES`, `MCP_REQUEST_STATE_KEY`, `STORAGE_PROVIDER_TYPE`, `CANVAS_PROVIDER_TYPE=duckdb`. The config schema in `src/config/index.ts` defines every variable and its default.

## How severity is rated

Rate HTTP findings against the exposed configuration in item 1 above and everything else against the defaults, unless the finding names another configuration.

- **Critical:** code execution in the server process from a request or tool argument; authentication bypass under `jwt` or `oauth` (an unsigned, forged, or expired token accepted, a wrong issuer or audience accepted where one is checked — always under `oauth`, under `jwt` only with `MCP_JWT_EXPECTED_ISSUER` / `MCP_JWT_EXPECTED_AUDIENCE` set — a scope check skipped); cross-tenant `ctx.state` or DataCanvas reads or writes under `jwt` or `oauth`; a DataCanvas gate escape that reads host files, reaches the network, loads an extension, or writes; forging a sealed `requestState`.
- **High:** a single unauthenticated request (or a small fixed number) that crashes the process (an unhandled rejection exits it), exhausts memory or CPU, or amplifies into a very large response or log record; using another identity's session; path traversal in filesystem storage or canvas export; Origin guard bypass under the default loopback policy; SSRF guard bypass in `fetchWithTimeout`; prototype pollution from arguments.
- **Medium:** secrets, stack traces, host paths, or another request's data reaching a client, a log line, or a third party; DataCanvas resource exhaustion that needs a valid canvas token; a request-derived value reflected into the landing page, server card, or protected-resource metadata; crossing a consent gate with a replayed or unsolicited response.
- **Low:** issues that need a documented opt-out (`MCP_ALLOWED_ORIGINS='*'`, `MCP_AUTH_DISABLE_SCOPE_CHECKS=true`, `MCP_HTTP_MAX_BODY_BYTES=0`, `DEV_MCP_AUTH_BYPASS=true`, which config parsing rejects under `NODE_ENV=production`); information leaks and hardening gaps with no demonstrated impact.

## Anything to leave alone

- **No authentication under `MCP_AUTH_MODE=none` is by design.** That mode is single-tenant: every caller is tenant `default`. What the framework owes there is the Origin guard, the body cap, and safe argument handling. Report failures of those, not the absence of auth.
- **A DataCanvas `canvasId` is a bearer capability.** Holding one grants full access to that canvas, across users in a single-tenant deployment.
- A server author passing caller input into an unsafe sink in their own handler. Report a framework helper only when it is documented as safe for that input and is not.
- Volumetric DoS from many requests (deployments rate-limit at a proxy). Single-request, asymmetric DoS is in scope.
- The stdio client process is trusted (it can already kill the server); its tool arguments are not.
- Concurrent replay of a consent-gate record before it is deleted: a documented limitation until storage gains an atomic take (issue #593).
- DNS rebinding between `rejectPrivateIPs`' validation lookup and `fetch`'s own resolution: documented as best-effort in `fetchWithTimeout.ts`, which does not pin the validated address. A bypass that needs no rebinding is in scope.

## How reports should look

- One report per root cause; group call sites that share a fix.
- Reproducer: a failing Vitest test under `tests/` (preferred; `createMockContext` and `runToolContract` from `src/testing/` drive handlers directly), or a script plus requests against the example server. State the environment variables it needs and the transport and runtime it reproduces on (stdio, HTTP stateful, HTTP stateless, Workers; Bun or Node).
- Patch: minimal, against `src/` (and `templates/` when the pattern ships there), with a regression test, after `bun run test` passes.
- Fixes land on the latest release only; there are no backport branches.
