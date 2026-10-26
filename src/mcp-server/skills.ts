/**
 * @fileoverview A server's published skills (root `skills/`) over MCP through
 * the SEP-2640 Skills extension, and the strict tree check build-time tooling
 * runs before shipping one. The only module that imports
 * `@modelcontextprotocol/server/ext/skills*`: the extension's wiring is
 * `@experimental` upstream, so an SDK change lands here and nowhere else. The
 * folder loader (`ext/skills/node`) is imported dynamically, so a Worker that
 * serves a record never evaluates `node:fs`.
 * @module src/mcp-server/skills
 */
import { isAbsolute, resolve } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import {
  memorySkillFiles,
  SKILLS_EXTENSION_ID,
  type SkillCatalog,
  SkillCatalogError,
  SkillsExtension,
} from '@modelcontextprotocol/server/ext/skills';

import { resolveAppRoot } from '@/config/appRoot.js';
import { configurationError } from '@/types-global/errors.js';

/** Paths under the skills folder (`<skill>/SKILL.md`, `<skill>/references/x.md`) mapped to file contents. */
export type SkillFilesRecord = Record<string, string | Uint8Array>;

/** One problem in a skill tree: `path` names the file or folder relative to the tree root (`.` for the root). */
export interface SkillProblem {
  message: string;
  path: string;
}

/** A catalog loaded once per process and attached to every server instance it serves. */
export interface ServedSkills {
  /** Serves the catalog on `server`. Runs before the server connects. */
  attach(server: McpServer): void;
  /** The capability the extension declares, keyed by extension ID — what the server card advertises. */
  readonly extensions: Record<string, object>;
  /** The `name` of every skill served, in catalog (URI) order. */
  readonly names: readonly string[];
}

/**
 * Loads a skill catalog for serving: a folder of skill folders, resolved against
 * the application root when relative (`process.cwd()`, which for an `npx` stdio
 * launch is the client's project, only when no application root is found — the
 * `LOGS_DIR` rule), or a record of paths to contents.
 *
 * Non-strict: a skill the SDK rejects is skipped and reported through
 * `onWarning`, so a validation rule tightened in a floating SDK minor drops
 * that skill rather than the server. `validateSkillTree` is the strict gate.
 *
 * @throws {McpError} `ConfigurationError` when the folder is missing or
 * unreadable (the message and `data.skillsPath` name the resolved path), or the
 * record holds a path that leaves the tree.
 */
export async function loadServedSkills(
  source: string | SkillFilesRecord,
  onWarning: (problem: SkillProblem) => void,
): Promise<ServedSkills> {
  const options = { strict: false, onWarning } as const;
  let catalog: SkillCatalog;
  if (typeof source === 'string') {
    if (source.trim() === '') {
      throw configurationError(
        'skills must name a folder of skill folders, such as "skills"; an empty path would serve the whole application root.',
      );
    }
    const skillsPath = isAbsolute(source)
      ? source
      : resolve(resolveAppRoot()?.dir ?? process.cwd(), source);
    const { loadSkills } = await import('@modelcontextprotocol/server/ext/skills/node');
    catalog = await loadSkills(skillsPath, options).catch((err: unknown) => {
      throw storageFailure(err, `Skills folder ${skillsPath}`, { skillsPath });
    });
  } else {
    catalog = await SkillsExtension.load(memorySkillFiles(source), options).catch(
      (err: unknown) => {
        throw storageFailure(err, 'The skills record', {});
      },
    );
  }

  return {
    attach: (server) => catalog.attach(server),
    extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } },
    names: catalog.entries.map((entry) => entry.frontmatter.name),
  };
}

/**
 * Non-strict loading throws only when storage fails — a folder that cannot be
 * listed or a file that cannot be read — so every `SkillCatalogError` here ends
 * startup. Anything else is not the SDK's catalog error and passes through.
 */
function storageFailure(err: unknown, subject: string, data: Record<string, unknown>): unknown {
  if (!SkillCatalogError.isInstance(err)) return err;
  const problems = err.problems.map(({ path, message }) => ({ path, message }));
  return configurationError(
    `${subject} cannot be served: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')}. Create it with one folder per skill, or remove the skills option.`,
    { ...data, problems },
    { cause: err },
  );
}

/**
 * Checks a skill tree the way the MCP SDK's strict loader does
 * (`loadSkills(root, { strict: true })`) — the Agent Skills frontmatter rules,
 * the SDK's YAML subset, symlinks, per-skill size limits, and a `SKILL.md`
 * directly under `root`. A tree that returns no problems is served whole by
 * {@link loadServedSkills} on the same SDK version.
 *
 * `root` resolves against `process.cwd()` when relative. The SDK's advisory
 * warnings (no skills found, a lowercase `skill.md`) are not problems and are
 * not returned.
 *
 * @returns Every problem strict loading reports, in the SDK's order; empty when the tree passes.
 */
export async function validateSkillTree(root: string): Promise<SkillProblem[]> {
  const { loadSkills } = await import('@modelcontextprotocol/server/ext/skills/node');
  try {
    await loadSkills(root, { strict: true, onWarning: () => {} });
    return [];
  } catch (err) {
    if (!SkillCatalogError.isInstance(err)) throw err;
    return err.problems.map(({ path, message }) => ({ path, message }));
  }
}
