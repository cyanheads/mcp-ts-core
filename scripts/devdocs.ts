/**
 * @fileoverview Generates a comprehensive development documentation prompt for AI analysis.
 * This script combines a repository file tree with 'repomix' output for specified files,
 * wraps it in a detailed prompt, and copies the result to the clipboard.
 * @module scripts/devdocs
 * @description
 *   Analyzes your codebase and generates AI-ready documentation prompts.
 *   Supports git integration, exclude patterns, dry-run mode, and detailed statistics.
 *
 * @example
 * // Run all checks with statistics:
 * // bun run devdocs -- --stats src/
 *
 * // Analyze only changed files:
 * // bun run devdocs -- --git-diff --include-rules
 *
 * // Preview without generating:
 * // bun run devdocs -- --dry-run src/
 *
 * // Exclude test files:
 * // bun run devdocs -- --exclude "*.test.ts" --exclude "*.spec.ts" src/
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import clipboardy from 'clipboardy';
import { execa } from 'execa';
import { z } from 'zod';

// =============================================================================
// Embedded Dependencies
// =============================================================================

// picocolors (https://github.com/alexeyraspopov/picocolors) - MIT License
// Embedded to reduce external dependency count.
// Respects NO_COLOR (https://no-color.org/) and FORCE_COLOR conventions.
const isColorSupported =
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === '1' || !!process.stdout.isTTY);

const createColor = (open: string, close: string) => (str: string | number) => {
  if (!isColorSupported) return `${str}`;
  return open + `${str}`.replaceAll(close, close + open) + close;
};

const c = {
  bold: createColor('\x1b[1m', '\x1b[22m'),
  dim: createColor('\x1b[2m', '\x1b[22m'),
  red: createColor('\x1b[31m', '\x1b[39m'),
  green: createColor('\x1b[32m', '\x1b[39m'),
  yellow: createColor('\x1b[33m', '\x1b[39m'),
  blue: createColor('\x1b[34m', '\x1b[39m'),
  magenta: createColor('\x1b[35m', '\x1b[39m'),
  cyan: createColor('\x1b[36m', '\x1b[39m'),
};

// =============================================================================
// Types & Interfaces
// =============================================================================

interface CliArgs {
  positionals: string[];
  values: {
    'include-rules': boolean;
    'dry-run': boolean;
    stats: boolean;
    'git-diff': boolean;
    'git-staged': boolean;
    validate: boolean;
    exclude: string[];
    config: string | undefined;
    output: string | undefined;
    'no-clipboard': boolean;
    help: boolean;
  };
}

const DevDocsConfigSchema = z.object({
  excludePatterns: z.array(z.string()).optional(),
  includePaths: z.array(z.string()).optional(),
  includeRules: z.boolean().optional(),
  ignoredDependencies: z.array(z.string()).optional(),
  maxOutputSizeMB: z.number().positive().optional(),
});

type DevDocsConfig = z.infer<typeof DevDocsConfigSchema>;

interface PathStats {
  filesAnalyzed: number;
  skippedFiles: number;
  totalLines: number;
  totalSize: number;
  warnings: string[];
}

interface Statistics extends PathStats {
  duration: number;
  estimatedTokens: number;
}

class DevDocsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DevDocsError';
  }
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  DOCS_DIR: 'docs',
  TREE_SCRIPT: path.join('scripts', 'tree.ts'),
  TREE_OUTPUT: 'tree.md',
  DEVDOCS_OUTPUT: 'devdocs.md',
  AGENT_RULE_FILES: ['clinerules.md', 'agents.md'],
  COMMAND_TIMEOUT_MS: 120000,
  MAX_BUFFER_SIZE: 1024 * 1024 * 20,
  MAX_OUTPUT_SIZE_MB: 15,
  APPROX_CHARS_PER_TOKEN: 4,
  CONFIG_FILE_NAMES: ['.devdocsrc', '.devdocsrc.json'],
} as const;

// =============================================================================
// Templates
// =============================================================================

const PROMPT_TEMPLATE = `
You are a senior software architect. Your task is to analyze the provided codebase and generate a detailed plan for my developer to implement improvements.

Review this code base file by file, line by line, to fully understand our code base; you must identify all features, functions, utilities, and understand how they work with each other within the code base.

Identify any issues, gaps, inconsistencies, etc.
Additionally identify potential enhancements, including architectural changes, refactoring, etc.

Identify the modern ${new Date().getFullYear()}, best-practice approaches for what we're trying to accomplish; preferring the latest stable versions of libraries and frameworks.

Skip adding unit/integration tests - that is handled externally.

After you have properly reviewed the code base and mapped out the necessary changes, write out a detailed implementation plan to be shared with my developer on exactly what to change in our current code base to implement these improvements, new features, and optimizations.
`.trim();

const FOCUS_PROMPT =
  '# I want to focus in on the following section of our code base. Map out the changes in detail. Remember to include all relevant files and their paths, use our existing code style (i.e. file headers, etc.), and adhere to architectural best practices while properly integrating the changes into our current code base.';

const REMINDER_FOOTER = `
---
**Reminder:**
Based on your analysis, write out detailed instructions for a developer to implement the changes in our current code base. For each proposed change, specify the file path and include code snippets when necessary, focusing on a detailed and concise explanation of *why* the change is being made. The plan should be structured to be easily followed and implemented.

Please remember:
- Adhere to our programming principles found within the existing code reviewed above.
- Ensure all new code has JSDoc comments and follows our structured logging standards.
- Remember to use any included services for internal services like logging, error handling, request context, and external API calls.
- Before completing the task, run 'bun devcheck' (lint, type check, etc.) to maintain code consistency.
`.trim();

const USAGE_INFO = `
${c.bold('Usage:')} bun run devdocs -- [options] <file1> [<file2> ...]

${c.bold('Options:')}
  --include-rules      Include agent rules files (clinerules.md, agents.md)
  --dry-run           Preview what will be analyzed without generating output
  --stats             Show detailed statistics about analyzed files
  --git-diff          Only analyze files with unstaged changes in git
  --git-staged        Only analyze files staged in git
  --exclude <pattern> Exclude files matching pattern (can be used multiple times)
  --config <path>     Path to custom config file
  --output <path>     Custom output file path (default: docs/devdocs.md)
  --no-clipboard      Skip copying output to clipboard
  --validate          Validate required tools before running
  -h, --help          Show this help message

${c.bold('Examples:')}
  ${c.dim('# Basic usage with statistics')}
  bun run devdocs -- --stats src/

  ${c.dim('# Analyze only changed files')}
  bun run devdocs -- --git-diff --include-rules

  ${c.dim('# Preview without generating')}
  bun run devdocs -- --dry-run src/

  ${c.dim('# Exclude test files')}
  bun run devdocs -- --exclude "*.test.ts" --exclude "*.spec.ts" src/

  ${c.dim('# Use custom config')}
  bun run devdocs -- --config .devdocsrc.json src/

${c.bold('Config File (.devdocsrc or .devdocsrc.json):')}
  {
    "excludePatterns": ["*.test.ts", "*.spec.ts", "__tests__/**"],
    "includePaths": ["src/", "lib/"],
    "includeRules": true,
    "ignoredDependencies": ["lodash", "moment"],
    "maxOutputSizeMB": 15
  }
`.trim();

// =============================================================================
// UI & Logging
// =============================================================================

const UI = {
  log: console.log,

  printHeader() {
    UI.log(`\n${c.bold(c.cyan('📚 DevDocs: Generating AI-ready codebase documentation...'))}`);
  },

  printStep(step: string, detail?: string) {
    const detailStr = detail ? c.dim(` ${detail}`) : '';
    UI.log(`${c.bold(c.blue('▸'))} ${step}${detailStr}`);
  },

  printSuccess(message: string) {
    UI.log(`${c.bold(c.green('✓'))} ${message}`);
  },

  printWarning(message: string) {
    UI.log(`${c.bold(c.yellow('⚠'))} ${message}`);
  },

  printError(message: string, error?: Error) {
    UI.log(`${c.bold(c.red('✗'))} ${message}`);
    if (error?.message) {
      UI.log(c.red(`  ${error.message}`));
    }
  },

  printInfo(message: string) {
    UI.log(`${c.dim('ℹ')} ${c.dim(message)}`);
  },

  printCommand(cmd: string[]) {
    let cmdStr = cmd.join(' ');
    if (cmdStr.length > 100) {
      cmdStr = `${cmdStr.substring(0, 97)}...`;
    }
    UI.log(c.dim(`  $ ${cmdStr}`));
  },

  printSeparator() {
    UI.log(c.dim('─'.repeat(60)));
  },

  printStatistics(stats: Statistics) {
    UI.log(`\n${c.bold(c.cyan('📊 Generation Statistics:'))}`);
    UI.printSeparator();
    UI.log(`${c.bold('Files analyzed:'.padEnd(25))} ${stats.filesAnalyzed}`);
    UI.log(`${c.bold('Files skipped:'.padEnd(25))} ${stats.skippedFiles}`);
    UI.log(`${c.bold('Total lines:'.padEnd(25))} ${stats.totalLines.toLocaleString()}`);
    UI.log(`${c.bold('Total size:'.padEnd(25))} ${formatBytes(stats.totalSize)}`);
    UI.log(`${c.bold('Estimated tokens:'.padEnd(25))} ~${stats.estimatedTokens.toLocaleString()}`);
    UI.log(`${c.bold('Duration:'.padEnd(25))} ${stats.duration.toFixed(2)}s`);

    if (stats.warnings.length > 0) {
      UI.log(`\n${c.bold(c.yellow('⚠ Warnings:'))}`);
      for (const warning of stats.warnings) {
        UI.log(`  • ${c.dim(warning)}`);
      }
    }

    UI.printSeparator();
  },

  printDryRunHeader() {
    UI.log(`\n${c.bold(c.cyan('🔍 Dry Run - Preview of Analysis:'))}`);
    UI.printSeparator();
  },

  printDryRunFile(status: 'include' | 'exclude' | 'missing' | 'directory', filePath: string) {
    const icons = {
      include: c.green('✓'),
      exclude: c.yellow('⊘'),
      missing: c.red('✗'),
      directory: c.blue('📁'),
    };
    const labels = {
      include: 'Include',
      exclude: 'Excluded',
      missing: 'Not found',
      directory: 'Directory',
    };
    UI.log(`${icons[status]} ${c.bold(labels[status].padEnd(10))} ${c.dim(filePath)}`);
  },

  printDryRunSummary(total: number, excluded: number) {
    UI.printSeparator();
    UI.log(`${c.bold('Files to analyze:'.padEnd(25))} ${total}`);
    UI.log(`${c.bold('Files to exclude:'.padEnd(25))} ${excluded}`);
    UI.printSeparator();
  },

  printFooter(success: boolean, outputPath?: string, copiedToClipboard = true) {
    if (success && outputPath) {
      UI.log(`\n${c.bold(c.green('🎉 Documentation generated successfully!'))}`);
      UI.log(`   ${c.dim('Location:')} ${c.cyan(outputPath)}`);
      if (copiedToClipboard) {
        UI.log(`   ${c.dim('Copied to clipboard')}`);
      }
    } else if (!success) {
      UI.log(`\n${c.bold(c.red('🛑 Documentation generation failed. Review errors above.'))}`);
    }
  },

  printFatalError(error: unknown) {
    UI.log(`\n${c.bold(c.red('🛑 Fatal Error:'))}`);
    if (error instanceof DevDocsError) {
      UI.log(c.red(`   ${error.message}`));
      if (error.cause instanceof Error) {
        UI.log(c.dim(`   ${error.cause.message}`));
      }
    } else if (error instanceof Error) {
      UI.log(c.red(`   ${error.message}`));
      if (error.stack) {
        UI.log(c.dim(error.stack.split('\n').slice(1).join('\n')));
      }
    } else {
      UI.log(c.red(`   ${String(error)}`));
    }
  },
};

// =============================================================================
// Utility Functions
// =============================================================================

/** Global abort controller for graceful shutdown. */
const abortController = new AbortController();
let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      process.exit(130);
    }
    shuttingDown = true;
    UI.printWarning(`Received ${signal}, shutting down...`);
    abortController.abort();
    setTimeout(() => process.exit(130), 3000);
  });
}

