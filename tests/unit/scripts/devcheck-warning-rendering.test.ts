/**
 * @fileoverview Tests devcheck's per-step running-log rendering (issue #344).
 * `UI.formatCheckResult` read `exitCode` alone, so a step whose `isSuccess`
 * demoted a non-zero exit to a warning printed `✅ … finished successfully`
 * while the summary printed `⚠️  WARNING` for the same result — two surfaces
 * disagreeing about one outcome. Three steps can demote (Skills Sync, Skill
 * Versions, and both of Security Audit's paths), so the rendering is keyed on
 * `printSummary`'s own guard rather than on any one step.
 *
 * `devcheck.ts` resolves its project root from the SCRIPT location, so the
 * scaffold is a temp project carrying the copied script plus stubs for the
 * checkers it shells out to — a real drift condition cannot be conjured on
 * demand. `Skill Versions` demotes every non-zero exit, so the undemoted
 * failure is asserted through `MCP Definitions`, which declares no `isSuccess`.
 *
 * @module tests/unit/scripts/devcheck-warning-rendering.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

const WARNING_MESSAGE = 'demo: SKILL.md body changed without a metadata.version bump';

/**
 * `Skill Versions`' demotion, anchored on its own default message so the
 * identically-shaped return in `Skills Sync` is not the one rewritten.
 */
const SKILL_VERSIONS_DEMOTION =
  "'Skill bodies changed without a version bump.';\n      return { success: true, warning: firstLine };";

/** The `isSuccess` shape no shipped step produces today, but the renderer must handle. */
const SKILL_VERSIONS_FAILURE_WITH_WARNING = SKILL_VERSIONS_DEMOTION.replace(
  'success: true',
  'success: false',
);

/** A stub for one checker devcheck shells out to: print `message`, exit `code`. */
interface Stub {
  code: number;
  message: string;
}

let dir: string;

function makeScaffold(options: {
  devcheckPatch?: readonly [from: string, to: string] | undefined;
  stubs: Record<string, Stub>;
}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'devcheck-warning-rendering-'));
  mkdirSync(resolve(root, 'scripts'));
  mkdirSync(resolve(root, 'framework-skills', 'demo'), { recursive: true });

  let devcheck = readFileSync(resolve(SCRIPTS_DIR, 'devcheck.ts'), 'utf-8');
  if (options.devcheckPatch) {
    const [from, to] = options.devcheckPatch;
    if (!devcheck.includes(from)) throw new Error(`devcheck.ts no longer contains: ${from}`);
    devcheck = devcheck.replace(from, to);
  }
  writeFileSync(resolve(root, 'scripts', 'devcheck.ts'), devcheck);
  writeFileSync(resolve(root, 'package.json'), '{"name":"scaffold","version":"0.0.0"}\n');
  writeFileSync(resolve(root, 'framework-skills', 'demo', 'SKILL.md'), '# demo\n');
  for (const [script, { code, message }] of Object.entries(options.stubs)) {
    writeFileSync(
      resolve(root, 'scripts', script),
      `console.log(${JSON.stringify(message)});\nprocess.exit(${code});\n`,
    );
  }
  return root;
}

/** A warning-demoted `Skill Versions` run: the stub exits non-zero, `isSuccess` demotes it. */
function skillVersionsScaffold(stub: Stub, devcheckPatch?: readonly [string, string]): string {
  return makeScaffold({ devcheckPatch, stubs: { 'check-skill-versions.ts': stub } });
}

function runCheck(only: string): { code: number; lines: string[]; out: string } {
  const result = spawnSync('bun', ['run', 'scripts/devcheck.ts', '--only', only, '--no-fix'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  const out = `${result.stdout}${result.stderr}`.replace(/\[[0-9;]*m/g, '');
  return { code: result.status ?? -1, lines: out.split('\n'), out };
}

/** The running-log result line for a step — the one led by a status marker. */
function runningLogLine(lines: string[], checkName: string): string {
  return lines.find((line) => /^[✅❌⚠]/.test(line) && line.includes(checkName)) ?? '';
}

/** The step's summary row, which leads with the padded check name. */
function summaryRow(lines: string[], checkName: string): string {
  return lines.find((line) => line.startsWith(checkName)) ?? '';
}

/** Everything printed before the summary section — where the running log lives. */
function runningLog(out: string): string {
  return out.slice(0, out.indexOf('📊 Checkup Summary:'));
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('devcheck running-log rendering of a warning-demoted step (#344)', () => {
  it('marks the running-log line as a warning rather than a success', () => {
    dir = skillVersionsScaffold({ code: 1, message: WARNING_MESSAGE });
    const line = runningLogLine(runCheck('Skill Versions').lines, 'Skill Versions');
    expect(line).not.toContain('finished successfully');
    expect(line.startsWith('⚠')).toBe(true);
  });

  it('carries the warning message in the running log, not only in the summary', () => {
    dir = skillVersionsScaffold({ code: 1, message: WARNING_MESSAGE });
    const { out, lines } = runCheck('Skill Versions');
    expect(runningLog(out)).toContain(WARNING_MESSAGE);
    expect(summaryRow(lines, 'Skill Versions')).toContain('WARNING');
  });

  it('leaves the demotion policy and the exit code alone', () => {
    dir = skillVersionsScaffold({ code: 1, message: WARNING_MESSAGE });
    const { code, lines } = runCheck('Skill Versions');
    expect(summaryRow(lines, 'Skill Versions')).toContain('WARNING');
    expect(code).toBe(0);
  });
});

describe('devcheck running-log rendering of undemoted results (#344)', () => {
  it('renders a clean pass exactly as before', () => {
    dir = skillVersionsScaffold({ code: 0, message: 'framework-skills/ is in sync.' });
    const { code, lines } = runCheck('Skill Versions');
    expect(runningLogLine(lines, 'Skill Versions')).toMatch(
      /^✅ Skill Versions finished successfully in \d+ms\.$/,
    );
    expect(code).toBe(0);
  });

  it('renders a hard failure exactly as before', () => {
    dir = makeScaffold({
      stubs: { 'lint-mcp.ts': { code: 3, message: 'definition error' } },
    });
    const { code, lines } = runCheck('MCP Definitions');
    expect(runningLogLine(lines, 'MCP Definitions')).toMatch(
      /^❌ MCP Definitions failed \(Code 3\) in \d+ms\.$/,
    );
    expect(code).toBe(1);
  });

  it('renders a { success: false, warning } result as a failure, matching the summary', () => {
    dir = skillVersionsScaffold({ code: 1, message: WARNING_MESSAGE }, [
      SKILL_VERSIONS_DEMOTION,
      SKILL_VERSIONS_FAILURE_WITH_WARNING,
    ]);
    const { code, lines } = runCheck('Skill Versions');
    const line = runningLogLine(lines, 'Skill Versions');
    expect(line.startsWith('❌')).toBe(true);
    expect(line).toContain('failed');
    expect(summaryRow(lines, 'Skill Versions')).toContain('FAILED');
    expect(code).toBe(1);
  });
});
