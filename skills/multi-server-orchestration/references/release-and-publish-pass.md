---
name: release-and-publish-pass
description: >
  Multi-server-orchestration reference for release-and-publish passes — the end-to-end ship workflow combining wrap-up (version bump, changelog, commit, annotated tag) and publish (push + npm + MCP Registry + GHCR) across N MCP server projects. Drives parallel verification → README polish → wrap-up (Bash git, local only — distilled from `git_wrapup_instructions`) → publish (via the standalone `release-and-publish` skill per target) → optional GH issue closure. Phase 5 runs serial when npm 2FA prompts interactively; parallel when bypass is configured. Disambiguated from the single-target `release-and-publish` skill it invokes per target.
metadata:
  author: cyanheads
  version: "1.3"
  audience: internal
  type: reference
---

# Release-and-Publish Pass — Multi-Server Orchestration

Use after reading `../SKILL.md`. This reference handles end-to-end ship work across N MCP server projects — verification gate → README polish → wrap-up (version bump, changelog, commit, annotated tag — Bash git, local) → publish (push + npm + MCP Registry + GHCR via the standalone `release-and-publish` skill) → optional GH issue closure.

> **Disambiguation.** This orchestration reference invokes the standalone `release-and-publish` skill once per target in Phase 5 — the skill is the single-target publish workflow; this reference is the multi-target fanout around it (plus pre-publish phases). Don't conflate them: the skill ships one server; this reference orchestrates shipping N.

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

A typical single-target release-and-publish flow runs in one session: `git_set_working_dir` + `git_wrapup_instructions` from `git-mcp-server` drive the wrap-up phase, then the standalone `release-and-publish` skill drives the publish phase. This reference translates that into the multi-target parallel pattern:

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

> Run `bun run devcheck`. Then run `bun run test:all` if it exists in `package.json` scripts, otherwise `bun run test`. Both must pass green. Halt and report the failing step's verbatim output if anything fails — do not attempt fixes from inside this phase. If neither `test:all` nor `test` exists in `package.json` scripts, note it and continue — devcheck-only is acceptable (though uncommon for a project shipping a release).

Any red target halts the orchestration for that target. The user fixes locally and re-invokes Phase 2 for the failing target(s) only — other targets that passed don't need to re-run.

### Phase 3: README review fanout

One sub-agent per target reads the full README plus key adjacent docs, identifies stale or missing content (feature counts, version badges, surface tables, configuration sections, dep version mentions), and folds updates in. No commits — Phase 4 stages everything together.

**Task body:**

> Read `README.md` from front to back. Identify content stale relative to the current code: tool/resource counts, version badges, feature lists, configuration tables, version mentions in install snippets. Fold updates in naturally — don't rewrite sections that are already accurate. Do NOT commit. Leave changes in the working tree for the next phase.
>
> If `polish-docs-meta` skill is available (`skills/polish-docs-meta/SKILL.md`) and the change spans more than just the README (e.g., new env vars, new tools), invoke that skill instead — it handles README plus `server.json`, `package.json`, agent protocol, and `.env.example` in one pass.
>
> If the README is already accurate, report "no changes needed" and exit cleanly.

For a small patch bump, this phase is often a no-op. That's fine.

### Phase 4: Wrap-up fanout (Bash git only)

Runs on the authorization captured in Pre-flight Step 5 — no separate authorization needed for wrap-up.

One sub-agent per target. The agent reads and executes the standalone `git-wrapup` skill (`skills/git-wrapup/SKILL.md`) — the skill contains the complete protocol for version bump, changelog, verification, commit, and annotated tag.

**Task body:**

> Read and follow the `git-wrapup` skill — check `skills/git-wrapup/SKILL.md` first; fall back to `.claude/skills/git-wrapup/SKILL.md` if not found. Apply a `[patch/minor/major]` version bump.
>
> Additional constraints for orchestrated runs:
> - **Bash `git` only.** Do not use `git-mcp-server` (`mcp__git-mcp-server__*`) tools — session state leaks across parallel agents in the same orchestrator session.
> - **Do NOT push.** Phase 5 handles the push as part of `release-and-publish`.
> - If `v<version>` already exists as a tag, **halt and surface the conflict** to the orchestrator. Do NOT `git tag -d` without authorization.
>
> Output for the orchestrator: commit SHA, tag name, tag annotation subject.