/**
 * Formats bytes to human-readable size.
 */
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Estimates token count from text content.
 */
const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CONFIG.APPROX_CHARS_PER_TOKEN);

/**
 * Checks if a file or directory exists.
 */
const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Normalizes a file path for pattern matching by stripping leading './' prefixes.
 */
const normalizePath = (p: string): string => {
  let result = p;
  while (result.startsWith('./')) {
    result = result.slice(2);
  }
  return result;
};

/**
 * Matches file path against glob-like patterns.
 *
 * @param filePath - The file path to test against patterns
 * @param patterns - Array of glob-like patterns (supports * and ** wildcards)
 * @returns true if the file path matches any pattern
 *
 * @security
 * This function properly escapes all regex special characters before converting
 * glob patterns to regex, preventing regex injection and ReDoS attacks from
 * user-provided patterns (CLI args or config files).
 */
const matchesPattern = (filePath: string, patterns: string[]): boolean => {
  if (patterns.length === 0) return false;

  const normalizedPath = normalizePath(filePath);

  for (const pattern of patterns) {
    const normalizedPattern = normalizePath(pattern);

    // Security: Properly escape regex chars while preserving glob wildcards
    // This prevents regex injection from user-provided patterns
    const DS = '__DOUBLESTAR__';
    const SS = '__STAR__';
    const QS = '__QUESTION__';
    const regexPattern = normalizedPattern
      // Step 1: Temporarily mark glob patterns with placeholders
      .replaceAll('**', DS)
      .replaceAll('*', SS)
      .replaceAll('?', QS)
      // Step 2: Escape all regex special chars (except the placeholders)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Step 3: Convert glob wildcards to regex equivalents
      .replaceAll(QS, '[^/]')
      .replaceAll(SS, '[^/]*')
      // Step 4: Handle **/ pattern specially - matches zero or more path segments
      .replaceAll(`${DS}/`, '(?:.*/)?')
      // Step 5: Handle /** pattern at end — only at string end
      .replace(new RegExp(`/${DS}$`), '/.*')
      // Step 6: Handle remaining ** (not preceded/followed by /)
      .replaceAll(DS, '.*');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(normalizedPath)) {
      return true;
    }
  }
  return false;
};

