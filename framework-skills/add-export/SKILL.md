---
name: add-export
description: >
  Add a new subpath export to the @cyanheads/mcp-ts-core package. Use when creating a new public API surface that consumers import from a dedicated subpath (e.g., @cyanheads/mcp-ts-core/newutil).
metadata:
  author: cyanheads
  version: "1.2"
  audience: internal
  type: reference
---

## Context

Subpath exports are defined in `package.json` under the `exports` field. Each subpath maps to a source entry point that gets compiled to `dist/`. The exports catalog in `CLAUDE.md`/`AGENTS.md` must stay in sync with `package.json`.

The build uses `tsconfig.build.json` (not `tsconfig.json`) with `rootDir: ./src` and `include: ["src/**/*"]`. This means every source file at `src/foo/bar.ts` compiles to `dist/foo/bar.js` — the `dist/` path in each export entry must match wherever `tsc` produces the compiled output for the named source file. Choose your source file location to produce the `dist/` path you want in the export entry.

## Steps

1. **Create the entry point** source file under `src/` (e.g., `src/utils/new-util.ts`)
2. **Add the subpath** to `package.json` `exports`, mirroring the source path:

   ```jsonc
   // source: src/utils/new-util.ts → dist: dist/utils/new-util.js
   "./newutil": {
     "types": "./dist/utils/new-util.d.ts",
     "import": "./dist/utils/new-util.js"
   }
   ```

3. **Update the exports catalog** in both `CLAUDE.md` and `AGENTS.md` — add a row to the table. These files must stay byte-identical; the simplest approach is `cp CLAUDE.md AGENTS.md` after editing
4. **Regenerate the public API manifest** — `bun run scripts/public-api-contract-update.ts` rewrites `PUBLIC_RUNTIME_EXPORTS` in `scripts/public-api-contract.ts` from the live barrels; never edit it by hand
5. **Verify** with `bun run devcheck` and `bun run test:package` — the package lane builds, packs, installs, and imports every subpath in the manifest, so a wrong `dist/` path or a missing export fails there

## Naming conventions

| Convention | Rule |
|:-----------|:-----|
| Subpath | all-lowercase, no underscores (e.g., `utils`, `storage/types`, `testing/fuzz`) |
| Source file | kebab-case (e.g., `error-handler.ts`) |
| Export name | camelCase for values, PascalCase for types |

## Checklist

- [ ] Source entry point file created with JSDoc header
- [ ] Subpath added to `package.json` `exports` with `types` and `import` conditions
- [ ] Exports catalog updated in both `CLAUDE.md` and `AGENTS.md` (must be byte-identical)
- [ ] If the new export has optional peer dependencies: entries added to both `peerDependencies` and `peerDependenciesMeta` in `package.json`
- [ ] Public API manifest regenerated with `bun run scripts/public-api-contract-update.ts`
- [ ] `bun run devcheck` passes
- [ ] `bun run test:package` passes
