/**
 * @fileoverview Attributes config validation failures to the environment
 * variables that fed them, for the framework's own config and `parseEnvConfig`
 * alike, so both name the variable an operator has to change.
 * @module src/config/envIssue
 */

import type { z } from 'zod';

/** One validation failure, attributed to the environment variable behind it. */
export interface EnvIssue {
  /** Zod's issue code. */
  code: string;
  /** The variable that fed the failing value, or {@link path} when none is mapped. */
  envVar: string;
  message: string;
  /** The full schema path, dot-joined; empty for a root-level refinement. */
  path: string;
}

/**
 * Attributes each issue to the variable mapped at the longest prefix of its
 * path, so a failure inside a field — an array element a `.transform()`
 * produced, a property of an object parsed from one JSON value — names the
 * variable that fed the field. Keys of `envVarByPath` are dot-joined schema
 * paths; only its own keys count. An issue with no mapped prefix, a root-level
 * refinement included, keeps its path as the variable.
 */
export function toEnvIssues(
  issues: readonly z.core.$ZodIssue[],
  envVarByPath: Readonly<Record<string, string>>,
): EnvIssue[] {
  return issues.map((issue) => {
    const path = issue.path.join('.');
    let envVar: string | undefined;
    for (let length = issue.path.length; length > 0 && envVar === undefined; length--) {
      const prefix = issue.path.slice(0, length).join('.');
      if (Object.hasOwn(envVarByPath, prefix)) envVar = envVarByPath[prefix];
    }
    return { code: issue.code, envVar: envVar ?? path, message: issue.message, path };
  });
}

/** Renders issues as the `  - <ENV_VAR> (<path>): <message>` lines a startup banner shows. */
export function formatEnvIssues(issues: readonly EnvIssue[]): string {
  return issues
    .map(({ envVar, message, path }) => `  - ${envVar} (${path}): ${message}`)
    .join('\n');
}
