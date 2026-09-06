/**
 * @fileoverview Root runtime suites with retention and natural-worker-exit checks on real Node.
 * @module tests/config/vitest.leaks
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import rootConfig from '../../vitest.config.js';
import { naturalExitPool } from '../leaks/harness/pool.js';

const repoRoot = resolve(import.meta.dirname, '../..');

const projects = rootConfig.test?.projects;
if (!projects?.length) throw new Error('Leak gate requires the root test projects');

/** The gate's own self-test drives this very config; running it here would recurse. */
const selected = projects.filter(
  (project) =>
    typeof project !== 'object' || !('test' in project) || project.test?.name !== 'leak-gate',
);

export default defineConfig({
  ...rootConfig,
  root: repoRoot,
  test: {
    ...rootConfig.test,
    coverage: { enabled: false },
    reporters: ['default', './tests/leaks/harness/reporter.ts'],
    runner: './tests/leaks/harness/runner.ts',
    execArgv: ['--expose-gc'],
    projects: selected.map((project) => {
      if (typeof project !== 'object' || !('test' in project)) return project;
      return { ...project, test: { ...project.test, pool: naturalExitPool } };
    }),
  },
});
