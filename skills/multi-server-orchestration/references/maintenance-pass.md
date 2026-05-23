---
name: maintenance-pass
description: >
  Multi-server-orchestration reference for maintenance passes. Drives parallel `bun update --latest`, changelog investigation (via the changelog skill), framework adoption per the maintenance skill's auto-adopt rule, skill/script sync (Phase A/B/C), and verification across N existing MCP server projects. Optional Bash-git wrap-up fanout commits adoptions after user authorization.
metadata:
  author: cyanheads
  version: "1.2"
  audience: internal
  type: reference
---

# Maintenance Pass — Multi-Server Orchestration

Use after reading `../SKILL.md`. This reference handles parallel `bun update` + changelog investigation + framework adoption + verification across N existing MCP server projects.

## When applicable

- One or more existing servers built on `@cyanheads/mcp-ts-core` need a coordinated maintenance pass
- N = 1 still benefits — the value is the fresh-context sub-agent running the full `maintenance` skill end-to-end without context pollution
- Each target must have a clean working tree (uncommitted work blocks the maintenance skill's verification gate)

## Pre-flight (orchestrator)

Before spawning any sub-agents:

1. **Confirm the target list** with the user. Capture absolute paths.
2. **Verify each target is a git repo with a clean working tree.** Run `git status` per target. Halt if any is dirty — user fixes locally and re-invokes.
3. **Verify each target has `scripts/list-skills.ts` and the `list-skills` package script.** Both ship via `init`; older projects pick them up on the next `maintenance` Phase C sync — which is what's about to run. If missing at this moment, that's fine; note it and the sub-agent will pick them up.
4. **Verify each target has the `maintenance` skill available** (in `skills/` or `.claude/skills/`). If missing, that's a sign the project hasn't been initialized from a recent framework version — flag it; the sub-agent can still work from the package's copy at `node_modules/@cyanheads/mcp-ts-core/skills/maintenance/SKILL.md`.
5. **Check `publish-mcp` script presence** when `server.json` exists. If missing, flag it — the maintenance sub-agent or a follow-up agent should add it.
6. **Check `manifest.json` existence.** If missing and the project has `server.json`, flag it — the maintenance sub-agent should scaffold it from `templates/manifest.json` during framework adoption (Step 6).
7. **Clarify the user authorization scope.** Do they want sub-agents to commit/push at the end, or stop at "changes applied, working tree dirty, awaiting review"? Default is the latter.

## Phase pattern

| # | Phase | Mode | Inputs | Outputs |
|:--|:------|:-----|:-------|:--------|
| 1 | Pre-flight | orchestrator | Target list + auth scope | Verified clean working trees, list-skills/maintenance availability noted |
| 2 | Maintenance fanout | fanout | `maintenance` skill | Per-target: green devcheck, working tree with framework/dep adoptions, Step 8 numbered summary |
| 3 | Roll-up | orchestrator | Phase 2 summaries | Consolidated cross-target report presented to user |
| 4 | (Optional) Wrap-up | fanout, Bash git only | Phase 2 outputs | Per-target commit + push, after user authorizes |

Phase 4 is optional — if the user wants to review changes locally first or split adoption decisions across multiple sessions, the orchestration ends at Phase 3 with dirty working trees.

## Phase details

### Phase 2: Maintenance fanout

One sub-agent per target. Each agent runs the `maintenance` skill end-to-end in **Mode A** (full flow from `bun outdated` through verification).

**Orient block substitution.** For maintenance, the parent SKILL.md's orient step 6 ("read spec artifacts") has no applicable artifact — the maintenance skill itself is the spec, already covered by step 5. When constructing the per-target prompt, replace step 6 with "N/A for maintenance" so the sub-agent doesn't hunt for a non-existent `docs/design.md`.

**Task body (after the orient block):**

> Read `skills/maintenance/SKILL.md` (or `.claude/skills/maintenance/SKILL.md`, whichever exists). Run it end-to-end in Mode A:
>
> 1. `bun outdated` — capture the list
> 2. `bun update --latest` — apply, capturing the `↑ package old → new` lines for Step 3
> 3. Invoke the `changelog` skill for each updated package
> 4. If `@cyanheads/mcp-ts-core` updated, do the deeper framework review from Step 4 of the maintenance skill
> 5. Run Step 5 skill/script sync (Phase A: package → project `skills/`; Phase B: project `skills/` → agent dirs; Phase C: package scripts + pristine refs → project)
> 6. Adopt changes per Step 6 — **framework changes are auto-adopt every applicable site in this pass**, no scope/effort/marginal-benefit deferrals; third-party libs are cost/benefit
> 7. `bun run rebuild` → `bun run devcheck` → `bun run test`
> 8. Produce the Step 8 numbered summary (Updated packages, Breaking changes handled, Features adopted, Skills synced, New/changed skills available, Open decisions, Status)
>
> Constraints:
> - **No write git commands** — no `commit`, `push`, `tag`, `branch`, `merge`, `rebase`, `cherry-pick`, `add`, `reset`, `restore`, `checkout --`, `clean`, `stash`. Leave the working tree dirty for orchestrator review.
> - Read-only git is allowed and expected — `status`, `diff`, `log`, `show`, `blame`. The maintenance skill's Step 5 Phase A explicitly requires `git diff skills/` after sync to surface adoption signal; do that.
> - NEVER `git stash` for any reason. NEVER `git reset --hard`, `git restore .`, `git clean -f`, or `git checkout -- .` — these violate the global protocol.
> - Halt and report if `bun run devcheck` can't be made green after adoption. `bun run test` is skip-not-halt: if the project has no `test` script in `package.json`, note it and continue.
> - Output the Step 8 summary verbatim at the end of your run — the orchestrator parses it.
>
> If the `maintenance` skill's own version increased in Phase A of the skill sync (skill-version paradox), re-read the synced `skills/maintenance/SKILL.md` and continue from Step 5 onward with the new version.

**Expected sub-agent output:** the Step 8 numbered summary plus a `bun run devcheck` / `bun run test` final pass.

### Phase 3: Roll-up (orchestrator)

The orchestrator collects each sub-agent's Step 8 summary and produces a consolidated cross-target report for the user:

1. **Per-target headlines** — short table: target → N packages updated → green/red devcheck → status
2. **Cross-target patterns** — features adopted across multiple targets, third-party libs updated everywhere, breaking changes that hit a subset
3. **Open decisions** — any per-target ambiguities flagged. Group by decision so the user can rule once across multiple targets when the choice is the same
4. **Outliers** — targets where the working-tree diff is unusually large, or where adoption couldn't complete cleanly

Wait for user direction before Phase 4 — they may want to inspect diffs locally first.

### Phase 3.5: Double-check / normalization pass (recommended)

Independent maintenance agents diverge on incidental choices and miss adoption sites under context pressure. A lightweight follow-up fanout catches gaps before wrap-up:

- **Adoption gaps** — features the updated skills say to do that weren't applied (error code semantic audit, missing scaffolding files like `manifest.json`/`.mcpbignore`, `publish-mcp` script)
- **Audience compliance** — only skills with `metadata.audience: external` should be in project `skills/`; agents sometimes sync `internal`-audience skills
- **Content accuracy** — `isRequired` flags in `server.json` match the upstream API's actual requirement; `manifest.json` `name` doesn't include the npm scope prefix; `user_config` entries have required `title` and `type` fields
- **Cross-target consistency** — if a feature shows up in 3 of 5 Step 8 summaries, the other 2 likely missed it

These agents should **fix, not just report** — analysis-only agents create unnecessary follow-up. After fixing, re-run `bun run rebuild && bun run devcheck && bun run test`.

Use a lighter model (e.g. Sonnet) for this pass — it's verification and targeted fixes, not deep adoption work.

### Phase 4: Wrap-up fanout (optional, Bash git only)

Run only after explicit user authorization. Per-target commit decisions are driven by the change shape:

- **Pure third-party dependency update** — `chore(deps): update dependencies` (or per-package if the diff is concentrated)
- **Framework upgrade with adoption changes** — `chore(framework): mcp-ts-core <old> → <new>, adopt <pattern>`
- **Mixed** — split into atomic commits per the global git rules ("Related changes ship together; unrelated changes split")

One sub-agent per target. Each agent:

1. Re-confirms the working tree still reflects Phase 2's changes (no manual reverts since)
2. Stages and commits in atomic units per the global protocol — version bumps ride with the change that warrants them; do not manufacture extra ceremonial commits
3. Pushes to origin

If the maintenance pass should drive a version bump (breaking framework upgrade, or follow-on release intent), see the `release-and-publish` skill — the orchestrator may chain a release scenario as a separate run.

## Gotchas specific to maintenance

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | Aggressive auto-adoption — the `maintenance` skill mandates "every applicable framework site, in this pass" with no scope/effort deferrals | Expected and correct. Diffs per target may be large; surface size in the roll-up so the user can prioritize review |
| 2 | Skill-version paradox — if `node_modules/@cyanheads/mcp-ts-core/skills/maintenance/SKILL.md` version is newer than the synced project copy, feature-adoption rows added in the new version don't surface | Sub-agent prompt restates the paradox: after Phase A sync completes, re-read the synced `maintenance` SKILL.md and continue from Step 5 |
| 3 | Per-target adoption divergence is expected — projects on different starting framework versions adopt different things | Don't try to normalize. Surface divergence as informational in the roll-up; the user may run a separate orchestration to bring stragglers forward |
| 4 | The `changelog` skill may not exist in a target's skill directory yet | Sub-agent falls back to direct `node_modules/<pkg>/CHANGELOG.md` reading, as documented in the maintenance skill's Step 3 |
| 5 | Sub-agent runs write git commands despite instruction (commit/push/reset/stash/etc.) | Restate the no-write-git list + the no-`stash` rule in the prompt body; verify via `git log --oneline -1` per target after Phase 2 — should show no new commits since pre-flight |
| 6 | Targets at the same framework version produce inconsistent adoption choices | Usually means one agent missed a site; spot-check the Step 8 "Features adopted" lists across targets. If a feature shows up for 3 of 4, the 4th likely missed it — spawn a narrow finish-pass agent for that target |
| 7 | Big monorepo or many adoptions cause context exhaustion in a sub-agent | Narrow the prompt: if a target has many breaking framework changes, split the sub-agent's work into "update deps + verify" and "adopt features" as two phases against that target |
| 8 | Agent syncs `internal`-audience skills into project `skills/` | Restate in the prompt: "Only sync skills with `metadata.audience: external`." The maintenance skill's Phase A step 2 says this, but agents miss it under context pressure |
| 9 | `manifest.json` scaffolded with scoped name from `package.json` (e.g. `@cyanheads/bls-mcp-server`) — renders in the mcpb install dialog | Double-check pass should verify `manifest.json` `name` doesn't contain `/`; the `polish-docs-meta` skill's cross-file consistency section covers this |
| 10 | `manifest.json` `user_config` entries missing required `title`/`type` fields — `mcpb pack` fails at release time | Agents scaffold from memory, not the template. Double-check pass should verify all `user_config` entries have `title` and `type` |

## Checklist

- [ ] Pre-flight: target list confirmed, clean working trees verified, `list-skills` presence noted per target, `maintenance` skill availability noted per target, `publish-mcp` and `manifest.json` presence noted, auth scope clarified with user
- [ ] Phase 2: maintenance fanout spawned; each sub-agent returned a Step 8 summary
- [ ] All targets: green `bun run devcheck` and `bun run test` post-adoption
- [ ] Phase 3: consolidated roll-up presented to user with per-target headlines, cross-target patterns, open decisions, outliers
- [ ] **User authorization captured for wrap-up if proceeding to Phase 4**
- [ ] Phase 4: per-target commits via Bash git, pushed to origin
- [ ] Final read-only verification: `git log --oneline -3` and `git ls-remote` per target — commits landed, no stray uncommitted work