After this fanout, each target has a clean working tree with the wrap-up commit + annotated tag locally; nothing has been pushed.

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
> 1. Sanity-check wrapup outputs (working tree clean, HEAD tagged `v<version>` from Phase 4). If either check fails, halt and report to the orchestrator — do not re-run Phase 4 from inside Phase 5
> 2. Verification gate: `bun run devcheck`, `bun run rebuild`, `bun run test:all` (or `test`)
> 3. Push commits and tags to origin via Bash git
> 4. `bun publish --access public` (npm — uses the configured bypass token)
> 5. `bun run publish-mcp` if `server.json` exists (MCP Registry)
> 6. `bun run bundle` + `gh release create v<version> --verify-tag --notes-from-tag <dist/*.mcpb>` if `manifest.json` exists (MCPB GitHub Release). Must run from inside the repo dir — `--notes-from-tag` is incompatible with `--repo`.
> 7. `docker buildx build --platform linux/amd64,linux/arm64 --push ...` if `Dockerfile` exists (GHCR)
> 8. Report deployed artifact URLs (npm, MCP Registry, GitHub Release, GHCR)
>
> Honor the skill's retry/halt protocol — transient network errors retry up to 2× with backoff; idempotent-success signals ("version already exists", "cannot publish duplicate version") are treated as success and proceed. Bash git for all git ops. Never skip the verification gate.

**Serial mode:** the orchestrator spawns one sub-agent at a time per target — each runs `release-and-publish` end-to-end, completing before the next target starts. This prevents OTP prompt interleaving.

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

## Gotchas specific to release-and-publish pass

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
| 11 | `gh release create --notes-from-tag` fails with `--repo` flag | `gh` CLI limitation. Always `cd` into the target repo dir for `gh release` commands instead of using `--repo` |
| 12 | Post-version doc changes (install badges, description fixes) land after the version commit — tag points at stale content | Move the tag forward: delete remote release, delete remote+local tag, recreate tag at new HEAD with same annotation, re-push, recreate release with `.mcpb`. This requires explicit user confirmation before executing — ask at runtime |
| 13 | `mcpb pack` fails because `manifest.json` `user_config` entries are missing `title`/`type` fields | Verify `manifest.json` `user_config` entries during Phase 3 or a pre-Phase-5 check; the `polish-docs-meta` skill's cross-file consistency section covers this |

## Checklist

- [ ] Pre-flight: target list confirmed, version bump intent per target, npm 2FA mode confirmed (bypass / serial / N/A), GH issue map captured (or empty), plan surfaced to user
- [ ] **User authorization captured for the release-and-publish**
- [ ] Phase 2: verification fanout — green `bun run devcheck` + tests per target
- [ ] Phase 3: README review fanout — updates folded, no commits
- [ ] Phase 4: wrap-up fanout (Bash git only) — version bumped, changelog authored, rollup regenerated, commit + annotated tag per target — **NOT pushed**
- [ ] Working tree clean per target; `git show v<version>` succeeds per target
- [ ] Version-bearing files consistent across `package.json`, `server.json`, README badge, and `Dockerfile` OCI labels per target — no doc changes pending after the tag
- [ ] Phase 5: release publish — completed per target via `release-and-publish` (parallel or serial based on 2FA mode); per-target status captured
- [ ] All targets: deployed artifact URLs reported (npm / MCP Registry / GHCR as applicable)
- [ ] **If GH issue map captured:** Phase 6: issue closure fanout — relevant issues commented and closed per target whose Phase 5 succeeded
- [ ] Final read-only verification: `git ls-remote --tags origin` shows the new tag per target, versions match across files, npm/registry show the new version, GH issue status matches intent
