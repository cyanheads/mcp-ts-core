---
name: release-pass
description: >
  Multi-server-orchestration reference for release passes. Drives parallel verification → README polish → wrap-up (version bump, changelog, commit, annotated tag — local only, Bash git emulating git_wrapup_instructions) → publish (push + npm + MCP Registry + GHCR via the release-and-publish skill) → optional GH issue closure across N MCP server projects. Phase 5 runs serial when npm 2FA prompts interactively; parallel when bypass is configured.
metadata:
  author: cyanheads
  version: "1.0"
  audience: external
  type: reference
---

# Release Pass — Multi-Server Orchestration

Use after reading `../SKILL.md`. This reference handles parallel release work across N MCP server projects — verification gate → README polish → git wrapup (version bump, changelog, commit, annotated tag — local only) → publish (push + npm + MCP Registry + GHCR via the `release-and-publish` skill) → optional GH issue closure.

## When applicable

- One or more MCP servers built on `@cyanheads/mcp-ts-core` have committed/staged work that needs to ship as a new version
- Common follow-on to a `maintenance-pass` run where adopted changes need to ship as a patch
- Works for any version bump scope (patch / minor / major), per target

This reference assumes the change to ship is already done — it's the "ship the work" phase, not the "do the work" phase. If targets still need code changes, run those phases first (greenfield build, maintenance, etc.).

## Pre-flight (orchestrator)

Before spawning any sub-agents:

1. **Confirm the target list with the user.** Capture absolute paths and the intended version bump per target (`patch` / `minor` / `major`, or an explicit version string). Mixed bumps across targets are fine.
2. **Confirm the change shape per target.** What changed since the last release? This drives the conventional-commit subject, the per-version changelog body, and the annotated tag message. For a patch bump with a single concern, one or two lines per target is enough.
3. **Confirm npm 2FA setup.** Parallel `bun publish` calls don't play nicely with interactive 2FA — OTP prompts from multiple sub-agents interleave and fail. Either:
   - **Bypass configured** — granular access token with "Bypass 2FA for publish" in `~/.npmrc` → Phase 5 can run as a parallel fanout
   - **Not configured** — Phase 5 runs serially, orchestrator-driven, target by target
   - **No npm publish involved** — non-issue
4. **Capture the GH issue map (optional).** Per target: any issue numbers that this release closes or comments on, plus the intent (close vs. comment-only). Skip if no issues apply.
5. **Surface the plan and get explicit authorization.** Scenario, target list, version bump per target, 2FA mode for Phase 5, issue map, gotchas in play. Phase 5 is irreversible — no implicit authorization.

## Single-target vs. multi-target

The user's typical single-target release flow runs in their own session via `git_set_working_dir` + `git_wrapup_instructions` from `git-mcp-server`. This reference translates that into the multi-target parallel pattern:

| Single-target (orchestrator session) | Multi-target (parallel sub-agents) |
|:-------------------------------------|:-----------------------------------|
| `git_set_working_dir` once | Each sub-agent uses absolute paths with Bash `git` (no session state) |
| `git_wrapup_instructions` returns playbook + diagnostics | Phase 4 sub-agent prompt enumerates the same steps directly |
| Orchestrator executes steps in one session | One sub-agent per target executes steps in parallel |
| `release-and-publish` runs in the same session | Phase 5 sub-agents run the skill end-to-end per target |

The orchestrator may still call `git_wrapup_instructions` *serially* against each target during pre-flight to inspect state — that's read-only, no state leak. The constraint is on parallel sub-agents.

## Phase pattern

| # | Phase | Mode | Inputs | Outputs |
|:--|:------|:-----|:-------|:--------|
| 1 | Pre-flight | orchestrator | Target list, bump intent, 2FA mode, issue map | Verified plan, user authorization |
| 2 | Verification fanout | fanout | Existing target state | Per-target: green `bun run devcheck` + `bun run test:all` (or `test`) |
| 3 | README review fanout | fanout | Current README + change shape | Per-target: README updates folded in (no commits) |
| 4 | Wrap-up fanout | fanout, Bash git only | Phase 3 outputs + version bump intent | Per-target: version bumped everywhere, per-version changelog authored, rollup regenerated, commit + annotated tag — **LOCAL ONLY, no push** |
| 5 | Release publish | fanout OR serial | Phase 4 outputs | Per-target: tags+commits pushed, npm publish, MCP Registry publish, Docker push — via `release-and-publish` |
| 6 | (Optional) Issue closure fanout | fanout | Phase 5 outputs + issue map | Per-target: relevant GH issues commented and closed |

## Phase details

### Phase 2: Verification fanout

One sub-agent per target. Quick verification gate before any version bump or wrapup.

**Task body (after the orient block):**

> Run `bun run devcheck`. Then run `bun run test:all` if it exists in `package.json` scripts, otherwise `bun run test`. Both must pass green. Halt and report the failing step's verbatim output if anything fails — do not attempt fixes from inside this phase.

