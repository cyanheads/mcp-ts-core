#!/usr/bin/env node
/**
 * @fileoverview MCPB packaging linter — validates env var alignment between
 * `manifest.json` (MCPB bundle install UX) and `server.json` (MCP Registry
 * discovery) for stdio packages.
 *
 * Used by devcheck and as a standalone script: `bun run lint:packaging` /
 * `npm run lint:packaging`.
 *
 * Checks:
 *   1. Manifest `name` must not contain a scope prefix (`@scope/`).
 *   2. Every `user_config` entry must include `title` and `type` fields.
 *   3. Every `${user_config.X}` reference in manifest `mcp_config.env` must
 *      appear in server.json stdio `environmentVariables[]` (the registry
 *      advertises the configurable knob the bundle surfaces).
 *   4. Every required stdio env var in server.json (no default) must appear
 *      as a key in manifest `mcp_config.env` (the bundle can receive it).
 *
 * Checks 1–2 run with `manifest.json` alone; 3–4 require `server.json`.
 *
 * Skips cleanly when `manifest.json` is absent — consumers who deleted it for
 * an HTTP-only deploy should not fail this check.
 *
 * @module scripts/lint-packaging
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ServerJsonEnvVar {
  default?: string;
  isRequired?: boolean;
  name: string;
}

interface ServerJsonPackage {
  environmentVariables?: ServerJsonEnvVar[];
  transport?: { type?: string };
}

interface ServerJson {
  packages?: ServerJsonPackage[];
}

interface ManifestUserConfigEntry {
  title?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

interface Manifest {
  name?: string;
  server?: { mcp_config?: { env?: Record<string, string> } };
  user_config?: Record<string, ManifestUserConfigEntry>;
}

const USER_CONFIG_REF = /^\$\{user_config\.([\w-]+)\}$/;

function tryReadJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    return;
  }
}

function main(): void {
  const manifestPath = resolve('manifest.json');
  if (!existsSync(manifestPath)) {
    console.log('No manifest.json — skipping lint:packaging.');
    process.exit(0);
  }

  const manifest = tryReadJson<Manifest>(manifestPath);
  if (!manifest) {
    console.error('manifest.json is unreadable or malformed.');
    process.exit(1);
  }

  const errors: string[] = [];

  if (manifest.name?.includes('/')) {
    errors.push(
      `manifest.json "name" contains a scope prefix ("${manifest.name}") — use the bare package name (e.g. "${manifest.name.split('/').pop()}")`,
    );
  }

  const userConfig = manifest.user_config ?? {};
  for (const [key, entry] of Object.entries(userConfig)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const missing = (['title', 'type'] as const).filter(
      (f) => typeof entry[f] !== 'string' || (entry[f] as string).length === 0,
    );
    if (missing.length > 0) {
      errors.push(
        `manifest.json user_config["${key}"] is missing required field(s): ${missing.join(', ')} — mcpb pack will reject this`,
      );
    }
  }

  const serverJson = tryReadJson<ServerJson>(resolve('server.json'));
  if (serverJson) {
    const manifestEnv = manifest.server?.mcp_config?.env ?? {};
    const manifestEnvKeys = new Set(Object.keys(manifestEnv));

    const manifestUserConfigKeys = new Set(
      Object.entries(manifestEnv)
        .filter(([, v]) => typeof v === 'string' && USER_CONFIG_REF.test(v))
        .map(([k]) => k),
    );

    const stdioEnvVars = (serverJson.packages ?? [])
      .filter((p) => p.transport?.type === 'stdio')
      .flatMap((p) => p.environmentVariables ?? []);
    const stdioEnvNames = new Set(stdioEnvVars.map((v) => v.name));
    const requiredStdioEnvNames = new Set(
      stdioEnvVars.filter((v) => v.isRequired === true && v.default == null).map((v) => v.name),
    );

    const missingInServerJson = [...manifestUserConfigKeys].filter((k) => !stdioEnvNames.has(k));
    const missingInManifest = [...requiredStdioEnvNames].filter((k) => !manifestEnvKeys.has(k));

    if (missingInServerJson.length > 0) {
      errors.push(
        `manifest.json references user_config env var(s) not advertised in server.json stdio environmentVariables[]: ${missingInServerJson.join(', ')}`,
      );
    }
    if (missingInManifest.length > 0) {
      errors.push(
        `server.json declares required stdio env var(s) without default missing from manifest.json mcp_config.env: ${missingInManifest.join(', ')}`,
      );
    }
  }

  if (errors.length === 0) {
    console.log('Packaging alignment OK.');
    process.exit(0);
  }
  for (const err of errors) console.error(`  ✗ ${err}`);
  process.exit(1);
}

main();
