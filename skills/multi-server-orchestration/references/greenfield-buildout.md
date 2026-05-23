---
name: greenfield-buildout
description: >
  Multi-server-orchestration reference for greenfield build-outs. Drives one or more freshly-scaffolded MCP servers through 13 phases: idea seed → design → critical review → setup + repo → first wrap-up (v0.1.0) → polish docs/meta → normalize → optional design extensions → interim wrap-up → build → finish → simplify → final wrap-up. Each phase is a parallel sub-agent fanout (one agent per target) with Bash git for all commit/tag/push steps.
metadata:
  author: cyanheads
  version: "1.1"
  audience: internal
  type: reference
---

# Greenfield Build-Out — Multi-Server Orchestration

Use after reading `../SKILL.md`. This reference handles the full lifecycle for one or more freshly-scaffolded MCP servers — from idea seed through implementation to first published release.

## When applicable

- One or more new servers from `bunx @cyanheads/mcp-ts-core init <name>` need to be driven through design → build → ship
- N = 1 works too; the parallelism is optional, the phase pattern is the value
- Each target should be a freshly-scaffolded project with no implementation yet (only the framework's echo definitions)

## Pre-flight (orchestrator)

Before spawning any sub-agents:

1. **Confirm the target list with the user.** Capture absolute paths and the intended GitHub owner/org for each.
2. **Name the gold-standard references** the polish phase will anchor on — concrete repos whose README, `server.json`, badges, and agent-protocol shape are the target. Name them explicitly in the relevant fanout prompts; don't let agents pick. Examples from the `@cyanheads/*` ecosystem:
   - **Docs/README/metadata** → `pubmed-mcp-server`
   - **Tabular API + DataCanvas/dataframe surface** → `secedgar-mcp-server`

   External projects pick analogous anchors from their own ecosystem; skip the phase if no suitable anchor exists.
3. **Verify each target has `scripts/list-skills.ts` and the `list-skills` package script.** Both ship via `init`; older projects pick them up on the next `maintenance` sync (Phase C).
4. **Confirm GH credentials** (`gh auth status`). Repo creation in Phase 4 requires this.
5. **Surface the plan** — scenario, target list, phase summary, gotchas — and get authorization before kicking off Phase 1.

## Phase pattern

| # | Phase | Mode | Inputs | Outputs |
|:--|:------|:-----|:-------|:--------|
| 1 | Seed | orchestrator | Server idea, domain | `docs/idea.md` per target |
| 2 | Design | fanout | `docs/idea.md` + `design-mcp-server` skill | `docs/design.md` per target |
| 3 | Critical review | fanout | `docs/design.md` + skill | Hardened `docs/design.md` per target |
| 4 | Setup + repo | fanout | `setup` skill + GH credentials | Private GH repo, framework scaffolds applied, working tree unstaged |
| 5 | First wrap-up (v0.1.0) | fanout, Bash git only | Working tree from Phase 4 | Commit + annotated `v0.1.0` tag + push, after user authorizes |
| 6 | Polish docs/meta | fanout | `polish-docs-meta` skill + named gold-standard repo | Updated README, server.json, package.json, agent protocol per target |
| 7 | Normalize | orchestrator (or narrow fanout) | Phase 6 outputs | Consistent naming/scripts/badges across targets |
| 8 | Design extensions (opt) | fanout | New design pattern (e.g., `api-canvas`) | Extended `docs/design.md` per applicable target |
| 9 | Commit/push extensions | fanout, Bash git only | Phases 6–8 outputs | Commits + pushes, after user authorizes |
| 10 | Build | fanout | `docs/design.md` | Full implementation + unit tests + green devcheck |
| 11 | Finish (narrow scope) | fanout | Phase 10 partial state | Remaining errors fixed, missing tests written, echo removed, green devcheck |
| 12 | Simplify | fanout | `code-simplifier` skill | Cleanups applied; green devcheck |
| 13 | Final wrap-up (v0.1.x+1) | fanout, Bash git only | Phases 10–12 outputs | Final commit + annotated tag + push, after user authorizes |

Skip phases that don't apply. Phase 8 only fires when a subset of targets fits a new design pattern. Phase 9 only runs if Phase 6–8 produced doc changes the build should start from.

## Scenario-specific hard rule

In addition to the universal hard rules in `../SKILL.md`:

> **Repo must be private before any push** (or user must explicitly authorize public). Phase 5/9/13 sub-agents confirm `gh repo view --json visibility` returns `PRIVATE` (or have user authorization noted) before pushing.

## Phase details

### Phase 1: Seed (orchestrator)

Write a small `docs/idea.md` per target before involving sub-agents. Structure: **Domain → Data source → User goals → Tool sketch → Pairs with → Open questions**. Keep it to a page or less — this is the seed the design skill expands.

Skip if the user already has a clear, written brief per target. The point is to give the design fanout a concrete starting point so each agent doesn't redo discovery.

### Phase 2: Design (fanout)

One sub-agent per target. Each agent reads its `docs/idea.md`, reads `design-mcp-server`, probes the upstream API if there is one, and writes `docs/design.md`.

**Decisions Log convention.** End the design doc with a "Decisions Log" section recording answered open questions and options declined, with one-line reasoning each. This becomes the audit trail for non-obvious choices and feeds Phase 3 (the reviewer can verify the rationale held up). Preserve it as a default.

**Task body (after the orient block):**

> Read `docs/idea.md` and the `design-mcp-server` skill. Probe the upstream API if applicable. Write `docs/design.md` following the skill's template. For open questions, default to current modern practices and record the question + your answer (or the option you declined + why) in a Decisions Log section at the bottom. Do not commit.

### Phase 3: Critical review (fanout)

Fresh sub-agent per target — different conversation, different context. The design author has confirmation bias on its own choices; a second agent reading cold spots what the first justified away.

Each agent re-reads `docs/design.md`, re-reads `design-mcp-server`, then surgically tightens: closes gaps, kills bad assumptions, adds material that's missing. Output is an updated `docs/design.md` + a short list of what changed and why.

### Phase 4: Setup + repo (fanout)

One sub-agent per target. The agent reads the `setup` skill and runs it: agent-protocol file selection, framework docs read, echo cleanup, skill sync to `.claude/skills/`. Then `git init -b main`, `gh repo create` private with description and topics derived from `docs/design.md`, but **no commits**.

The `setup` skill's checklist says to commit `chore: scaffold from @cyanheads/mcp-ts-core`. The orchestrator overrides this at the prompt level:

> Do NOT `git add`, `git commit`, or `git push` after running the setup skill. Leave the working tree unstaged for review.

### Phase 5: First wrap-up — v0.1.0 (fanout, Bash git only)

Run only after the user explicitly authorizes commits.

One sub-agent per target. Each agent:

1. Confirms `gh repo view --json visibility` returns `PRIVATE` (or has noted authorization for public).
2. Regenerates: `bun run tree`, authors `changelog/0.1.x/0.1.0.md` with YAML frontmatter, runs `bun run changelog:build`. Version-bumps any files that fell out of sync.
3. Stages and commits with a conventional-commits subject (e.g., `feat: 0.1.0 — initial scaffold` or `chore(release): v0.1.0 — initial scaffold`).
4. Creates an **annotated** tag `v0.1.0` (`-a`, not lightweight) with a terse message.
5. Pushes commits and tags to origin.

All git calls use Bash, not git-mcp-server. Final report: commit SHA + tag name.

### Phase 6: Polish docs/meta (fanout)

One sub-agent per target. Each agent reads:
- Its `docs/design.md`
- The `polish-docs-meta` skill and its references
- The **gold-standard repo** named in pre-flight, locally

The agent updates README, `server.json`, `package.json` (sponsor links, keywords, scope), Dockerfile, and the chosen agent protocol file to match the gold-standard pattern. Name the gold-standard reference explicitly in the prompt; don't let the agent pick.

### Phase 7: Normalize (orchestrator or narrow fanout)

After Phase 6, parallel agents will have diverged on incidental choices. Common axes:

- Package name scoping (`@scope/name` vs. bare `name`)
- Script invocation form (`bun run` vs. `bunx` vs. `tsx`)
- Docker block in README (present vs. absent)
- Badge set, hero title format
- Keywords list shape

Decide the canonical choice once, then either fix each project yourself (orchestrator) or spawn a narrow fanout with an explicit rule list. Orchestrator-driven is faster when the fixes are small; fanout is faster when N is large and the fix-per-target is non-trivial.

### Phase 8: Design extensions (optional fanout)

Some servers fit additional design patterns the base design didn't include. Example: tabular API servers (tools that page large row sets) benefit from `DataCanvas` / dataframe-surface tools — documented in `api-canvas`, exemplified by `secedgar-mcp-server`.

If a subset of targets fits a pattern, spawn a fanout only for that subset. Each agent reads the relevant skill (`api-canvas`), the gold-standard reference (`secedgar-mcp-server`), and its own `docs/design.md`, then extends the design with the new pattern. This phase produces updated `docs/design.md`, not code.

### Phase 9: Commit/push extensions (fanout, Bash git only)

If Phases 6–8 produced doc/meta changes that should land before the build phase begins, run a small wrap-up fanout. Conventional commit, no version bump (still pre-build), Bash git only. Runs only after user authorizes.

### Phase 10: Build (fanout)

The big one. One sub-agent per target builds the full implementation from `docs/design.md`: services, tool definitions, resources, prompts, config, server registration, unit tests for each tool, end-to-end devcheck.

**Critical prompt directives:**

- "Plan carefully before acting. Think the design through end-to-end before writing files."
- "Run `bun run devcheck` often to verify your work as you go."
- "No write `git` commands: no `commit`, `push`, `add`, `tag`, `reset`, `restore`, `checkout --`, `clean`, `stash`. Read-only git is allowed — `status`, `diff`, `log` are useful for tracking your own changes."
- "NEVER `git stash` for any reason. NEVER `git reset --hard`, `git restore .`, `git clean -f`, or `git checkout -- .` — these violate the global protocol."
- "Do NOT run `field-test`. That's reserved for the user's manual verification later."
- Orient block — non-negotiable.

**Expect context exhaustion on the largest targets.** The agent's work persists to disk even if its session dies, but the agent itself can't continue. Plan Phase 11 as the backstop — not a fallback for failure, a normal next phase.

### Phase 11: Finish — narrow-scope fanout

After Phase 10, some targets will be incomplete (last few tools missing tests, lingering TS errors, echo definitions not removed, devcheck not yet green). Spawn a narrow fanout — one sub-agent per incomplete target with a concrete punch list.

**Punch list format in the prompt:**

> Current state: X tools implemented of Y, Z TS errors in `bun run devcheck`, echo definitions still present in `src/mcp-server/tools/definitions/echo.tool.ts`.
>
> Your job:
> 1. Fix the TS errors. Run `bun run devcheck` after each fix.
> 2. Write tests for tools A, B, C using the pattern in `tests/tools/<existing>.tool.test.ts`.
> 3. Delete echo definitions and their registrations in `src/index.ts`.
> 4. Confirm green `bun run devcheck` and `bun run test`.

Each finish agent is narrow in scope — one or two problem classes, not a generic "finish it" prompt. Narrow scope is the antidote to context exhaustion.

### Phase 12: Simplify (fanout)

One sub-agent per target reads the `code-simplifier` skill, then audits the codebase against its principles: cut unnecessary abstractions, remove dead code, replace verbose patterns with idioms, etc. Output: list of changes applied + green devcheck.

No commits in this phase.

### Phase 13: Final wrap-up (fanout, Bash git only)

Run only after the user authorizes. Same shape as Phase 5: per-target sub-agent invokes `git_wrapup_instructions` advice (via Bash git), authors `changelog/0.1.x/<version>.md`, regenerates `CHANGELOG.md` and `docs/tree.md`, version-bumps `package.json` and `server.json`, commits with a conventional subject, creates an annotated tag, pushes.

Version bumps live with the change that warrants them per the global protocol's git rules — don't manufacture extra commits.

## Gotchas specific to greenfield build-out

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | Zod 4 signature change — `z.record(z.string())` no longer valid; must be `z.record(z.string(), z.string())` | Caught by devcheck; mention as a hint in build-phase prompts so agents don't burn cycles rediscovering it |
| 2 | `exactOptionalPropertyTypes` mismatch — Zod-inferred types have `T \| undefined` for optional fields, project domain types may have truly optional | Introduce a mapped widening type at the boundary where they meet; agent will hit this in devcheck |
| 3 | `format()` ↔ `structuredContent` parity — different MCP clients forward different surfaces (Claude Code reads `structuredContent`, Claude Desktop reads `content[]`) | Build prompts cite the design-mcp-server rule; tests assert both surfaces carry equivalent data |
| 4 | `setup` skill's checklist tells the agent to commit; orchestrator overrides this | Restate the no-commit constraint in the Phase 4 prompt body verbatim |
| 5 | `init` defaults package name to the cwd; if the project was scaffolded inside an outer dir, the name is wrong | Verify in Phase 4 prompt: "Check the substituted package name in `package.json`, `server.json`, and the agent protocol matches the intended server name." |
| 6 | Sub-agent creates GH repo public by default if `gh repo create` omits `--private` | Restate the scenario hard rule in every fanout that touches `gh`: "Repo must be private before any push." |
| 7 | Wrap-up agents have been observed reporting "pushed" while the remote ref didn't actually land — the push only succeeded on a subsequent op | Verify after every Bash-git fanout: `git ls-remote --tags origin` and `gh repo view --json defaultBranchRef` per target |

## Checklist

The orchestrator's checklist for a full N-target greenfield build:

- [ ] Target list confirmed, GitHub owners/orgs noted, gold-standard references named
- [ ] `scripts/list-skills.ts` and the `list-skills` package script present in each target
- [ ] `gh auth status` passes for the orchestrator session
- [ ] **User authorization captured for commit-bearing phases**
- [ ] Phase 1 — `docs/idea.md` authored per target
- [ ] Phase 2 — design fanout — `docs/design.md` with Decisions Log per target
- [ ] Phase 3 — critical review fanout — `docs/design.md` hardened per target
- [ ] Phase 4 — setup + repo fanout — repos created private, working tree unstaged, no commits
- [ ] Phase 5 — v0.1.0 wrap-up fanout (Bash git only) — commits + annotated tags + pushes; verified via `git log` and `git ls-remote --tags origin`
- [ ] Phase 6 — polish docs/meta fanout against named gold-standard
- [ ] Phase 7 — normalization — divergent conventions aligned
- [ ] **If extension applicable:** Phase 8 — design extension fanout (e.g., DataCanvas for tabular servers)
- [ ] **If Phases 6–8 produced doc changes the build should start from:** Phase 9 — interim wrap-up fanout (Bash git only) after user authorizes
- [ ] Phase 10 — build fanout — implementation + tests + green devcheck per target
- [ ] **If any Phase 10 agent didn't finish:** Phase 11 — narrow-scope finish fanout per incomplete target
- [ ] Phase 12 — simplify fanout — `code-simplifier` pass per target
- [ ] All targets: green `bun run devcheck` and `bun run test`
- [ ] Phase 13 — final wrap-up fanout (Bash git only) — version bump, changelog file, regenerated rollup, commit + annotated tag + push; verified
- [ ] Final read-only verification: tags pushed, repos still private, no stray uncommitted work