/**
 * Traverses up the directory tree to find the project root.
 */
const findProjectRoot = async (startPath: string): Promise<string> => {
  let currentPath = path.resolve(startPath);
  while (currentPath !== path.parse(currentPath).root) {
    const packageJsonPath = path.join(currentPath, 'package.json');
    try {
      await fs.access(packageJsonPath);
      return currentPath;
    } catch {
      currentPath = path.dirname(currentPath);
    }
  }
  throw new DevDocsError('Could not find project root (package.json not found).');
};

/**
 * Executes a command using execa, handling potential errors.
 */
async function executeCommand(
  command: string,
  args: string[],
  captureOutput: true,
): Promise<string>;
async function executeCommand(
  command: string,
  args: string[],
  captureOutput: false,
): Promise<undefined>;
async function executeCommand(
  command: string,
  args: string[],
  captureOutput: boolean,
): Promise<string | undefined> {
  try {
    const stdio = captureOutput ? 'pipe' : 'inherit';
    const result = await execa(command, args, {
      stdio,
      timeout: CONFIG.COMMAND_TIMEOUT_MS,
      maxBuffer: CONFIG.MAX_BUFFER_SIZE,
      cancelSignal: abortController.signal,
    });

    if (captureOutput) {
      return (result.stdout ?? '').trim();
    }
    return;
  } catch (error: unknown) {
    const message = `Error executing command: "${command} ${args.join(' ')}"`;
    throw new DevDocsError(message, error);
  }
}

