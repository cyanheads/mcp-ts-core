/**
 * @fileoverview Build-time stub for `@duckdb/node-api` in Cloudflare Worker
 * bundles. The DataCanvas DuckDB provider is Node/Bun-only — Workers never
 * execute it — but its lazy `import()` is statically reachable from the
 * worker entry, and esbuild cannot bundle DuckDB's native platform bindings.
 * Aliased in `wrangler.jsonc`; if a misconfigured Worker ever imports it at
 * runtime, the module-level throw rejects the import and surfaces through the
 * provider's lazy-load error handling.
 * @module examples/duckdb-stub
 */
throw new Error(
  '@duckdb/node-api is not available in Cloudflare Workers — DataCanvas requires Node or Bun.',
);

export {};
