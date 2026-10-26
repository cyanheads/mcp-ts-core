# Framework skills

Agent Skills for `@cyanheads/mcp-ts-core`. Each subdirectory contains a `SKILL.md` following the [Agent Skills specification](https://agentskills.io/specification).

The directory is `framework-skills/`, not `skills/`, on purpose. Claude Code and Codex auto-load a plugin's root `skills/`, and these are development-time skills for building a server — not skills for the agents that use one. A server keeps root `skills/` for that second kind: the skills it publishes (see [Published skills](#published-skills)).

## Three-Tier Distribution

Skills flow through three locations. Each tier has a distinct role:

| Tier | Location | Written by | Purpose |
|:-----|:---------|:-----------|:--------|
| 1. Package | `node_modules/@cyanheads/mcp-ts-core/framework-skills/` | `npm publish` / `bun publish` | Canonical source. Ships with the package. |
| 2. Project | `framework-skills/` (project root) | `@cyanheads/mcp-ts-core init` CLI | Project's source of truth. Committed to git. The server's own development-time skills live here too. |
| 3. Agent | `.claude/skills/`, `.codex/skills/`, etc. | The agent itself | Agent's working copy. Synced from project `framework-skills/`. Checklists are checked here. |

### Flow

```text
npm publish                    init CLI                    agent sync
[package framework-skills/] ──────────> [project framework-skills/] ──────────> [.claude/skills/]
                                     │
                                     ├── core skills (from package)
                                     └── server-specific development skills (added by devs)
```

Root `skills/` sits outside this flow: neither `init` nor the `maintenance` sync creates or modifies it.

## Audience

Each skill declares `metadata.audience` in its SKILL.md frontmatter:

- **`external`** — For consumers building MCP servers. Copied to project `framework-skills/` by `init`.
- **`internal`** — For core package developers. Stays in `node_modules`, not copied.

## Versioning

Skills declare `metadata.version` in frontmatter. The `maintenance` skill's Phase A compares versions after `bun update` and replaces a skill directory when the package version is newer; `init` only fills in what is missing and never overwrites an existing file. To pin a skill against those replacements, bump its local `metadata.version` above the package's.

## Adding Server-Specific Skills

Two kinds, two trees:

| Kind | Reader | Tree |
|:-----|:-------|:-----|
| Development-time — a project convention, a release step, a domain checklist | The agent working on the server's source | `framework-skills/<name>/` |
| Published — how to chain the server's tools, where its opaque IDs come from, gates before a wrong call | The agent that installed the server and calls its tools | `skills/<name>/` (project root) |

**Development-time.** Create a directory in `framework-skills/` with a `SKILL.md` in the same format, without `metadata.audience` — `external` marks framework-managed skills, which `maintenance` replaces and prunes. The agent picks it up on the next sync. Use the core skills as examples for structure and checklist conventions.

### Published skills

Root `skills/` holds the skills a server ships to the agents that use it: plugin hosts discover it, the MCPB bundle carries it, and `createApp({ skills: 'skills' })` serves it over MCP. The `add-skill` skill covers when one earns its place (usually it doesn't), how to write it, what `lint:packaging` checks, and how it is delivered.
