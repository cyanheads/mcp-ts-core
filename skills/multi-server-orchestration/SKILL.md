---
name: multi-server-orchestration
description: >
  Orchestrate parallel sub-agent fanouts across one or more MCP server projects — the same workflow run independently per target. Use for greenfield builds across N new servers, maintenance passes across N existing ones, or any repeatable workflow that benefits from fresh-context per-target sub-agents. Encodes the orient template every sub-agent needs (CLAUDE.md chain + list-skills + spec artifacts), the universal hard rules around git tooling and authorization, the gotchas that bit earlier runs, and a router into per-scenario references for the phase pattern.
metadata:
  author: cyanheads
  version: "1.0"
  audience: external
  type: workflow
---

## When to Use

- Same workflow driven across multiple MCP server projects in parallel — greenfield builds, maintenance updates, security audits, design extensions
- Single server, but the work is large enough to want fresh-context sub-agents per phase rather than one continuous session
- Any case where the per-target work is independent and benefits from devcheck-gated handoffs between phases

Skip this skill for in-session tweaks to a single server — use `add-tool`, `maintenance`, `polish-docs-meta`, etc. directly.

## First Pass

Read this SKILL.md end-to-end first — the concepts, orient block, and hard rules below are universal across scenarios. Then:

1. **Capture the target list.** N projects with absolute paths. Per-target metadata as relevant (framework version, gold-standard reference, GH owner/org). If the user named a single target, that's still N = 1.
2. **Identify the scenario** from user intent first, then sanity-check against project state. If user intent is ambiguous, use the state heuristics below to surface a recommendation and confirm with the user — don't pick silently.

   | Likely scenario | State signals (per target) |
   |:----------------|:---------------------------|
   | **Greenfield build-out** | Echo definitions still present in `src/mcp-server/{tools,resources,prompts}/definitions/`, no real services in `src/services/`, no released changelog files under `changelog/<minor>.x/`, `package.json` version is `0.0.0` or unset |
   | **Maintenance pass** | Real tool/resource definitions present, framework deps installed, `bun outdated` reports updates available, at least one prior release tagged |
   | **Release pass** | Working tree has uncommitted/staged work, OR `git log v<latest-tag>..HEAD` shows commits since the last release that warrant a new version, OR the user explicitly asks to "ship", "release", or do a version bump |
   | **Neither** | None of the above match cleanly — surface the state to the user, ask what they want |

3. **Pick the reference** from the References table below. Each reference contains its scenario's phase pattern, per-sub-agent prompt bodies, scenario-specific gotchas, and checklist.
4. **Surface the plan to the user** before kicking off the first fanout: scenario, target list, phase summary, gotchas in play. Get explicit authorization before any phase that commits, tags, pushes, or creates remote resources.

## References

| Scenario | Reference | When |
|:---------|:----------|:-----|
| **Greenfield build-out** | `references/greenfield-buildout.md` | New server(s) from `bunx @cyanheads/mcp-ts-core init` driven through design → build → first release |
| **Maintenance pass** | `references/maintenance-pass.md` | Existing server(s) need `bun update --latest`, changelog investigation, framework adoption, and verification — optionally followed by a commit/push |
| **Release pass** | `references/release-pass.md` | Existing server(s) have committed/staged work that needs to ship as a new version — verification → README polish → wrapup (version + changelog + commit + tag) → publish (npm / MCP Registry / GHCR via `release-and-publish`) → optional GH issue closure |

Scenarios chain naturally: a maintenance pass often runs into a release pass; a greenfield build-out's final phase is effectively a release pass. Pick the reference for the current scope and chain explicitly if more work follows.

For scenarios not listed (security audits, design-only extensions, framework-wide migrations), the concepts/orient/rules/gotchas below are universal. Author a new reference describing the phase pattern when the workflow becomes repeatable.

## Concepts

**Parallel fanout.** One phase = one parallel batch of sub-agents, one per target. All N agents run independently in the same orchestrator message. The orchestrator (you) collects their results, normalizes inconsistencies, then triggers the next phase.

**Sub-agent isolation.** Sub-agents do **not** inherit the parent session's `CLAUDE.md` chain or skills registry. They start with a blank slate plus the prompt you give them. Every sub-agent prompt must begin with an explicit orient sequence (see below) or it will work from defaults and pattern-matching instead of project conventions.

**Narrow scope per fanout.** A single agent doing "implement everything, write tests, run devcheck, polish, commit, tag" will exhaust its context window before finishing — the work lands on disk but the agent can't continue. Split phases narrowly so each agent finishes well under the context limit. Plan for a follow-up "finish" pass after a big work phase.

**Normalize after divergent fanouts.** Independent agents will diverge on incidental choices (scoped vs. unscoped names, script invocation form, README hero structure). When the choices should be uniform across targets, plan an explicit normalization pass after the fanout — don't expect alignment for free.

## The Orient Block

Every parallel sub-agent prompt opens with this block. The block is **mandatory, not advisory** — the sub-agent's first six tool calls should be the orient sequence, in order. Substitute the bracketed values per target.

