---
name: wrapup-pass
description: >
  Multi-server-orchestration reference for git wrap-up passes — distilled from `git-mcp-server`'s `git_wrapup_instructions` protocol. Drives parallel verification → optional doc review → wrap-up (version bump, changelog, commit, annotated tag — Bash git, local only, no push) → roll-up across N MCP server projects. Stops at "committed and tagged locally". No push, no publish — those are separate, separately-authorized workflows.
metadata:
  author: cyanheads
  version: "1.2"
  audience: internal
  type: reference
---

# Wrap-up Pass — Multi-Server Orchestration

Use after reading `../SKILL.md`. This reference distills the `git_wrapup_instructions` protocol into a multi-target fanout: per target, verify → polish docs → bump version + author changelog + commit + annotated tag, **all local**. No push, no publish, no remote ops.

## When applicable

- One or more MCP servers have committed/uncommitted work to land as a new local commit + annotated tag — for review, or to hold locally pending a separately-authorized publish step
- Common follow-on to a `maintenance-pass` run where adopted changes are worth shipping
- Common precursor to a `release-and-publish-pass` run when wrap-up and publish are split across sessions (e.g., wrap-up tonight, publish tomorrow after a final review)

This reference assumes the change to land is done — it's the "land it as a commit + tag" phase, not the "do the work" phase.

If publish follows immediately in the same session, prefer `release-and-publish-pass.md` end-to-end; it embeds wrap-up as its Phase 4. This reference exists for sessions that stop at "tagged locally" deliberately.

## The wrap-up protocol — acceptance criteria

Distilled from `git_wrapup_instructions`. **Strict on goals, generic on mechanism.** Every sub-agent treats these as the acceptance checklist for "done":

1. **Full diff reviewed end-to-end** before commits are planned
2. **Version bumped per semver** (default patch; minor/major when warranted) across every place version is declared
3. **Changelog updated** under the new version in the project's existing format
4. **Documentation current** for any referenced behavior changes
5. **Verification suite passes** against the tree being committed
6. **Commits atomic and in Conventional Commits form** — version bumps ride with the change that warrants them
7. **Annotated tag** at the project's convention (`v<version>`) with a concise message — no filler

Universal constraints from the protocol: do not push, do not bypass verification failures, do not rewrite published history.

For `@cyanheads/mcp-ts-core` consumers, the mechanism is concrete (below). External projects substitute their own conventions while preserving the seven acceptance goals.

## Pre-flight (orchestrator)

Before spawning any sub-agents:

1. **Confirm the target list with the user.** Capture absolute paths and the intended version bump per target (`patch` / `minor` / `major`, or an explicit version string). Mixed bumps across targets are fine.
2. **Confirm the change shape per target.** What changed since the last release? This drives the conventional-commit subject, the per-version changelog body, and the annotated tag message. One or two lines per target is enough for a focused patch.
3. **Verify each target's working tree state.** Run `git status` and `git log v<latest-tag>..HEAD --oneline` per target to confirm there's actually work worth wrapping. A target with no commits since its last tag and a clean working tree has nothing to wrap.
4. **Surface the plan and get explicit authorization.** Scenario, target list, version bump per target, gotchas in play. The wrap-up itself is reversible (no push), but tag conflicts surface fast and are easier to head off in pre-flight.

## Phase pattern

| # | Phase | Mode | Inputs | Outputs |
|:--|:------|:-----|:-------|:--------|
| 1 | Pre-flight | orchestrator | Target list, bump intent, change shape | Verified plan, user authorization |
| 2 | Verification fanout | fanout | Existing target state | Per-target: green `bun run devcheck` + `bun run test:all` (or `test`) |
| 3 | Doc review fanout (optional) | fanout | Current README + adjacent docs + change shape | Per-target: doc updates folded in, no commits |
| 4 | Wrap-up fanout | fanout, Bash git only | Phase 3 outputs + version bump intent | Per-target: version bumped, changelog authored, rollup regenerated, commit + annotated tag — **LOCAL ONLY, no push** |
| 5 | Roll-up | orchestrator | Phase 4 outputs | Per-target verification of commit + tag; consolidated report to user |

Phase 3 is optional — skip when the change is small enough that the README/docs are already accurate. For a maintenance-driven patch with no user-facing behavior change, it's often a no-op.

## Phase details

> **Orient block:** the standard preamble instructing sub-agents to read `~/.claude/CLAUDE.md`, workspace `CLAUDE.md`, project `CLAUDE.md`, and run `bun run list-skills` — defined in `../SKILL.md`. Every sub-agent prompt starts with this block before the task body.

### Phase 2: Verification fanout

One sub-agent per target. Quick verification gate before any version bump or wrap-up.

**Task body (after the orient block):**

> Run `bun run devcheck`. Then run `bun run test:all` if it exists in `package.json` scripts, otherwise `bun run test`. Both must pass green. Halt and report the failing step's verbatim output if anything fails — do not attempt fixes from inside this phase. If neither `test:all` nor `test` exists in `package.json` scripts, note it and continue — devcheck-only is acceptable (though uncommon for a project shipping a release).

Any red target halts the orchestration. The user fixes locally and re-invokes from Phase 2.

### Phase 3: Doc review fanout (optional)

One sub-agent per target reads the README plus adjacent docs, identifies stale content relative to the current code, and folds updates in. No commits — Phase 4 stages everything together.

**Task body:**

