#!/usr/bin/env node
/**
 * @fileoverview MCPB packaging linter — validates env var alignment between
 * `manifest.json` (MCPB bundle install UX) and `server.json` (MCP Registry
 * discovery) for stdio packages, and guards against bundle-content mistakes.
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
 *   5. Bundle-content guard: known root dev directories must not appear at
 *      bundle root after `.mcpbignore` evaluation (dev dir not excluded).
 *   6. Bundle-content guard: `.mcpbignore` must not use unanchored patterns
 *      for root dev dirs — an unanchored `skills/` also strips
 *      `node_modules/x/skills/` (runtime path bypass, issues #172/#207).
 *   7. Bundle-content guard: `.mcpbignore` patterns must not strip critical
 *      runtime package paths (e.g. `node_modules/@opentelemetry/api/build/src/`).
 *
 * Checks 1–2 run with `manifest.json` alone; 3–4 require `server.json`.
 * Checks 5–7 run when `.mcpbignore` is present (silently skip otherwise).
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

/**
 * Root dev directories the scaffold template excludes from the bundle, and
 * whose `.mcpbignore` patterns must be anchored with `/` to avoid also
 * stripping nested runtime paths like `node_modules/x/skills/`. Keep in step
 * with the directory entries in `templates/_.mcpbignore`.
 */
const KNOWN_DEV_DIRS = ['skills/', '.agents/', '.claude/'];

/**
 * Critical runtime paths that must NOT be stripped by any `.mcpbignore` pattern.
 * These are sampled representative paths — enough to catch a bare `skills/`
 * pattern accidentally stripping `node_modules/…/skills/`.
 */
const CRITICAL_RUNTIME_PATHS = [
  'node_modules/@opentelemetry/api/build/src/',
  'node_modules/@modelcontextprotocol/sdk/dist/',
  'node_modules/@cyanheads/mcp-ts-core/dist/',
  'dist/index.js',
];

function tryReadJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    return;
  }
}

/**
 * Run bundle-content checks (5–7) against the .mcpbignore patterns.
 *
 * Uses the `ignore` package (already a devDependency in scaffolded servers)
 * to evaluate which paths survive the ignore rules. Returns an array of error
 * strings; empty means all checks passed.
 *
 * **Context note:** this guard runs inside the scaffolded server project, not
 * inside mcp-ts-core itself. `ignore` is listed in `templates/package.json`
 * devDependencies (`^7.0.5`) and is therefore available in the server's
 * `node_modules` when `bun run lint:packaging` is invoked there.
 */
async function checkBundleContent(mcpbignorePath: string): Promise<string[]> {
  const errors: string[] = [];

  let createIgnore: typeof import('ignore')['default'];
  try {
    // Dynamic import so the rest of the linter still runs when `ignore` is absent.
    createIgnore = ((await import('ignore')) as typeof import('ignore')).default;
  } catch {
    // `ignore` not installed — skip the guard without failing (e.g. in a minimal
    // CI environment that omits devDependencies).
    return errors;
  }

  const raw = readFileSync(mcpbignorePath, 'utf-8');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const ig = createIgnore().add(lines);

  // Check 5: dev dirs must be excluded at bundle root.
  for (const dir of KNOWN_DEV_DIRS) {
    const probe = `${dir}README.md`;
    if (!ig.ignores(probe)) {
      errors.push(
        `.mcpbignore does not exclude root dev directory "${dir}" — ` +
          `bundle will include dev files. Add a pattern like "/${dir}" to exclude it.`,
      );
    }
  }

  // Check 6: unanchored dev-dir patterns also strip runtime paths inside
  // node_modules. Any pattern that excludes a known dev dir must be anchored
  // (leading "/") so it only matches at root.
  for (const dir of KNOWN_DEV_DIRS) {
    // Strip trailing slash for the node_modules probe path.
    const name = dir.replace(/\/$/, '');
    const runtimeProbe = `node_modules/some-pkg/${name}/index.js`;
    if (ig.ignores(runtimeProbe)) {
      // Find the offending pattern.
      const offending = lines.filter((p) => {
        try {
          return createIgnore().add([p]).ignores(runtimeProbe);
        } catch {
          return false;
        }
      });
      errors.push(
        `.mcpbignore uses an unanchored pattern that also strips runtime paths under node_modules: ` +
          `[${offending.join(', ')}]. Use a leading "/" to anchor to root (e.g. "/${dir}").`,
      );
    }
  }

  // Check 7: no pattern should strip critical runtime paths.
  for (const critPath of CRITICAL_RUNTIME_PATHS) {
    if (ig.ignores(critPath)) {
      const offending = lines.filter((p) => {
        try {
          return createIgnore().add([p]).ignores(critPath);
        } catch {
          return false;
        }
      });
      errors.push(
        `.mcpbignore pattern(s) [${offending.join(', ')}] would strip critical runtime path ` +
          `"${critPath}" — add a leading "/" to anchor to root (e.g. "/${offending[0] ?? '?'}").`,
      );
    }
  }

  return errors;
}

async function main(): Promise<void> {
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

  // Bundle-content guard (checks 5–7).
  const mcpbignorePath = resolve('.mcpbignore');
  if (existsSync(mcpbignorePath)) {
    const bundleErrors = await checkBundleContent(mcpbignorePath);
    errors.push(...bundleErrors);
  }

  if (errors.length === 0) {
    console.log('Packaging alignment OK.');
    process.exit(0);
  }
  for (const err of errors) console.error(`  ✗ ${err}`);
  process.exit(1);
}

await main();
