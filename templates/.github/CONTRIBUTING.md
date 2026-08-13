# Contributing

Thanks for using `{{PACKAGE_NAME}}`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

Open one from the **Issues** tab and pick the **Bug Report** or **Feature Request** form. Both are structured, and filling in the fields is what makes an issue actionable.

<!-- Optional: swap the line above for direct links once you know your repo URL —
     https://github.com/OWNER/REPO/issues/new?template=bug_report.yml -->

<!-- If you accept pull requests, say so here — e.g. "PRs welcome; open an issue
     first for anything larger than a typo." Silence reads as "issues only". -->

## Server bug or framework bug?

`{{PACKAGE_NAME}}` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry. Sorting out which layer broke saves everyone a round-trip:

- **This repo** — a tool returns wrong data, an upstream API call fails, a schema doesn't match reality, a description misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on a valid config, a `Context` method behaves contrary to its docs, transport or auth misbehaves regardless of which tool you call.

If you're not sure, file here and it'll get routed.

## Before filing

A few things that save a round-trip:

1. **Check you're on the latest release.** Fixes land on the current version.
2. **Search existing issues** before opening a new one. Add to the matching thread instead of filing a duplicate.
3. **Redact anything sensitive.** Issues are public and permanent — no API keys, tokens, auth headers, internal URLs, or PII in code, logs, or stack traces.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun / Node / Workers), and transport (stdio / HTTP).
- The tool, resource, or prompt involved, and the arguments you called it with.
- Actual vs expected behavior, verbatim: error messages and stack traces as they appeared.
- For features: the use case first, then the API as you'd want to call it.

## For agents

Do the triage first — an unverified report costs more to read than it saves to file.

Two workflows ship with this project:

- [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md) — filing against this repo.
- [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) — filing against `mcp-ts-core` when you've isolated the bug to the framework.

Read the relevant one before filing on a user's behalf.

## Security

Don't open a public issue for a vulnerability. Report it privately — GitHub's **Security** tab → **Report a vulnerability**, or email the maintainer.
