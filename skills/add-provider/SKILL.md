---
name: add-provider
description: >
  Add a new storage or service provider to the core package. Use when implementing a new backend for StorageService (e.g., a new database) or a new service provider (e.g., a new LLM backend).
metadata:
  author: cyanheads
  version: "1.0"
  audience: internal
  type: reference
---

## Context

Providers implement interfaces defined in core. They are selected at runtime via config
(e.g., `STORAGE_PROVIDER_TYPE`). Tier 3 providers lazy-load their dependencies to keep the
core bundle small.

Providers live inside the package source tree — import the interface via relative path
(e.g., `import type { IStorageProvider } from '../core/IStorageProvider.js'`), not via the
package subpath exports (those are for consumers).

## Provider interfaces

| Domain  | Interface file                                    |
|:--------|:--------------------------------------------------|
| Storage | `src/storage/core/IStorageProvider.ts`            |
| LLM     | `src/services/llm/core/ILlmProvider.ts`           |
| Speech  | `src/services/speech/core/ISpeechProvider.ts`     |

Read the relevant interface fully before implementing — each has distinct required members.
`ISpeechProvider` in particular requires `readonly name`, `readonly supportsTTS`,
`readonly supportsSTT`, and `healthCheck()` in addition to the capability methods;
these flags drive routing in `SpeechService`.

## File conventions

Provider file location and naming differ by domain:

- **Storage** — nested subdirectory, camelCase directory name, PascalCase-suffixed provider file.
  Each provider gets its own subdirectory for the provider file plus any co-located types:
  `src/storage/providers/{{providerName}}/{{providerName}}Provider.ts`
  (e.g., `src/storage/providers/inMemory/inMemoryProvider.ts`,
  `src/storage/providers/supabase/supabaseProvider.ts` + `supabase.types.ts`)

- **LLM / Speech** — flat directory, kebab-case with `.provider.ts` suffix:
  `src/services/llm/providers/{{provider-name}}.provider.ts`
  `src/services/speech/providers/{{provider-name}}.provider.ts`
  (e.g., `src/services/llm/providers/openrouter.provider.ts`,
  `src/services/speech/providers/elevenlabs.provider.ts`)

## Steps

1. **Identify the provider interface** — read the interface file for the target domain
   (see table above).
2. **Create the provider file** following the file convention for its domain (see above).
3. **Implement the interface** — all methods must be implemented.
4. **Lazy-load dependencies** if Tier 3:

   ```typescript
   let _client: SomeClient | undefined;
   async function getClient(): Promise<SomeClient> {
     if (!_client) {
       const { SomeClient } = await import('some-package');
       _client = new SomeClient(/* config */);
     }
     return _client;
   }
   ```

5. **Register the provider** — the registration point differs by domain:

   - **Storage** — two changes required:
     1. Add the new provider string to the `z.enum` for `STORAGE_PROVIDER_TYPE` in
        `src/config/index.ts` — without this, the config schema rejects the env var at runtime.
     2. Add a `case` to the `switch` in `src/storage/core/storageFactory.ts`
        inside `createStorageProvider()`. Import the new provider class at the top of that file.

   - **Speech** — two changes required:
     1. Add the new provider string literal to the `provider` union in
        `SpeechProviderConfig` (`src/services/speech/types.ts`, field `provider`).
     2. Add a `case` to the `switch` in `createSpeechProvider()`
        (`src/services/speech/core/SpeechService.ts`). Import the new provider class at
        the top of that file.

   - **LLM** — currently only one provider exists (`OpenRouterProvider`); it is
     instantiated directly in `src/core/app.ts` rather than through a factory switch.
     There is no factory pattern yet — adding a second provider requires introducing
     one (a selector env var, a factory function, and a conditional in `app.ts`).
     Read `src/core/app.ts` to understand the current instantiation site before
     designing the wiring.

6. **Update the Worker-compatible provider list** if the new storage provider runs in
   Cloudflare Workers. The list is an inline array in `storageFactory.ts` at the
   `isServerless()` guard:

   ```typescript
   // src/storage/core/storageFactory.ts ~line 112
   !['in-memory', 'cloudflare-r2', 'cloudflare-kv', 'cloudflare-d1'].includes(providerType)
   ```

   Add the new provider string to this array. Non-storage providers have no equivalent
   gate.

7. **Add the dependency** if Tier 3: add to both `peerDependencies` and
   `peerDependenciesMeta` (with `{ "optional": true }`) in `package.json`.
   Without the `peerDependenciesMeta` entry, the dep appears required rather than optional.
8. **Run `bun run rebuild`** — since this is package source, verify the build output compiles.
9. **Run `bun run devcheck`** to verify.

## Checklist

- [ ] Provider file created with JSDoc `@fileoverview` + `@module` header
- [ ] Interface fully implemented (including `name`, `supportsTTS`/`supportsSTT` for speech)
- [ ] Tier 3 dependencies lazy-loaded (not top-level imports)
- [ ] Registered in the correct factory for the domain (see Step 5)
- [ ] Storage: provider string added to `z.enum` in `src/config/index.ts`
- [ ] Storage: Worker-compatible array in `storageFactory.ts` updated if applicable
- [ ] Speech: `provider` literal added to `SpeechProviderConfig` union in `types.ts`
- [ ] LLM: `src/core/app.ts` instantiation logic updated if adding a second LLM provider
- [ ] Optional peer dependency added to both `peerDependencies` and `peerDependenciesMeta` in `package.json` if Tier 3
- [ ] `bun run rebuild` succeeds
- [ ] `bun run devcheck` passes
- [ ] Test file created at `src/storage/providers/{{name}}/{{name}}Provider.test.ts` (or equivalent path for the domain) and `bun run test` passes
