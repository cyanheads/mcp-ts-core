/**
 * @fileoverview The counters and debug logs the argument step emits for the
 * attempt a call settles on: keys dropped, keys rewritten, and values
 * repaired. Counter attributes stay bounded; the caller's own key text goes to
 * the debug log only (#114).
 * @module src/mcp-server/tools/utils/arguments/telemetry
 */

import type { Counter } from '@opentelemetry/api';

import { joinNames } from '@/utils/formatting/sentence.js';
import { logger } from '@/utils/internal/logger.js';
import { capForObservability } from '@/utils/internal/observabilityCap.js';
import {
  type RequestContext,
  requestContextService,
  withExtra,
} from '@/utils/internal/requestContext.js';
import {
  ATTR_MCP_INPUT_ALIAS_KIND,
  ATTR_MCP_INPUT_COERCION,
  ATTR_MCP_INPUT_IGNORE_RULE,
  ATTR_MCP_INPUT_TARGET,
  ATTR_MCP_TOOL_NAME,
} from '@/utils/telemetry/attributes.js';
import { createCounter } from '@/utils/telemetry/metrics.js';
import type { AnyToolDefinition } from '../toolDefinition.js';
import type { AliasKind, PrevalidatedArguments } from './prevalidation.js';
import { COERCION_KINDS, type CoercionKind } from './repair.js';

let ignoredKeyCounter: Counter | undefined;
let aliasedCounter: Counter | undefined;
let coercedCounter: Counter | undefined;

/**
 * Lazily created — a server whose callers never trip a stage emits no series.
 *
 * `rule` is the ignore-list entry that matched or {@link UNDERSCORE_RULE}, never
 * the dropped key itself: the key is the caller's text, and one client inventing
 * `_callId`, `_call_id`, `_callID` would mint three permanent series (#114). The
 * ignore list is author- and framework-defined, so it is safe to name.
 */
function countIgnoredKey(toolName: string, rule: string): void {
  ignoredKeyCounter ??= createCounter(
    'mcp.input.ignored_key',
    'Client-added root argument keys dropped before validation',
    '{keys}',
  );
  ignoredKeyCounter.add(1, {
    [ATTR_MCP_TOOL_NAME]: toolName,
    [ATTR_MCP_INPUT_IGNORE_RULE]: rule,
  });
}

/**
 * Labelled by the canonical *target* and which half of the stage fired — both
 * bounded by the definition. The alias is the caller's text, and the case-style
 * half accepts every `-`/`_`/case permutation of a declared key, so labelling it
 * would put an unbounded set on a permanent series (#114).
 */
function countAliased(toolName: string, target: string, kind: AliasKind): void {
  aliasedCounter ??= createCounter(
    'mcp.input.aliased',
    'Root argument keys rewritten to their canonical spelling',
    '{keys}',
  );
  aliasedCounter.add(1, {
    [ATTR_MCP_TOOL_NAME]: toolName,
    [ATTR_MCP_INPUT_TARGET]: target,
    [ATTR_MCP_INPUT_ALIAS_KIND]: kind,
  });
}

/**
 * Emits one counter increment and one debug log per change an attempt made, in
 * the order its stages made them. {@link parseToolArguments} calls it once per
 * call, for the attempt whose arguments the handler receives — or, on a
 * rejection, the attempt the rejection reports, which is the alias-first
 * retry's when it ran — so a key the alias-first retry rewrote never also
 * counts as dropped (#563).
 *
 * The key a record names is the caller's, of whatever length the caller wrote,
 * so the message and the field carry at most its first 1,024 characters, with
 * `aliasLength` / `ignoredKeyLength` holding the uncut length when that cut
 * something (#631).
 */
export function recordPrevalidation(
  def: AnyToolDefinition,
  attempt: PrevalidatedArguments,
  context: RequestContext | undefined,
): void {
  for (const change of attempt.changes) {
    if (change.kind === 'aliased') {
      const { aliasKind, target } = change;
      const alias = capForObservability(change.alias);
      countAliased(def.name, target, aliasKind);
      debugLog(
        `Tool '${def.name}': rewrote argument key '${alias.value}' to '${target}'.`,
        context,
        {
          toolName: def.name,
          alias: alias.value,
          ...(alias.length !== undefined && { aliasLength: alias.length }),
          target,
          aliasKind,
        },
      );
    } else {
      const key = capForObservability(change.key);
      countIgnoredKey(def.name, change.rule);
      debugLog(`Tool '${def.name}': dropped client-added argument key '${key.value}'.`, context, {
        toolName: def.name,
        ignoredKey: key.value,
        ...(key.length !== undefined && { ignoredKeyLength: key.length }),
        ignoreRule: change.rule,
      });
    }
  }
}

/**
 * One increment per repaired call and kind — a call repairing an array and an
 * object adds one to each series, and one repairing three arrays adds one — and
 * one debug log per call naming every kind that fired.
 */
export function countCoerced(
  toolName: string,
  kinds: readonly CoercionKind[],
  context: RequestContext | undefined,
): void {
  coercedCounter ??= createCounter(
    'mcp.input.coerced',
    'Tool calls that validated only after a representation repair',
    '{calls}',
  );
  for (const kind of kinds) {
    coercedCounter.add(1, {
      [ATTR_MCP_TOOL_NAME]: toolName,
      [ATTR_MCP_INPUT_COERCION]: kind,
    });
  }
  const named = joinNames(kinds.map((kind) => COERCION_KINDS[kind]));
  debugLog(`Tool '${toolName}': arguments validated after repairing ${named}.`, context, {
    toolName,
    coercions: kinds,
  });
}

/**
 * The step's own debug channel. A call the step rescues carries nothing about
 * it in its response, so the log is where a server operator sees which key was
 * dropped or moved; the counters say only that one was. A rejected call also
 * reports its rewrites and underscore-rule drops to the caller (#468); an
 * ignore-list drop never reaches the caller at all.
 */
function debugLog(
  message: string,
  context: RequestContext | undefined,
  extra: Record<string, unknown>,
): void {
  const base =
    context ?? requestContextService.createRequestContext({ operation: 'ToolInputPrevalidation' });
  logger.debug(message, withExtra(base, extra));
}