// =============================================================================
// Core Logic
// =============================================================================

/**
 * Validates that required external tools are available.
 */
const validateRequiredTools = async (): Promise<void> => {
  UI.printStep('Validating required tools...');
  const requiredTools = [
    { command: 'bunx', args: ['--version'], name: 'bunx' },
    { command: 'bunx', args: ['repomix', '--version'], name: 'repomix' },
  ];

  for (const tool of requiredTools) {
    try {
      await executeCommand(tool.command, tool.args, true);
      UI.printSuccess(`${tool.name} is available`);
    } catch (error: unknown) {
      throw new DevDocsError(
        `Required tool "${tool.name}" is not available. Please install it first.`,
        error,
      );
    }
  }
};

/**
 * Gets list of changed files from git.
 */
const getGitChangedFiles = async (staged: boolean = false): Promise<string[]> => {
  UI.printStep(`Getting ${staged ? 'staged' : 'unstaged'} files from git...`);
  try {
    const args = staged
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
      : ['diff', '--name-only', '--diff-filter=ACMR'];
    const output = await executeCommand('git', args, true);

    if (!output) {
      UI.printWarning(`No ${staged ? 'staged' : 'unstaged'} files found in git`);
      return [];
    }

    const files = output.split('\n').filter(Boolean);
    UI.printSuccess(`Found ${files.length} ${staged ? 'staged' : 'unstaged'} file(s)`);
    return files;
  } catch (error: unknown) {
    throw new DevDocsError(
      'Failed to get git changes. Ensure git is available and you are in a git repository.',
      error,
    );
  }
};

