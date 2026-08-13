# Contributing

Hi, and thanks for using `@cyanheads/mcp-ts-core`! If you've hit a bug or want something the framework doesn't do yet, an issue is the most useful thing you can send. Let me know about any rough edge or new ideas.

Issues are the contribution path here: bugs, feature requests, and documentation gaps all land there, and code changes go through my workflows, so a precise issue with a reproduction is the fastest route to a fix.

- [Report a bug](https://github.com/cyanheads/mcp-ts-core/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/cyanheads/mcp-ts-core/issues/new?template=feature_request.yml)
- [Float an idea or ask a question](https://github.com/cyanheads/mcp-ts-core/issues/new) — free-form, no template, no need to be sure it's a bug first

The bug and feature forms are structured, and filling in the fields is what makes those actionable. Anything that fits neither can just be a plain issue — a half-formed idea in your own words is fine.

## Before filing

A few things that save a round-trip:

1. **Confirm it's the framework, not your server.** Reproduce with a minimal handler or standalone script, stripped of your own services and config. If the bug disappears in isolation, it's in server code.
2. **Check you're on the latest release.** `bun outdated @cyanheads/mcp-ts-core` — fixes land on the current version, older ones aren't patched.
3. **Search existing issues.** `gh issue list -R cyanheads/mcp-ts-core --search "<keyword>" --state all`. Add to the matching thread instead of opening a duplicate.
4. **Redact anything sensitive.** Issues are public and permanent — no keys, tokens, auth headers, internal URLs, or PII in code, logs, or stack traces.

## What makes an issue actionable

- Framework version, runtime (Bun / Node / Workers), and transport (stdio / HTTP / Worker).
- A minimal reproduction — real code, not a description of code.
- Actual vs expected behavior, verbatim: error messages and stack traces as they appeared.
- For features: the use case first, then the API as you'd want to call it.

## For agents

Use one of the two forms and do the triage first. The free-form path is for humans thinking out loud, not for skipping the checklist — an unverified report costs more to read than it saves to file.

The full workflow ships in the package: [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) — triage checklist, `gh` invocations with bodies that match the issue forms, title scopes, and label conventions. Read it before filing on a user's behalf.

## Security

Don't open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md) for private disclosure.
