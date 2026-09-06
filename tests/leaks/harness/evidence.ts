/** @fileoverview Fail-closed schema and completeness checks for local lifecycle reports. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Resource = z.object({
  id: z.number().int().nonnegative(),
  type: z.string().min(1),
  stack: z.string().min(1),
  owner: z.string().nullable(),
});
const Evidence = z.object({
  identity: z.string(),
  runtime: z.string().regex(/^v\d+\./),
  captured: z.number().int().nonnegative(),
  findings: z.array(Resource),
  startup: z.array(Resource),
});
const Manifest = z.object({
  identities: z.array(z.string()).min(1),
  reason: z.literal('passed'),
  unhandledErrors: z.literal(0),
});

/** Stable project/file identity prevents overwrites and missing-file false greens. */
export function evidenceFilename(identity: string): string {
  return `${createHash('sha256').update(identity).digest('hex')}.json`;
}

/** Read every selected runtime file's evidence, rejecting malformed, incomplete, or failing runs. */
export function verifyEvidence(directory: string) {
  const manifest = Manifest.parse(
    JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')),
  );
  if (new Set(manifest.identities).size !== manifest.identities.length)
    throw new Error('Duplicate file identities');
  const reports = manifest.identities.map((identity) => {
    const report = Evidence.parse(
      JSON.parse(readFileSync(join(directory, evidenceFilename(identity)), 'utf8')),
    );
    if (report.identity !== identity) throw new Error(`Mismatched evidence: ${identity}`);
    if (report.findings.length) throw new Error(`Retained operation resources: ${identity}`);
    for (const resource of report.startup) {
      // This is an owner contract checked by native-lifetime.mjs, not a type ignore:
      // the same resource allocated during a test operation remains a failure.
      const dnsOwner =
        resource.owner === 'node:dns: Node environment' && resource.type === 'DNSCHANNEL';
      const duckdbOwner =
        identity.endsWith('/tests/smoke/services/canvas-duckdb.test.ts') &&
        resource.owner === '@duckdb/node-api: Node environment' &&
        resource.type === 'DuckDBNapiRefReaper';
      if (!dnsOwner && !duckdbOwner)
        throw new Error(`Unclassified startup resource: ${resource.type}`);
    }
    if (new Set(report.startup.map((r) => r.owner)).size !== report.startup.length) {
      throw new Error(`Repeated native environment allocation: ${identity}`);
    }
    const lifetime = z
      .object({
        identity: z.literal(identity),
        code: z.literal(0),
        signal: z.null(),
        timedOut: z.literal(false),
      })
      .parse(
        JSON.parse(readFileSync(join(directory, `lifetime-${evidenceFilename(identity)}`), 'utf8')),
      );
    return { ...report, lifetime };
  });
  return reports;
}
