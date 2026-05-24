---
name: setup
description: >
  Post-init orientation for an MCP server built on @cyanheads/mcp-ts-core. Use after running `@cyanheads/mcp-ts-core init` to understand the project structure, conventions, and skill sync model. Also use when onboarding to an existing project for the first time.
metadata:
  author: cyanheads
  version: "1.7"
  audience: external
  type: workflow
---

## Context

This skill assumes `bunx @cyanheads/mcp-ts-core init [name]` has already run. The CLI created the project's `CLAUDE.md` and `AGENTS.md` for different agents, copied external skills to `skills/`, and scaffolded the directory structure with echo definitions as starting points. This skill covers what was created and what to do next.

## Agent Protocol File

The init CLI generates both `CLAUDE.md` and `AGENTS.md` with the same purpose. Keep one authoritative file for the agent you actually use:

- **Claude Code** — keep `CLAUDE.md`, delete `AGENTS.md`
- **All other agents** (Codex, Cursor, Windsurf, etc.) — keep `AGENTS.md`, delete `CLAUDE.md`

Both files serve the same purpose: project-specific agent instructions. Prefer committing one authoritative copy rather than trying to keep both in sync by hand.

For the full framework docs, read `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` once per session. It contains the exports catalog, tool/resource/prompt contracts, error codes, context API, and common import patterns.

## Project Structure

What `init` actually creates:

```text
CLAUDE.md                                       # Agent protocol — Claude Code
AGENTS.md                                       # Agent protocol — other agents (Codex, Cursor, etc.)
package.json                                    # Starter deps + scripts (placeholders substituted on init)
tsconfig.json                                   # TypeScript config
tsconfig.build.json                             # Build-only TS config
vitest.config.ts                                # Test runner config
biome.json                                      # Lint + format config
devcheck.config.json                            # Which devcheck steps to run
Dockerfile                                      # Starter multi-stage image
.dockerignore
.env.example                                    # Copy to .env and fill in
.gitignore
.github/ISSUE_TEMPLATE/                         # Bug / feature-request issue forms
.vscode/                                        # Recommended extensions + editor settings
server.json                                     # MCP Registry publishing metadata
changelog/template.md                           # Format reference for per-version changelog files
scripts/                                        # build, clean, devcheck, lint-mcp, list-skills, build-changelog, tree, check-docs-sync
skills/                                         # External skills copied from the package (source of truth)
src/
  index.ts                                      # createApp() entry point
  mcp-server/
    tools/definitions/
      echo.tool.ts                              # Standard tool starter
      echo-app.app-tool.ts                      # UI-enabled app tool starter (pairs with echo-app-ui resource)
    resources/definitions/
      echo.resource.ts                          # Standard resource starter
      echo-app-ui.app-resource.ts               # UI resource paired with echo-app app tool
    prompts/definitions/
      echo.prompt.ts                            # Prompt starter
tests/
  tools/echo.tool.test.ts                       # Starter tests (one per echo definition)
  resources/echo.resource.test.ts
  prompts/echo.prompt.test.ts
```

Add these as needed:

```text
src/
  worker.ts                                     # createWorkerHandler() — only for Cloudflare Workers
  config/
    server-config.ts                            # Server-specific env vars (own Zod schema)
  services/
    [domain]/
      [domain]-service.ts                       # Init/accessor pattern
      types.ts
```

## Scaffolded Echo Definitions

The init creates five echo definitions plus matching starter tests:

| File | Demonstrates |
|:--|:--|
| `echo.tool.ts` | Standard MCP tool: input/output Zod schemas, `handler`, `format` |
| `echo-app.app-tool.ts` | MCP App tool — same as a tool, but emits a UI (`ui_app://` link) for clients that render MCP Apps |
| `echo.resource.ts` | Standard MCP resource with a parameterised URI template |
| `echo-app-ui.app-resource.ts` | UI resource served to MCP App clients; paired with `echo-app.app-tool.ts` |
| `echo.prompt.ts` | Prompt template (pure message generator) |
| `tests/**/echo.*.test.ts` | Starter tests using `createMockContext` — edit alongside the definitions |

After init:

1. **Clean up what you don't need.** If your server has no prompts, delete the echo prompt and its registration in `src/index.ts`. Same for resources, or the app-tool pair if you're not targeting UI-capable clients.
2. **Rename and replace what you keep.** The echo definitions and their tests show the pattern — swap them out for your real tools/resources/prompts.
3. **Definitions register directly in `src/index.ts`.** The init scaffold uses direct imports — no barrel files yet. As the definition count grows, the `add-tool`/`add-resource`/`add-prompt` skills introduce `definitions/index.ts` barrels per the framework convention.

