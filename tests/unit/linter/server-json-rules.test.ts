/**
 * @fileoverview Tests for server.json manifest lint rules.
 * @module tests/unit/linter/server-json-rules.test
 */

import { describe, expect, it } from 'vitest';
import { lintServerJson } from '@/linter/rules/server-json-rules.js';
import type { LintDiagnostic } from '@/linter/types.js';

type Manifest = Record<string, unknown>;

const validPackage = {
  registryType: 'npm',
  identifier: '@cyanheads/mcp-ts-core',
  version: '1.2.3',
  transport: { type: 'stdio' },
  packageArguments: [
    { type: 'positional', valueHint: 'server name', format: 'string' },
    { type: 'named', name: '--verbose', value: 'true', format: 'boolean' },
  ],
  runtimeArguments: [{ type: 'named', name: '--port', valueHint: 'port', format: 'number' }],
  environmentVariables: [
    { name: 'API_KEY', description: 'API key used by the server.', format: 'string' },
  ],
};

const validManifest = {
  name: 'io.github.cyanheads/mcp-ts-core',
  description: 'Agent-native TypeScript framework for MCP servers.',
  version: '1.2.3',
  repository: {
    url: 'https://github.com/cyanheads/mcp-ts-core',
    source: 'github',
  },
  packages: [validPackage],
  remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withManifest(edit: (manifest: Manifest) => void): Manifest {
  const manifest = clone(validManifest) as Manifest;
  edit(manifest);
  return manifest;
}

function withPackage(edit: (pkg: Manifest) => void): Manifest {
  return withManifest((manifest) => {
    const pkg = clone(validPackage) as Manifest;
    edit(pkg);
    manifest.packages = [pkg];
  });
}

function rulesFor(serverJson: unknown, crossCheck?: { packageJsonVersion?: string }): string[] {
  return lintServerJson(serverJson, crossCheck).map((diagnostic) => diagnostic.rule);
}

function expectRule(
  serverJson: unknown,
  rule: string,
  severity?: LintDiagnostic['severity'],
  crossCheck?: { packageJsonVersion?: string },
): void {
  expect(lintServerJson(serverJson, crossCheck)).toContainEqual(
    expect.objectContaining({
      rule,
      ...(severity ? { severity } : {}),
    }),
  );
}

describe('lintServerJson', () => {
  it('skips absent manifests and accepts a complete manifest', () => {
    expect(lintServerJson(undefined)).toEqual([]);
    expect(lintServerJson(null)).toEqual([]);
    expect(lintServerJson(validManifest)).toEqual([]);
  });

  it('rejects non-object manifests before field validation', () => {
    expect(lintServerJson('not-object')).toEqual([
      expect.objectContaining({
        definitionName: 'server.json',
        definitionType: 'server-json',
        rule: 'server-json-type',
        severity: 'error',
      }),
    ]);
    expectRule([], 'server-json-type', 'error');
  });

  it.each([
    ['server-json-name-required', withManifest((m) => (m.name = '')), 'error'],
    ['server-json-name-length', withManifest((m) => (m.name = 'a/b'.repeat(100))), 'error'],
    ['server-json-name-format', withManifest((m) => (m.name = 'not reverse dns')), 'error'],
    ['server-json-description-required', withManifest((m) => (m.description = '')), 'error'],
    [
      'server-json-description-length',
      withManifest((m) => (m.description = 'x'.repeat(101))),
      'warning',
    ],
    ['server-json-version-required', withManifest((m) => (m.version = '')), 'error'],
    ['server-json-version-length', withManifest((m) => (m.version = '1'.repeat(256))), 'error'],
    ['server-json-version-no-range', withManifest((m) => (m.version = '^1.2.3')), 'error'],
    ['server-json-version-semver', withManifest((m) => (m.version = 'v1')), 'warning'],
  ] as const)('emits %s for root manifest fields', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it('warns when server.json version differs from package.json', () => {
    expectRule(validManifest, 'server-json-version-sync', 'warning', {
      packageJsonVersion: '9.9.9',
    });
  });

  it.each([
    [
      'server-json-repository-type',
      withManifest((m) => (m.repository = 'https://example.com')),
      'error',
    ],
    [
      'server-json-repository-url',
      withManifest((m) => (m.repository = { source: 'github' })),
      'error',
    ],
    [
      'server-json-repository-source',
      withManifest((m) => (m.repository = { url: 'https://example.com' })),
      'error',
    ],
  ] as const)('emits %s for repository shape problems', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it.each([
    ['server-json-packages-type', withManifest((m) => (m.packages = {})), 'error'],
    ['server-json-package-type', withManifest((m) => (m.packages = ['bad'])), 'error'],
    ['server-json-package-registry', withPackage((pkg) => (pkg.registryType = '')), 'error'],
    ['server-json-package-identifier', withPackage((pkg) => (pkg.identifier = '')), 'error'],
    ['server-json-package-transport', withPackage((pkg) => delete pkg.transport), 'error'],
    ['server-json-package-no-latest', withPackage((pkg) => (pkg.version = 'latest')), 'error'],
    ['server-json-package-version-sync', withPackage((pkg) => (pkg.version = '1.2.4')), 'warning'],
    ['server-json-package-args-type', withPackage((pkg) => (pkg.packageArguments = {})), 'error'],
    ['server-json-runtime-args-type', withPackage((pkg) => (pkg.runtimeArguments = {})), 'error'],
    ['server-json-env-vars-type', withPackage((pkg) => (pkg.environmentVariables = {})), 'error'],
  ] as const)('emits %s for package entries', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it.each([
    ['server-json-transport-type', withPackage((pkg) => (pkg.transport = 'stdio')), 'error'],
    [
      'server-json-transport-type-value',
      withPackage((pkg) => (pkg.transport = { type: 'websocket' })),
      'error',
    ],
    [
      'server-json-transport-url-required',
      withPackage((pkg) => (pkg.transport = { type: 'streamable-http' })),
      'error',
    ],
    [
      'server-json-transport-url-format',
      withPackage((pkg) => (pkg.transport = { type: 'sse', url: 'ftp://example.com' })),
      'warning',
    ],
  ] as const)('emits %s for transport entries', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it.each([
    ['server-json-argument-type', withPackage((pkg) => (pkg.packageArguments = ['bad'])), 'error'],
    [
      'server-json-argument-type-value',
      withPackage((pkg) => (pkg.packageArguments = [{ type: 'flag' }])),
      'error',
    ],
    [
      'server-json-argument-name',
      withPackage((pkg) => (pkg.packageArguments = [{ type: 'named' }])),
      'error',
    ],
    [
      'server-json-argument-value',
      withPackage((pkg) => (pkg.packageArguments = [{ type: 'positional' }])),
      'error',
    ],
    [
      'server-json-input-format',
      withPackage(
        (pkg) => (pkg.packageArguments = [{ type: 'named', name: '--mode', format: 'json' }]),
      ),
      'warning',
    ],
  ] as const)('emits %s for package arguments', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it.each([
    [
      'server-json-env-var-type',
      withPackage((pkg) => (pkg.environmentVariables = ['bad'])),
      'error',
    ],
    [
      'server-json-env-var-name',
      withPackage((pkg) => (pkg.environmentVariables = [{ description: 'missing name' }])),
      'error',
    ],
    [
      'server-json-env-var-description',
      withPackage((pkg) => (pkg.environmentVariables = [{ name: 'API_KEY' }])),
      'warning',
    ],
    [
      'server-json-input-format',
      withPackage(
        (pkg) =>
          (pkg.environmentVariables = [{ name: 'API_KEY', description: 'Key.', format: 'secret' }]),
      ),
      'warning',
    ],
  ] as const)('emits %s for environment variables', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it.each([
    ['server-json-remotes-type', withManifest((m) => (m.remotes = {})), 'error'],
    ['server-json-remote-type', withManifest((m) => (m.remotes = ['bad'])), 'error'],
    [
      'server-json-remote-transport-type',
      withManifest((m) => (m.remotes = [{ url: 'https://example.com' }])),
      'error',
    ],
    [
      'server-json-remote-no-stdio',
      withManifest((m) => (m.remotes = [{ type: 'stdio' }])),
      'error',
    ],
    [
      'server-json-transport-url-format',
      withManifest((m) => (m.remotes = [{ type: 'streamable-http', url: 'not-a-url' }])),
      'warning',
    ],
  ] as const)('emits %s for remote entries', (rule, manifest, severity) => {
    expectRule(manifest, rule, severity);
  });

  it('can emit multiple diagnostics from one malformed package', () => {
    const rules = rulesFor(
      withPackage((pkg) => {
        delete pkg.registryType;
        delete pkg.identifier;
        pkg.transport = { type: 'streamable-http' };
        pkg.packageArguments = [{ type: 'positional' }];
        pkg.environmentVariables = [{ name: '', description: '' }];
      }),
    );

    expect(rules).toEqual(
      expect.arrayContaining([
        'server-json-package-registry',
        'server-json-package-identifier',
        'server-json-transport-url-required',
        'server-json-argument-value',
        'server-json-env-var-name',
        'server-json-env-var-description',
      ]),
    );
  });
});
