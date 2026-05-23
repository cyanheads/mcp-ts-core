---
name: release-and-publish
description: >
  Ship a release end-to-end across every registry the project targets (npm, MCP Registry, GitHub Releases for `.mcpb` bundles, GHCR). Runs the final verification gate, pushes commits and tags, then publishes to each applicable destination. Assumes git wrapup (version bumps, changelog, commit, annotated tag) is already complete — this skill is the post-wrapup publish workflow. Retries transient network failures on publish steps; halts with a partial-state report when retries are exhausted or the failure is terminal.
metadata:
  author: cyanheads
  version: "2.5"
  audience: external
  type: workflow
---

## Preconditions

This skill runs **after** git wrapup. By the time it's invoked:

- Pre-wrapup verification is done (`field-test`, `security-pass`, `polish-docs-meta` as applicable)
- `package.json` version is bumped
- `changelog/<major.minor>.x/<version>.md` is authored
- `CHANGELOG.md` is regenerated
- README and every version-bearing file is in sync
- Release commit (`chore: release v<version>`) exists
- Annotated tag (`v<version>`) exists locally
- Working tree is clean

If any are missing, halt and tell the user to finish wrapup first. Do not attempt to redo wrapup work from inside this skill.

## Failure Protocol

Steps 3–7 are network-bound. For those, **retry transient failures up to 2 times** with short backoff (~5 s before the first retry, ~15 s before the second) before halting. All other steps halt on the first non-zero exit — they're deterministic and a second attempt won't change the outcome.

### Retry on transient patterns

Match stderr (case-insensitive) against any of these — if matched, the failure is almost always a network blip; retry:

- `integrity check failed` / `IntegrityCheckFailed` — corrupt tarball during download
- `ECONNRESET` / `EAI_AGAIN` / `ETIMEDOUT` / `ENOTFOUND` — network layer
- `connection reset` / `connection refused` — transport blip
- `timed out` / `request timeout` — server or network timeout
- HTTP `502` / `503` / `504` — transient registry error

**Before retrying `docker buildx --push` (step 7)**, run `docker builder prune -f` to drop any cached corrupt layer. Skip this extra step for other retries.

### Never retry on idempotent-success signals

These mean the step already succeeded on a prior run — treat as success and proceed to the next step:

- npm (`bun publish`): `version already exists`, `You cannot publish over the previously published versions`
- MCP Registry (`mcp-publisher publish`): `cannot publish duplicate version`
- GitHub Release (`gh release create`): `release already exists` — fall back to `gh release upload --clobber` (see step 6)

### Halt fallback

If retries are exhausted, or the failure matches none of the transient patterns, halt and report:

1. Which step failed
2. The exact error output
3. Retry count attempted (0 for terminal errors, 2 for exhausted retries)
4. Which destinations already received the release (npm published? tag pushed? MCP Registry? GitHub Release with `.mcpb`? GHCR?) — the partial state across destinations

The user fixes locally and re-invokes. On re-invocation, already-published destinations hit the idempotent-success signal and skip naturally — no manual step-skipping required.

## Steps

### 1. Sanity-check wrapup outputs

Read `package.json` → capture `version`. Then use your git tools to verify:

- **Working tree is clean** — no uncommitted changes
- **HEAD is tagged `v<version>`** — matches the `package.json` version
- **Current branch name** — note it for step 3

If working tree is dirty or HEAD isn't on `v<version>`, halt.

### 2. Run the verification gate

All three must succeed. Use `test:all` if the script exists in `package.json`, otherwise fall back to `test`:

```bash
bun run devcheck
bun run rebuild
bun run test:all        # or `bun run test` if no test:all
```

Any non-zero exit → halt with the failing command's output.

### 3. Push to origin

Use your git tools to push commits and tags to origin. If the remote rejects either push, halt.

### 4. Publish to npm

```bash
bun publish --access public
```

`bun publish` uses whatever npm auth the user has configured in `~/.npmrc`. If 2FA is enabled on the npm account, the command will prompt for an OTP or open a browser — that's expected; the user completes it interactively.

**Friction reducers (optional, configure once):**

| Option | How |
|:--|:--|
| **npm granular access token** with "Bypass 2FA for publish" | Generate at npmjs.com → replace `_authToken` in `~/.npmrc` → no OTP prompt at all |
| **1Password CLI TOTP injection** (requires `brew install --cask 1password-cli` + signed-in `op`) | `bun publish --access public --otp="$(op item get 'npm' --otp)"` |

