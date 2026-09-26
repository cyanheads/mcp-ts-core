/**
 * @fileoverview The framework's own parse of a handler's result against the
 * definition's declared output contract, shared by the tool and resource
 * handler factories and the test kit.
 * @module src/mcp-server/outputContract
 */

import type { z } from 'zod';

import { internalError, type McpError } from '@/types-global/errors.js';

/** Which definition produced the result, and which declared contract it broke. */
export interface OutputContractSubject {
  contract: 'enrichment' | 'output';
  kind: 'Resource' | 'Tool';
  name: string;
}

/** Violations raised by {@link parseOutputContract}, for {@link isOutputContractViolation}. */
const violations = new WeakSet<McpError>();

/**
 * Parses `value` against a definition's declared `schema`, or throws the
 * failure as the server fault it is (#480).
 *
 * A result that breaks its own contract says nothing about the request: the
 * handler returned the wrong shape. Left as a raw `ZodError`, the classifier
 * would file it as `ValidationError` (-32007) and the error counters under
 * `client`. It fails as `InternalError` (-32603) instead, with a message naming
 * the definition, the broken contract, and each issue's path. The issues ride
 * only in that message and on the `ZodError` kept as `cause` for the log — no
 * `data`, so the schema's internals stay off the wire.
 */
export function parseOutputContract<S extends z.ZodType>(
  schema: S,
  value: unknown,
  subject: OutputContractSubject,
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: ${issue.message}`
        : issue.message,
    )
    .join(', ');
  const violation = internalError(
    `${subject.kind} ${subject.name} returned ${subject.contract} that does not match its ${subject.contract} schema: ${detail}`,
    undefined,
    { cause: parsed.error },
  );
  violations.add(violation);
  throw violation;
}

/**
 * True for a failure {@link parseOutputContract} raised. Lets the fuzz runner
 * keep counting a broken output contract as a crash now that it arrives as an
 * `McpError` rather than a raw `ZodError`.
 */
export function isOutputContractViolation(error: unknown): boolean {
  return violations.has(error as McpError);
}