/**
 * Loads and validates configuration from file.
 */
const loadConfigFile = async (
  rootDir: string,
  configPath?: string,
): Promise<DevDocsConfig | null> => {
  const searchPaths = configPath
    ? [path.resolve(configPath)]
    : CONFIG.CONFIG_FILE_NAMES.map((name) => path.join(rootDir, name));

  for (const configFilePath of searchPaths) {
    if (await exists(configFilePath)) {
      UI.printInfo(`Loading config from: ${path.relative(rootDir, configFilePath)}`);
      try {
        const content = await fs.readFile(configFilePath, 'utf-8');
        const raw = JSON.parse(content);
        const result = DevDocsConfigSchema.safeParse(raw);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `  ${i.path.join('.')}: ${i.message}`)
            .join('\n');
          throw new DevDocsError(`Invalid config file ${configFilePath}:\n${issues}`);
        }
        return result.data;
      } catch (error: unknown) {
        if (error instanceof DevDocsError) throw error;
        throw new DevDocsError(`Failed to parse config file: ${configFilePath}`, error);
      }
    }
  }

  if (configPath) {
    throw new DevDocsError(`Config file not found: ${configPath}`);
  }

  return null;
};

/**
 * Runs the external tree script and reads its output.
 */
const generateFileTree = async (rootDir: string): Promise<string> => {
  UI.printStep('Generating file tree...');
  const treeScriptPath = path.resolve(rootDir, CONFIG.TREE_SCRIPT);
  const treeDocPath = path.resolve(rootDir, CONFIG.DOCS_DIR, CONFIG.TREE_OUTPUT);

  if (!(await exists(treeScriptPath))) {
    throw new DevDocsError(`Tree generation script not found at: ${treeScriptPath}`);
  }

  await executeCommand('bun', ['run', treeScriptPath], false);

  UI.printSuccess(`File tree generated`);

  try {
    return await fs.readFile(treeDocPath, 'utf-8');
  } catch (error: unknown) {
    throw new DevDocsError(`Failed to read generated tree file at ${treeDocPath}`, error);
  }
};

/**
 * Gathers size statistics for a path using stat (size) and a streaming
 * newline count (lines). Skips binary/unreadable files gracefully.
 */
const analyzePath = async (targetPath: string): Promise<{ lines: number; size: number } | null> => {
  try {
    const stat = await fs.stat(targetPath);

    if (stat.isFile()) {
      try {
        const content = await fs.readFile(targetPath, 'utf-8');
        return { lines: content.split('\n').length, size: stat.size };
      } catch {
        // Binary or unreadable — use stat size, skip line count
        return { lines: 0, size: stat.size };
      }
    }

    if (stat.isDirectory()) {
      let totalLines = 0;
      let totalSize = 0;
      const entries = await fs.readdir(targetPath, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(entry.parentPath, entry.name);
        try {
          const fileStat = await fs.stat(fullPath);
          totalSize += fileStat.size;
          const content = await fs.readFile(fullPath, 'utf-8');
          totalLines += content.split('\n').length;
        } catch {
          // Skip unreadable files (binary, permission errors, etc.)
        }
      }
      return { lines: totalLines, size: totalSize };
    }

    return null;
  } catch {
    return null;
  }
};

/**
 * Filters file paths, removing non-existent and excluded files.
 * Returns the filtered list and stats about what was filtered.
 */
const filterFilePaths = async (
  filePaths: string[],
  excludePatterns: string[],
): Promise<{ filtered: string[]; skipped: number; warnings: string[] }> => {
  const filtered: string[] = [];
  let skipped = 0;
  const warnings: string[] = [];

  for (const filePath of filePaths) {
    if (!(await exists(filePath))) {
      UI.printWarning(`File not found: "${filePath}". Skipping.`);
      skipped++;
      warnings.push(`Not found: ${filePath}`);
      continue;
    }

    if (matchesPattern(filePath, excludePatterns)) {
      UI.printInfo(`Excluding: ${filePath}`);
      skipped++;
      continue;
    }

    filtered.push(filePath);
  }

  return { filtered, skipped, warnings };
};

