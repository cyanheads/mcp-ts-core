# Client contract lane

`bun run test:contract` pins what an MCP client receives from the framework.
The pinned payloads are the advertised lists, the handshake, and the outcome of a
fixed matrix of tool calls. They live as committed files under `pins/`, so a change
an existing client would notice fails the lane until someone reviews the diff
and accepts it. The lane is a root Vitest project, so it also runs in `test`,
`test:coverage` (Bun), and `test:node` / `test:order` (Node 24). The pins are
byte-identical on both runtimes.

Two definition sets are served through `createMcpServerInstance` and the real
registries, as `createApp` serves them:

- **Templates.** The shipped `templates/` definitions, loaded as written. The
  `contract` project maps `@cyanheads/mcp-ts-core` to `src/`, so they build on
  the code under test rather than on `dist/`.
- **Purpose fixtures.** One definition per schema feature a client can see.
  `fixtures.ts` also holds the argument matrix.

| Pin | What it holds |
|:--|:--|
| `templates.2025-11-25.json5`, `purpose.2025-11-25.json5` | `initialize` and the four lists on 2025-11-25, plus how 2025-03-26 and 2025-06-18 differ (today: the negotiated version only) |
| `eras.2026-07-28.json5`, `eras.calls.2026-07-28.json5` | `server/discover`, and how each list, cacheable read, and matrix call on 2026-07-28 differs from 2025-11-25 |
| `validation.defaults.json5`, `validation.switches-off.json5` | Each matrix call either accepted, with the arguments the handler received, or rejected, with its envelope. Run with the pre-validation stages on, then off |
| `calls.templates.json5` | Responses from the template tool, prompt, and resources |

Everything is read off the wire: raw JSON-RPC for 2025-era sessions, and the HTTP
app's `request()` for 2026-07-28. Nothing is read through the SDK `Client`,
whose result parsing drops keys the server sent.

Before writing a pin, the lane normalises it:

- Object keys are sorted recursively, because the two revisions' codecs emit
  the same payload in different key orders. Arrays keep their order.
- Every request id becomes `<requestId>`.
- The server identity is fixed at `contract-fixture@0.0.0`, so a release does
  not rewrite the pins.
- The app view's HTML is left out of the pins.
- In the matrix, Zod issues keep only their code and path; the message text the
  client reads is still pinned verbatim.

The files hold plain JSON. They use the `.json5` extension because Biome formats
`.json` and would rewrite the layout.

A missing pin fails and a changed pin fails, both locally and under `CI=true`.
The root config sets `update: 'none'`. Without it, Vitest's local default writes
a missing snapshot and passes, so a deleted pin would come back unreviewed.

To accept a change, run `bun run test:contract -u`, review
`git diff tests/contract/pins`, and commit the pins with the change that moved
them. A new pin must also be listed in `PINS` (`harness.ts`).
`pins.test.ts` fails on any file in `pins/` the suite does not write. Vitest
never reports a file snapshot as obsolete, so nothing else would catch a stale one.

Pins characterise current behaviour, known issues included. When a filed fix
changes a pin, it lands with a reviewed `-u`. Zod and SDK upgrades can also
move pins: JSON Schema emission, envelope keys, the SDK's own error text. Those
diffs are client-visible too, so review them the same way.