See the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt`, `add-service`, and `add-test` skills for the scaffolding patterns when you start adding real definitions.

## Conventions

| Convention | Rule |
|:-----------|:-----|
| File names | kebab-case |
| Tool/resource/prompt names | snake_case, prefixed with server name (e.g. `tasks_fetch_list`) |
| File suffixes | `.tool.ts`, `.resource.ts`, `.prompt.ts`, `.app-tool.ts` (UI-enabled), `.app-resource.ts` (paired UI resource) |
| Imports (framework) | `@cyanheads/mcp-ts-core` and subpaths |
| Imports (server code) | `@/` path alias for `src/` |

## Skill Sync

Copy all project skills into your agent's skill directory so they're available as context. `skills/` is the source of truth.

**Don't edit `skills/*/SKILL.md` or `skills/*/references/*`.** These are external skill files synced from `@cyanheads/mcp-ts-core` — the `maintenance` skill overwrites them on package updates, so local edits get lost. Project-specific agent context belongs in `CLAUDE.md` / `AGENTS.md`.

**For Claude Code:**

```bash
mkdir -p .claude/skills && cp -R skills/* .claude/skills/
```

**For other agents** (Codex, Cursor, Windsurf, etc.) — copy to the equivalent directory (e.g., `.codex/skills/`, `.cursor/skills/`).

This step is the **bootstrap** — it creates the agent directory. From then on, use the `maintenance` skill to refresh it after package updates (Phase B). Maintenance only refreshes directories that already exist; it won't create a new agent directory on your behalf.

## Project Scaffolding

Complete these one-time setup tasks:

1. **Install dependencies** — `bun install`
2. **Update dependencies to latest** — `bun update --latest`. The scaffolded `package.json` pins minimum versions from when the framework was published; updating ensures you start with the latest compatible releases.
3. **Initialize git** — use your git tools: init the repo, stage all files, and commit with message `chore: scaffold from @cyanheads/mcp-ts-core`
4. **Verify the substituted server name** — when `init` runs without a `[name]` argument, the package name defaults to the cwd directory name. If that's not what you want as the published server name, update `package.json`, `CLAUDE.md`/`AGENTS.md`, and `server.json` to your actual server name.
5. **Verify the scaffold builds clean** — `bun run devcheck`. Fix any issues before starting real work.

## Changelog Convention

`changelog/template.md` ships as a **format reference** — never edit, rename, or move it. For each release, author a per-version file at `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) with YAML frontmatter (`summary:` + optional `breaking:` / `security:`) and grouped sections (Added / Changed / Fixed / Removed). Then regenerate the rollup with `bun run changelog:build` — `CHANGELOG.md` is an auto-generated navigation index, never hand-edited. See the `release-and-publish` skill for the full release flow.

## Next Steps

The included skills form a rough progression — not a rigid sequence, but the typical flow through a new server:

1. **`design-mcp-server`** — map the domain into tools, resources, and services before writing any definitions
2. **`add-tool`** / **`add-app-tool`** / **`add-resource`** / **`add-prompt`** / **`add-service`** — scaffold each piece as you go
3. **`add-test`** — pair tests with each definition (or retrofit later)
4. **`field-test`** — exercise the built surface with real and adversarial inputs; produces a report of issues and pain points
5. **`security-pass`** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
6. **`polish-docs-meta`** — finalize README, metadata, and agent protocol before shipping
7. **`release-and-publish`** — post-wrapup ship workflow: verification gate, push commits and tags, publish to npm/MCP Registry/GHCR
8. **`maintenance`** — after `bun update --latest`, investigate upstream changelogs and re-sync skills

Skip or reorder as the project calls for it. The agent protocol's "What's Next?" section is the authoritative map once the first session is over.

## Checklist

- [ ] Agent protocol file selected — one authoritative file kept (`CLAUDE.md` or `AGENTS.md`), the other deleted
- [ ] `bun install` run
- [ ] Dependencies updated (`bun update --latest`)
- [ ] Git repo initialized and initial commit made (`chore: scaffold from @cyanheads/mcp-ts-core`)
- [ ] Substituted server name verified in `package.json`, agent protocol file, and `server.json`
- [ ] Framework docs read (`node_modules/@cyanheads/mcp-ts-core/CLAUDE.md`)
- [ ] Unused echo definitions cleaned up (and unregistered from `src/index.ts`)
- [ ] Skills copied to agent directory (`cp -R skills/* .claude/skills/` or equivalent)
- [ ] Project structure understood (definitions directories, entry point)
- [ ] `bun run devcheck` passes
- [ ] Next: if new server, move on to `design-mcp-server` to plan the tool surface