/**
 * Runs repomix on the filtered file paths in a single batched invocation.
 */
const runRepomix = async (filePaths: string[], ignorePatterns: string[]): Promise<string> => {
  UI.printStep(`Running repomix on ${filePaths.length} path(s)...`);

  const repomixArgs = ['repomix', ...filePaths, '-o', '-'];
  if (ignorePatterns.length > 0) {
    repomixArgs.push('--ignore', ignorePatterns.join(','));
  }

  UI.printCommand(['bunx', ...repomixArgs]);

  const output = await executeCommand('bunx', repomixArgs, true);

  if (!output || output.length === 0) {
    throw new DevDocsError('Repomix produced no output for the provided paths.');
  }

  UI.printSuccess(`Repomix analysis complete`);
  return output;
};

/**
 * Runs repomix and gathers path statistics.
 * Returns the repomix output string and accumulated stats.
 */
const getRepomixOutputs = async (
  filePaths: string[],
  ignorePatterns: string[],
  excludePatterns: string[],
): Promise<{ output: string; stats: PathStats }> => {
  // Filter before running repomix
  const { filtered, skipped, warnings } = await filterFilePaths(filePaths, excludePatterns);

  if (filtered.length === 0) {
    throw new DevDocsError(
      'No valid files remain after filtering. All paths were excluded or not found.',
    );
  }

  if (filtered.length < filePaths.length) {
    UI.printInfo(
      `${filePaths.length - filtered.length} path(s) filtered out, ${filtered.length} remaining`,
    );
  }

  // Run repomix as a single batched call
  const output = await runRepomix(filtered, ignorePatterns);

  // Gather stats for the analyzed paths
  UI.printStep('Gathering file statistics...');
  let totalLines = 0;
  let totalSize = 0;
  let filesAnalyzed = 0;

  for (const filePath of filtered) {
    const fileStats = await analyzePath(filePath);
    if (fileStats) {
      filesAnalyzed++;
      totalLines += fileStats.lines;
      totalSize += fileStats.size;
    }
  }

  UI.printSuccess(`${filesAnalyzed} path(s) analyzed`);

  return {
    output,
    stats: {
      filesAnalyzed,
      totalLines,
      totalSize,
      skippedFiles: skipped,
      warnings,
    },
  };
};

/**
 * Builds the list of patterns for repomix --ignore from config and package.json resolutions.
 * Resolutions are version-pinning overrides (Yarn/pnpm) that indicate vendored or patched
 * packages — these are excluded because repomix would otherwise include their source.
 */
const getRepomixIgnorePatterns = async (
  rootDir: string,
  configDeps?: string[],
): Promise<string[]> => {
  const patterns = new Set<string>(configDeps ?? []);
  const packageJsonPath = path.join(rootDir, 'package.json');

  try {
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    if (
      packageJson &&
      typeof packageJson === 'object' &&
      'resolutions' in packageJson &&
      typeof packageJson.resolutions === 'object' &&
      packageJson.resolutions !== null
    ) {
      for (const dep of Object.keys(packageJson.resolutions)) {
        patterns.add(dep);
      }
    }
  } catch (_error) {
    UI.printWarning('Could not read package.json for resolutions');
  }

  const result = Array.from(patterns);
  if (result.length > 0) {
    UI.printInfo(`Repomix ignoring ${result.length} pattern(s)`);
  }
  return result;
};

/**
 * Finds a file in a directory matching one of the names (case-insensitive).
 */
const findFileCaseInsensitive = async (
  dir: string,
  fileNames: readonly string[],
): Promise<string | null> => {
  try {
    const files = await fs.readdir(dir);
    const lowerCaseFileNames = new Set(fileNames.map((f) => f.toLowerCase()));

    for (const file of files) {
      if (lowerCaseFileNames.has(file.toLowerCase())) {
        const fullPath = path.join(dir, file);
        const stats = await fs.stat(fullPath);
        if (stats.isFile()) {
          return fullPath;
        }
      }
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      UI.printWarning(`Could not read directory: ${dir}`);
    }
  }
  return null;
};

/**
 * Locates and reads the content of the agent rules file.
 */