Halt on publish error other than "version already exists" (which means this step already ran).

### 5. Publish to MCP Registry

Only if `server.json` exists at the repo root (otherwise skip).

```bash
bun run publish-mcp
```

If `publish-mcp` isn't defined in `package.json`, add it (macOS):

```json
"publish-mcp": "mcp-publisher login github -token \"$(security find-generic-password -a \"$USER\" -s mcp-publisher-github-pat -w)\" && mcp-publisher publish"
```

Prereq: a GitHub PAT with `read:org` + `read:user` scopes stored in Keychain under the service name `mcp-publisher-github-pat`:

```bash
security add-generic-password -a "$USER" -s mcp-publisher-github-pat -w
# paste PAT at the silent prompt
```

Halt on any publisher error other than "cannot publish duplicate version".

### 6. Attach MCPB bundle to GitHub Release

Only if `manifest.json` exists at the repo root (otherwise skip).

Build the bundle, then create a Release on the existing annotated tag and attach the `.mcpb`. The Release sits on top of the tag from wrapup — `--verify-tag` enforces that the tag already exists on the remote and prevents `gh` from creating a lightweight tag that would shadow the annotated one. `--notes-from-tag` pulls release notes directly from the annotated tag message (no duplication). Note: GitHub prepends `v<VERSION>:` to the release title, so the tag annotation subject must omit the version number to avoid stutter.

```bash
bun run bundle              # produces dist/<name>.mcpb (stable filename, no version)
gh release create v<VERSION> --verify-tag --notes-from-tag dist/*.mcpb
```

The stable filename matters: it lets the README "Install in Claude Desktop" badge point at `releases/latest/download/<name>.mcpb` and always resolve to the most recent release. The `bundle` script in the templates outputs `dist/{{PACKAGE_NAME}}.mcpb` for this reason.

If the release already exists (re-invocation after a prior partial run), `gh release create` exits with "release already exists" — fall back to uploading the asset to the existing release:

```bash
gh release upload v<VERSION> dist/*.mcpb --clobber
```

Deterministic download URLs:

- Pinned to this version: `https://github.com/<OWNER>/<REPO>/releases/download/v<VERSION>/<name>.mcpb`
- Always latest (powers the install badge): `https://github.com/<OWNER>/<REPO>/releases/latest/download/<name>.mcpb`

If `server.json` includes an MCPB `packages[]` entry, its `identifier` should match this URL and `fileSha256` should match `shasum -a 256 <bundle>` — keep these in sync during wrapup, not here.

Halt on any error other than "release already exists" (handled via the upload fallback above).

### 7. Publish Docker image

Only if `Dockerfile` exists at the repo root (otherwise skip).

Derive:

- `OWNER/REPO` from the origin remote URL — use your git tools to read it; strip `.git`, handle both `https://github.com/<owner>/<repo>` and `git@github.com:<owner>/<repo>` forms
- `VERSION` from `package.json` (step 1)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<OWNER>/<REPO>:<VERSION> \
  -t ghcr.io/<OWNER>/<REPO>:latest \
  --push .
```

If the project uses a non-GHCR registry or a custom image name, respect the project's convention. Halt on build or push failure.

### 8. Report the deployed artifacts

Print clickable URLs for every destination that succeeded:

- npm: `https://www.npmjs.com/package/<package.json#name>/v/<version>`
- MCP Registry: `https://registry.modelcontextprotocol.io/v0/servers?search=<package.json#mcpName>`
- GitHub Release: `https://github.com/<OWNER>/<REPO>/releases/tag/v<VERSION>` (with `.mcpb` asset attached)
- GHCR: `ghcr.io/<OWNER>/<REPO>:<VERSION>`

Skip any destination that was skipped in its step.

## Checklist

- [ ] Working tree clean; HEAD tagged `v<version>`
- [ ] `bun run devcheck` passes
- [ ] `bun run rebuild` succeeds
- [ ] `bun run test:all` (or `test`) passes
- [ ] Commits pushed to origin
- [ ] Tags pushed to origin
- [ ] `bun publish --access public` succeeds
- [ ] `bun run publish-mcp` succeeds (if `server.json` present)
- [ ] `bun run bundle` + `gh release create --verify-tag --notes-from-tag` succeeds (if `manifest.json` present)
- [ ] Docker buildx multi-arch push succeeds (if `Dockerfile` present)
- [ ] Deployed artifact URLs reported to the user