> Read `README.md` from front to back. Identify content stale relative to the current code: tool/resource counts, version badges, feature lists, configuration tables, version mentions in install snippets. Fold updates in naturally — don't rewrite sections that are already accurate. Do NOT commit. Leave changes in the working tree for the next phase.
>
> If `polish-docs-meta` skill is available (`skills/polish-docs-meta/SKILL.md`) and the change spans more than just the README (e.g., new env vars, new tools), invoke that skill instead — it handles README plus `server.json`, `package.json`, agent protocol, and `.env.example` in one pass.
>
> If the README is already accurate, report "no changes needed" and exit cleanly.

For a small patch, this phase is often a no-op. Skip Phase 3 when the diff introduces no new tools, resources, env vars, or behavior changes visible to the user.

### Phase 4: Wrap-up fanout (Bash git only)

Runs on the authorization captured in Pre-flight Step 4 — no separate authorization needed for wrap-up.

One sub-agent per target. The agent reads and executes the standalone `git-wrapup` skill (`skills/git-wrapup/SKILL.md`) — the skill contains the complete protocol for version bump, changelog, verification, commit, and annotated tag.

**Task body:**

> Read and follow the `git-wrapup` skill — check `skills/git-wrapup/SKILL.md` first; fall back to `.claude/skills/git-wrapup/SKILL.md` if not found. Apply a `[patch/minor/major]` version bump.
>
> Additional constraints for orchestrated runs:
> - **Bash `git` only.** Do not use `git-mcp-server` (`mcp__git-mcp-server__*`) tools — session state leaks across parallel agents in the same orchestrator session.
> - If `v<version>` already exists as a tag, **halt and surface the conflict** to the orchestrator. Do NOT `git tag -d` without authorization.
>
> Output for the orchestrator: commit SHA, tag name, tag annotation subject.

### Phase 5: Roll-up (orchestrator)

The orchestrator verifies per-target via read-only Bash git:

```bash
for d in <target paths>; do
  echo "=== $d ==="
  (cd "$d" && git log --oneline -1 && git tag --points-at HEAD && git status --short)
done
```

Spot-check commit and tag quality: `git log --format='%s%n%b' -1` for marketing adjectives in commit messages, `git show v<version>` for tag annotation structure.

Then produces a consolidated report:

1. **Per-target headline** — target → new version → tag annotation subject → commit SHA
2. **Outliers** — targets that halted (verification red, tag conflict, missed version files surfaced during the run)
3. **Endpoint.** Wrap-up stops here. Anything further — pushing, publishing, closing issues — requires a separate explicit user instruction in a new invocation; the orchestrator does NOT advance from a wrap-up pass on its own.

## Gotchas specific to wrap-up

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | Sub-agent pushes prematurely despite "local only" instruction | Restate "Do NOT push" in the Phase 4 prompt verbatim; verify post-fanout that `git log @{u}..HEAD` shows the wrap-up commit (i.e., still ahead of origin) |
| 2 | Version bump skipped a file (`server.json`'s per-package entries, README badge, Dockerfile OCI labels, `manifest.json`) | Phase 4 prompt enumerates every version-bearing file; the `grep -rn "<current-version>"` step catches stragglers |
| 3 | Tag at `v<version>` already exists (leftover from failed prior run, or two orchestrator runs against the same target) | Sub-agent halts and surfaces conflict; never `git tag -d` without orchestrator authorization. Inspect with `git tag -l "v<version>"` and `git show v<version>` |
| 4 | Annotated tag message bloats into a CHANGELOG copy, or collapses into a flat comma-separated string | Phase 4 prompt has explicit structured format: subject, prose intro, sectioned bullets, dep arrows, test footer. Both extremes (too long, too flat) are format violations |
| 5 | Marketing adjectives slip into commit/tag messages | Restate the no-marketing rule in the prompt body; orchestrator spot-checks during Phase 5 (`git log --format='%s%n%b' -1`, `git show v<version>`) |
| 6 | Sub-agent uses `git-mcp-server` instead of Bash git | Phase 4 prompt restates Hard Rule 1 from parent SKILL.md; session-state leak across parallel agents is real |
| 7 | Verification gate skipped because "the change is small" | Restate "Halt if not green — do NOT bypass" in the prompt; the wrap-up protocol forbids bypass and the orchestrator confirms green status in Phase 5 |
| 8 | Two targets derive the same target version from a shared assumption | Phase 4 prompt always derives version from each target's CURRENT `package.json`, not from a value the orchestrator assumed |
| 9 | Sub-agent commits in multiple atomic chunks when the work is one cohesive concern | Restate the rule: "Version bumps ride with the change that warrants them — for a focused patch, ONE commit." Multi-commit splits are for genuinely independent concerns, not ceremonial separation of "the work" from "the release" |

## Checklist

- [ ] Pre-flight: target list confirmed, version bump intent per target, change shape per target, user authorization captured
- [ ] Phase 2: verification fanout — green `bun run devcheck` + tests per target
- [ ] Phase 3 (if applicable): doc review fanout — README/docs updates folded in, no commits
- [ ] Phase 4: wrap-up fanout (Bash git only) — every acceptance criterion satisfied per target; commit + annotated tag — **NOT pushed**
- [ ] Working tree clean per target after Phase 4
- [ ] Tags exist locally; nothing pushed to remotes
- [ ] Phase 5: orchestrator verification — `git log --oneline -1`, `git tag --points-at HEAD`, `git status --short` per target
- [ ] Consolidated report presented to user with per-target headlines, outliers, next steps
- [ ] Orchestrator has NOT advanced to push, publish, or any remote operation — wrap-up is complete