const getAgentRulesContent = async (rootDir: string): Promise<string | null> => {
  UI.printStep('Searching for agent rules files...');
  const ruleFilePath = await findFileCaseInsensitive(rootDir, CONFIG.AGENT_RULE_FILES);

  if (ruleFilePath) {
    UI.printSuccess(`Found agent rules: ${path.basename(ruleFilePath)}`);
    try {
      return await fs.readFile(ruleFilePath, 'utf-8');
    } catch (error: unknown) {
      throw new DevDocsError(`Failed to read agent rules file: ${ruleFilePath}`, error);
    }
  }

  UI.printInfo('No agent rules file found');
  return null;
};

/**
 * Combines all parts into the final devdocs content and writes it to disk.
 */
const createDevDocsFile = async (
  rootDir: string,
  treeContent: string,
  repomixContent: string,
  agentRulesContent: string | null,
  maxOutputSizeMB: number,
  customOutputPath?: string,
): Promise<{ content: string; warnings: string[] }> => {
  const devDocsPath = customOutputPath
    ? path.resolve(customOutputPath)
    : path.resolve(rootDir, CONFIG.DOCS_DIR, CONFIG.DEVDOCS_OUTPUT);
  UI.printStep(`Creating ${path.basename(devDocsPath)}...`);

  const contentParts = [
    PROMPT_TEMPLATE,
    '# Full project repository tree',
    treeContent.trim(),
    '---',
  ];

  if (agentRulesContent) {
    contentParts.push('# Agent Rules', agentRulesContent.trim(), '---');
  }

  contentParts.push(FOCUS_PROMPT, repomixContent.trim(), REMINDER_FOOTER);

  const devdocsContent = contentParts.join('\n\n');
  const warnings: string[] = [];

  const sizeInMB = devdocsContent.length / (1024 * 1024);
  if (sizeInMB > maxOutputSizeMB) {
    const warning = `Output size (${sizeInMB.toFixed(2)} MB) exceeds recommended maximum (${maxOutputSizeMB} MB)`;
    UI.printWarning(warning);
    warnings.push(warning);
  }

  try {
    await fs.mkdir(path.dirname(devDocsPath), { recursive: true });
    await fs.writeFile(devDocsPath, devdocsContent);

    UI.printSuccess(`Documentation written to ${path.relative(rootDir, devDocsPath)}`);
    return { content: devdocsContent, warnings };
  } catch (error: unknown) {
    throw new DevDocsError(`Failed to write ${CONFIG.DEVDOCS_OUTPUT}`, error);
  }
};

/**
 * Copies the generated content to the system clipboard.
 */
const copyToClipboard = async (content: string): Promise<void> => {
  UI.printStep('Copying to clipboard...');
  try {
    await clipboardy.write(content);
    UI.printSuccess('Copied to clipboard');
  } catch (_error) {
    UI.printWarning('Failed to copy to clipboard (file was generated successfully)');
  }
};

/**
 * Performs a dry run to preview what will be analyzed.
 */
const performDryRun = async (filePaths: string[], excludePatterns: string[]): Promise<void> => {
  UI.printDryRunHeader();

  let totalFiles = 0;
  let excludedFiles = 0;

  for (const filePath of filePaths) {
    if (!(await exists(filePath))) {
      UI.printDryRunFile('missing', filePath);
      continue;
    }

    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      UI.printDryRunFile('directory', filePath);
      totalFiles++;
    } else if (matchesPattern(filePath, excludePatterns)) {
      UI.printDryRunFile('exclude', filePath);
      excludedFiles++;
    } else {
      UI.printDryRunFile('include', filePath);
      totalFiles++;
    }
  }

  UI.printDryRunSummary(totalFiles, excludedFiles);
};

// =============================================================================
// Main Execution
// =============================================================================

