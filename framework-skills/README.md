# Framework skills

Agent Skills for `@cyanheads/mcp-ts-core`. Each subdirectory contains a `SKILL.md` following the [Agent Skills specification](https://agentskills.io/specification).

The directory is `framework-skills/`, not `skills/`, on purpose. Claude Code and Codex auto-load a plugin's root `skills/`, and these are development-time skills for building a server — not skills for the agents that use one. A server that ships a plugin manifest keeps `skills/` free for that second kind.

## Three-Tier Distribution

Skills flow through three locations. Each tier has a distinct role:

| Tier | Location | Written by | Purpose |
|:-----|:---------|:-----------|:--------|
| 1. Package | `node_modules/@cyanheads/mcp-ts-core/framework-skills/` | `npm publish` / `bun publish` | Canonical source. Ships with the package. |
| 2. Project | `framework-skills/` (project root) | `@cyanheads/mcp-ts-core init` CLI | Project's source of truth. Committed to git. Server-specific skills live here too. |
| 3. Agent | `.claude/skills/`, `.codex/skills/`, etc. | The agent itself | Agent's working copy. Synced from project `framework-skills/`. Checklists are checked here. |

### Flow

```text
npm publish                    init CLI                    agent sync
[package framework-skills/] ──────────> [project framework-skills/] ──────────> [.claude/skills/]
                                     │
                                     ├── core skills (from package)
                                     └── server-specific skills (added by devs)
```

## Audience

Each skill declares `metadata.audience` in its SKILL.md frontmatter:

- **`external`** — For consumers building MCP servers. Copied to project `framework-skills/` by `init`.
- **`internal`** — For core package developers. Stays in `node_modules`, not copied.

## Versioning

Skills declare `metadata.version` in frontmatter. The `maintenance` skill's Phase A compares versions after `bun update` and replaces a skill directory when the package version is newer; `init` only fills in what is missing and never overwrites an existing file. To pin a skill against those replacements, bump its local `metadata.version` above the package's.

## Adding Server-Specific Skills

Create a new directory in `framework-skills/` with a `SKILL.md` following the same format. The agent will pick it up on next sync. Use the core skills as examples for structure and checklist conventions.