Any red target halts the orchestration. The user fixes locally and re-invokes from Phase 2.

### Phase 3: README review fanout

One sub-agent per target reads the full README plus key adjacent docs, identifies stale or missing content (feature counts, version badges, surface tables, configuration sections, dep version mentions), and folds updates in. No commits — Phase 4 stages everything together.

**Task body:**

> Read `README.md` from front to back. Identify content stale relative to the current code: tool/resource counts, version badges, feature lists, configuration tables, version mentions in install snippets. Fold updates in naturally — don't rewrite sections that are already accurate. Do NOT commit. Leave changes in the working tree for the next phase.
>
> If `polish-docs-meta` skill is available and the change spans more than just the README (e.g., new env vars, new tools), invoke that skill instead — it handles README plus `server.json`, `package.json`, agent protocol, and `.env.example` in one pass.
>
> If the README is already accurate, report "no changes needed" and exit cleanly.

For a small patch bump, this phase is often a no-op. That's fine.

### Phase 4: Wrap-up fanout (Bash git only)

Run only after user authorizes commits.

One sub-agent per target. The agent executes the wrapup steps via Bash git — the same workflow `git_wrapup_instructions` walks through, but per-target absolute paths instead of session state.

**Task body:**

> Run the version-bump wrapup via Bash `git` (no `git-mcp-server` tools — see the orchestration skill's Hard Rule 1).
>
> 1. **Inspect state:** `git status`, `git log --oneline -5`, `git diff --stat` on the working tree.
> 2. **Determine the new version:** start from the current `package.json` `version`, apply the bump intent (`[patch/minor/major or explicit string]`). For a patch, e.g., `0.1.1 → 0.1.2`.
> 3. **Author the changelog:** create `changelog/<major.minor>.x/<version>.md` per the directory-based convention. YAML frontmatter (`summary:` required, ≤350 chars, no markdown; `breaking:` and `security:` optional, default false). Grouped sections: Added / Changed / Fixed / Removed. Use the format reference at `changelog/template.md` — never edit, rename, or move that file.
> 4. **Regenerate:** `bun run changelog:build` (rebuilds `CHANGELOG.md` rollup) and `bun run tree` (regenerates `docs/tree.md`).
> 5. **Bump every version-bearing file:** `package.json` `version`, `server.json` `version` at the top level AND every `packages[].version` entry, any README badge that references the version. Use `grep -rn "<current-version>"` to find any you missed; resolve case by case.
> 6. **Stage and commit.** Conventional Commits subject. Per the global protocol: version bumps ride with the change that warrants them — for a focused patch this is one commit. Subject style: `feat: <version> — <one-line theme>` or `chore(release): v<version> — <theme>`. Plain `-m` only, no heredoc, no `Co-authored-by` or `Generated with` trailers.
> 7. **Annotated tag** `v<version>` (`-a`, NOT lightweight): terse message with release theme, notable changes, and dep arrows in `pkg ^old → ^new` form if applicable. Not a CHANGELOG copy.
>
> **Do NOT push.** Phase 5 handles the push as part of `release-and-publish`'s verification gate flow.
>
> **Verify state at the end:**
> ```bash
> git log --oneline -1
> git show v<version> --stat | head -20
> git status   # should be clean
> ```
>
> Constraints: Bash git only. NEVER `git stash`. NEVER `reset --hard` / `restore .` / `clean -f` / `checkout -- .`. No marketing adjectives ("comprehensive", "robust", "enhanced", "seamless", "improved") in commit or tag messages. Be concise and accurate.

After this fanout, each target has a clean working tree with the release commit + tag locally; nothing has been pushed.

### Phase 5: Release publish

Run only after user authorizes the publish. **This phase is irreversible.**

Each target invokes the `release-and-publish` skill end-to-end. Execution mode depends on the npm 2FA setup confirmed in pre-flight:

| Mode | When | How |
|:-----|:-----|:----|
| **Parallel fanout** | npm 2FA bypass configured, OR no npm publish involved | One sub-agent per target runs `release-and-publish` end-to-end |
| **Serial (orchestrator-driven)** | npm 2FA prompts OTP interactively | Orchestrator invokes `release-and-publish` against each target one at a time; may use `git-mcp-server` tools in this serial mode |

**Parallel mode task body:**

> Read `skills/release-and-publish/SKILL.md` (or `.claude/skills/release-and-publish/SKILL.md`). Run it end-to-end:
>
> 1. Sanity-check wrapup outputs (working tree clean, HEAD tagged `v<version>` from Phase 4)
> 2. Verification gate: `bun run devcheck`, `bun run rebuild`, `bun run test:all` (or `test`)
> 3. Push commits and tags to origin via Bash git
> 4. `bun publish --access public` (npm — uses the configured bypass token)
> 5. `bun run publish-mcp` if `server.json` exists (MCP Registry)
> 6. `docker buildx build --platform linux/amd64,linux/arm64 --push ...` if `Dockerfile` exists (GHCR)
> 7. Report deployed artifact URLs (npm, MCP Registry, GHCR)
>
> Honor the skill's retry/halt protocol — transient network errors retry up to 2× with backoff; idempotent-success signals ("version already exists", "cannot publish duplicate version") are treated as success and proceed. Bash git for all git ops. Never skip the verification gate.

**Serial mode:** the orchestrator runs `release-and-publish` against each target sequentially in its own session, handling OTP prompts interactively as they appear.

After Phase 5, collect per-target status: which destinations succeeded, which (if any) halted with partial state. The user re-invokes Phase 5 for any failed targets only — completed destinations hit the idempotent-success signal and skip naturally.

### Phase 6: Issue closure fanout (optional)

Only run if pre-flight captured a GH issue map. One sub-agent per target with the per-target issue list.

**Task body:**

> For each issue in `[per-target issue list]`:
>
> 1. `gh issue view <number> --comments` to read the full thread (body + all comments)
> 2. Compose a closing comment naming what shipped (version `v<version>` and a one-line summary of the fix or feature)
> 3. `gh issue comment <number> -b "<comment>"` then `gh issue close <number>` — unless the thread suggests the fix is partial or the issue scope has expanded, in which case comment but do NOT close, and flag back to the orchestrator
>
> Constraints: read the full thread before commenting — `gh issue view` alone shows only the thread, not the body; for combined view use `gh api repos/<owner>/<repo>/issues/<number>`. No marketing adjectives. Be concise and accurate.

Skip Phase 6 for any target whose Phase 5 didn't complete — there's nothing to close if the release didn't ship.

## Gotchas specific to release pass

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | npm 2FA OTP prompts interleave under parallel publish, breaking all in-flight publishes | Confirm bypass setup in pre-flight; fall back to serial mode for Phase 5 if not configured |
| 2 | Phase 4 sub-agent pushes prematurely | Restate "Do NOT push" in the Phase 4 prompt verbatim; Phase 5 owns the push as part of `release-and-publish`'s flow |
| 3 | Version bump skipped a file (`server.json`'s per-package entries, README badge, Dockerfile OCI labels) | Phase 4 prompt enumerates every version-bearing file; the `grep -rn "<current-version>"` step catches stragglers |
| 4 | Sub-agent reports "tag already exists" — a Phase 4 retry race, or a left-over tag from a failed prior run | Inspect with `git tag -l "v<version>"` and `git show v<version>` before re-running; never `git tag -d` without user authorization |
| 5 | Two targets derive the same version from a shared assumption | Phase 4 prompt always derives version from each target's CURRENT `package.json`, not from a value the orchestrator assumed |
| 6 | `release-and-publish` halts mid-flow for one target (network blip on docker push) | The skill's retry protocol handles transient errors; non-transient halts produce a partial-state report. Collect per-target status; user re-invokes for failed targets only |
| 7 | Phase 6 sub-agent picks the wrong issues by guessing from commit messages | Pre-flight captures the explicit issue map per target; sub-agent works from that list, doesn't discover issues itself |
| 8 | Annotated tag message bloats into a CHANGELOG copy | Restate the rule in Phase 4 prompt: terse release theme + notable changes + dep arrows in `pkg ^old → ^new` form. Length is earned |
| 9 | Sub-agent uses `git-mcp-server` instead of Bash git in Phase 4 or 5 | Hard Rule 1 restated explicitly in every fanout prompt that touches git |
| 10 | Failed publish leaves a tag pushed but no npm package — looks shipped, isn't | Collect per-destination status per target in Phase 5 roll-up; surface partial-state targets explicitly to the user before Phase 6 |

## Checklist

- [ ] Pre-flight: target list confirmed, version bump intent per target, npm 2FA mode confirmed (bypass / serial / N/A), GH issue map captured (or empty), plan surfaced to user
- [ ] **User authorization captured for the release**
- [ ] Phase 2: verification fanout — green `bun run devcheck` + tests per target
- [ ] Phase 3: README review fanout — updates folded, no commits
- [ ] Phase 4: wrap-up fanout (Bash git only) — version bumped, changelog authored, rollup regenerated, commit + annotated tag per target — **NOT pushed**
- [ ] Working tree clean per target; `git show v<version>` succeeds per target
- [ ] Phase 5: release publish — completed per target via `release-and-publish` (parallel or serial based on 2FA mode); per-target status captured
- [ ] All targets: deployed artifact URLs reported (npm / MCP Registry / GHCR as applicable)
- [ ] **If GH issue map captured:** Phase 6: issue closure fanout — relevant issues commented and closed per target whose Phase 5 succeeded
- [ ] Final read-only verification: `git ls-remote --tags origin` shows the new tag per target, versions match across files, npm/registry show the new version, GH issue status matches intent