const parseCliArguments = (): CliArgs => {
  try {
    const { values, positionals } = parseArgs({
      options: {
        'include-rules': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        stats: { type: 'boolean', default: false },
        'git-diff': { type: 'boolean', default: false },
        'git-staged': { type: 'boolean', default: false },
        validate: { type: 'boolean', default: false },
        exclude: { type: 'string', multiple: true, default: [] },
        config: { type: 'string' },
        output: { type: 'string', short: 'o' },
        'no-clipboard': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });

    return {
      values: {
        'include-rules': values['include-rules'] as boolean,
        'dry-run': values['dry-run'] as boolean,
        stats: values.stats as boolean,
        'git-diff': values['git-diff'] as boolean,
        'git-staged': values['git-staged'] as boolean,
        validate: values.validate as boolean,
        exclude: (values.exclude as string[]) ?? [],
        config: values.config as string | undefined,
        output: values.output as string | undefined,
        'no-clipboard': values['no-clipboard'] as boolean,
        help: values.help as boolean,
      },
      positionals,
    };
  } catch (error: unknown) {
    throw new DevDocsError('Failed to parse arguments', error);
  }
};

const main = async () => {
  const startTime = Date.now();
  const args = parseCliArguments();

  if (args.values.help) {
    console.log(USAGE_INFO);
    process.exit(0);
  }

  UI.printHeader();

  // Find project root
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  const rootDir = await findProjectRoot(scriptDir);
  UI.printSuccess(`Project root: ${rootDir}`);

  // Load configuration
  const config = await loadConfigFile(rootDir, args.values.config);

  // Merge CLI args with config
  const excludePatterns = [...(config?.excludePatterns ?? []), ...args.values.exclude];
  const includeRules = args.values['include-rules'] || config?.includeRules || false;
  const maxOutputSizeMB = config?.maxOutputSizeMB ?? CONFIG.MAX_OUTPUT_SIZE_MB;

  // Determine file paths
  let filePaths = args.positionals;
  const usingGitMode = args.values['git-diff'] || args.values['git-staged'];

  if (args.values['git-diff'] && args.values['git-staged']) {
    UI.printWarning('--git-diff and --git-staged are mutually exclusive; using --git-staged');
  }

  if (usingGitMode) {
    const gitFiles = await getGitChangedFiles(args.values['git-staged']);
    if (gitFiles.length > 0) {
      filePaths = gitFiles;
    } else if (filePaths.length > 0) {
      UI.printWarning('No git changes found; falling back to positional arguments');
    } else {
      UI.printError('No git changes found and no positional paths provided');
      process.exit(1);
    }
  }

  if (config?.includePaths && filePaths.length === 0) {
    filePaths = config.includePaths;
  }

  if (filePaths.length === 0) {
    UI.printError('No file paths provided');
    console.log(`\n${USAGE_INFO}`);
    process.exit(1);
  }

  // Validate tools if requested
  if (args.values.validate) {
    await validateRequiredTools();
  }

  // Dry run mode
  if (args.values['dry-run']) {
    await performDryRun(filePaths, excludePatterns);
    process.exit(0);
  }

  // Get ignored dependencies
  const ignorePatterns = await getRepomixIgnorePatterns(rootDir, config?.ignoredDependencies);

  // Combine ignore patterns: repomix --ignore gets both dependency ignores and exclude patterns
  const allIgnorePatterns = [...ignorePatterns, ...excludePatterns];

  // Run tasks sequentially for clean console output
  UI.log('');

  const treeContent = await generateFileTree(rootDir);

  const agentRulesContent = includeRules ? await getAgentRulesContent(rootDir) : null;

  const { output: repomixOutput, stats: pathStats } = await getRepomixOutputs(
    filePaths,
    allIgnorePatterns,
    excludePatterns,
  );

  // Create file
  const { content, warnings: fileWarnings } = await createDevDocsFile(
    rootDir,
    treeContent,
    repomixOutput,
    agentRulesContent,
    maxOutputSizeMB,
    args.values.output,
  );

  // Copy to clipboard
  if (!args.values['no-clipboard']) {
    await copyToClipboard(content);
  }

  // Assemble final statistics
  const stats: Statistics = {
    ...pathStats,
    warnings: [...pathStats.warnings, ...fileWarnings],
    estimatedTokens: estimateTokens(content),
    duration: (Date.now() - startTime) / 1000,
  };

  // Print statistics if requested
  if (args.values.stats) {
    UI.printStatistics(stats);
  }

  // Print footer
  const displayPath = args.values.output
    ? path.relative(rootDir, path.resolve(args.values.output))
    : path.join(CONFIG.DOCS_DIR, CONFIG.DEVDOCS_OUTPUT);
  UI.printFooter(true, displayPath, !args.values['no-clipboard']);
};

// Entry point
main().catch((error) => {
  UI.printFatalError(error);
  process.exit(1);
});