```text
You are working on `[project name]` at `[project absolute path]`.

Orient first. These six steps are required before any task work — do them in
order. If any file does not exist, note it and continue.

1. Read the global agent protocol at `~/.claude/CLAUDE.md` (or your agent's equivalent).
2. Read the workspace-level protocol if one exists at `[workspace CLAUDE.md path]`
   — skip this step if no workspace-tier protocol applies.
3. Read the project protocol at `[project absolute path]/CLAUDE.md`.
4. Run `cd [project absolute path] && bun run list-skills` to see the project's
   available skills with descriptions and locations.
5. Read the skill file(s) for this task: `[skill paths]`.
6. Read the spec artifact(s) you'll work from: `[doc paths, e.g., docs/design.md]`.

Only after that, begin the task below.

**Task:** [concrete description with constraints, no-go list, expected outputs]
```

The orient block compensates for the two pieces of context sub-agents don't inherit: the CLAUDE.md chain (global → workspace → project) and the project skill registry. Both must be reconstructed manually inside the sub-agent prompt or the agent works from defaults.

### Prerequisite: `list-skills.ts` in each project

`list-skills.ts` is the script the orient block runs in step 4. It parses YAML frontmatter from each project-local `.claude/skills/*/SKILL.md` (falling back to `skills/`) and prints a summary an agent can read. It ships with `@cyanheads/mcp-ts-core` and is scaffolded by `init` into `scripts/list-skills.ts` with a corresponding `list-skills` package script. Projects scaffolded before the script existed pick it up via `maintenance` Phase C on the next sync.

Verify presence in each target before kicking off any fanout:

```bash
test -f scripts/list-skills.ts && grep -q '"list-skills"' package.json
```

## Hard Rules

These apply to every scenario. Scenario-specific rules live in their reference.

1. **Bash `git` only in parallel sub-agents.** Do not let parallel sub-agents call `mcp__git-mcp-server__*` tools. The MCP server's session state (`set_working_dir`) leaks across parallel agents in the same orchestrator session, causing silent no-ops, wrong-directory operations, and false "tag already exists" errors. Bash `git` in the agent's CWD is reliable. The orchestrator may still use git-mcp-server itself in serial.
2. **No git commits, pushes, tags, branch creation, or destructive ops without an explicit user request.** Setup-phase and build-phase work is left unstaged for review. Wrap-up phases run only after the user authorizes a commit. Honor every `~/.claude/CLAUDE.md` rule: no `git stash`, no `reset --hard`, no `restore .`, no `clean -f`, no `--no-verify`, plain `-m` commit messages, no `Co-authored-by` or `Generated with` trailers.
3. **`bun run devcheck` is the handoff gate.** Work phases must hand back a green devcheck. If a sub-agent can't reach green, it reports the failing step verbatim and stops rather than carrying broken state forward to the next phase.
4. **Verify sub-agent claims with a read-only check.** Agent summaries describe intent, not always reality. After any fanout that touched the filesystem, the orchestrator confirms with `git log`, `git status`, `ls`, or its own `bun run devcheck` before declaring the phase done.
5. **Skip marketing adjectives.** In commits, tags, READMEs, and CHANGELOG entries — no "comprehensive", "robust", "enhanced", "seamless", "improved". State the change. Restate this rule in every sub-agent prompt that produces text artifacts; the global protocol's restated rules aren't visible to sub-agents at prompt time.
6. **One scenario per orchestration run.** Don't interleave greenfield and maintenance phases against the same target in one session. If a target needs both (e.g., a build run that needs a `bun update` first), sequence them as two scenarios with a clean handoff in between.

## Gotchas

These bit earlier runs across all scenarios. Scenario-specific gotchas live in their reference.

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | Sub-agents don't inherit the CLAUDE.md chain | Orient block — global, workspace (if applicable), and project CLAUDE.md read before work |
| 2 | Sub-agents don't inherit the project skill registry | Orient block step 4 — `bun run list-skills` surfaces available skills, agent then reads task-specific ones by path |
| 3 | `git-mcp-server`'s `set_working_dir` state leaks across parallel sub-agents in the same orchestrator session | Bash `git` only in parallel sub-agents; reserve `git-mcp-server` for serial orchestrator use |
| 4 | Big work agents exhaust context before finishing — work lands on disk but the agent can't continue | Narrow scope per fanout; plan a finish-pass as the backstop in the scenario reference |
| 5 | Parallel agent self-reports describe intent, not always reality (claimed "pushed" but no remote ref exists) | Verify with read-only `git log --oneline -5`, `git ls-remote --tags origin`, `gh repo view` after every fanout that touched git |
| 6 | Independent agents diverge on incidental conventions (scoping, scripts, README hero) | Plan an explicit normalization pass; don't expect alignment for free |
| 7 | Sub-agent skips the orient block and proceeds with pattern-matched defaults | Put orient as a numbered prerequisite in the prompt with "Only after that, begin the task"; spot-check the first tool calls in the agent's response |
| 8 | Sub-agent runs `git stash` to "test something safely" | Restate the global rule verbatim in every sub-agent prompt that may touch git: "NEVER `git stash` for any reason." |

## Extending the pattern

When a new scenario emerges that's worth codifying (security-pass fanout across N servers, framework-wide migration, etc.), author a new reference at `references/<scenario>.md` and add a row to the table above. The reference should follow the shape of the existing two: scope, pre-flight, phase table, phase details, scenario-specific gotchas, checklist. The concepts/orient/rules/gotchas in this SKILL.md don't need to be restated — the reference assumes the reader started here.
