/**
 * @fileoverview Tests for the DuckDB error classifier. Pins the user-facing
 * error code/reason for each branch so regressions in the regex matchers or
 * the framework error mapping are caught at lint time. Pure function — no
 * DuckDB native bindings required.
 * @module tests/unit/canvas/classifyDuckdbError.test
 */

import { describe, expect, it } from 'vitest';

import { classifyDuckdbError } from '@/services/canvas/providers/duckdb/DuckdbProvider.js';
import { JsonRpcErrorCode, McpError, notFound, validationError } from '@/types-global/errors.js';

describe('classifyDuckdbError', () => {
  it('classifies parser errors as ValidationError with sql_parse_error reason', () => {
    const result = classifyDuckdbError(new Error('Parser Error: syntax error at end of input'));
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.message).toMatch(/Canvas SQL rejected:/);
    expect(mcp.data?.reason).toBe('sql_parse_error');
    expect(mcp.cause).toBeInstanceOf(Error);
  });

  it('classifies bare "syntax" errors via the parser pattern', () => {
    const result = classifyDuckdbError(new Error('Syntax error near "FROM"'));
    expect((result as McpError).data?.reason).toBe('sql_parse_error');
  });

  it('classifies permission errors as ValidationError with sql_read_only reason', () => {
    const result = classifyDuckdbError(new Error('Permission denied: cannot write'));
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.data?.reason).toBe('sql_read_only');
  });

  it('matches the read-only pattern with hyphen and without', () => {
    expect((classifyDuckdbError(new Error('database is read-only')) as McpError).data?.reason).toBe(
      'sql_read_only',
    );
    expect((classifyDuckdbError(new Error('database is readonly')) as McpError).data?.reason).toBe(
      'sql_read_only',
    );
  });

  it('classifies unmatched Error instances as DatabaseError preserving the cause', () => {
    const original = new Error('Out of memory');
    const result = classifyDuckdbError(original);
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.message).toBe('Out of memory');
    expect(mcp.cause).toBe(original);
  });

  it('classifies non-Error throws as DatabaseError with the stringified value in data', () => {
    const result = classifyDuckdbError('weird string thrown');
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.message).toMatch(/non-Error value/);
    expect(mcp.data?.value).toBe('weird string thrown');
  });

  // Issue #254 — classification is for raw engine errors only. A structured
  // McpError thrown inside a provider try block (ensureTableMissing's
  // register_as_clash, resolveExportPath's path validations) must pass
  // through unchanged instead of being reclassified to DatabaseError, which
  // stripped code, data.reason, and data.tableName.
  it('issue #254 — passes an already-structured McpError through unchanged', () => {
    const original = validationError(
      'Canvas table "df_x" already exists. Drop it before reusing the name.',
      { reason: 'register_as_clash', tableName: 'df_x' },
    );
    const result = classifyDuckdbError(original);
    expect(result).toBe(original); // same instance — not rewrapped
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(mcp.data?.reason).toBe('register_as_clash');
    expect(mcp.data?.tableName).toBe('df_x');
  });

  it('issue #254 — the McpError guard wins over message-pattern matching', () => {
    // Message matches the parser-error regex, but the value is already
    // classified — it must not be re-tagged sql_parse_error.
    const original = notFound('syntax detail: table gone', { reason: 'missing_table' });
    expect(classifyDuckdbError(original)).toBe(original);
  });

  it('matches "read only" with a plain space separator, not just a hyphen', () => {
    // The regex uses `.?` (any single char, optional) between "read" and
    // "only" — a space must match just as well as a hyphen or no separator.
    expect((classifyDuckdbError(new Error('database is read only')) as McpError).data?.reason).toBe(
      'sql_read_only',
    );
  });

  it('classifies a thrown null as DatabaseError with the stringified value', () => {
    const result = classifyDuckdbError(null);
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.message).toMatch(/non-Error value/);
    expect(mcp.data?.value).toBe('null');
  });

  it('classifies a thrown plain object as DatabaseError with the stringified value', () => {
    const result = classifyDuckdbError({ code: 42, detail: 'x' });
    expect(result).toBeInstanceOf(McpError);
    const mcp = result as McpError;
    expect(mcp.code).toBe(JsonRpcErrorCode.DatabaseError);
    expect(mcp.data?.value).toBe('[object Object]');
  });

  it('classifies a thrown number as DatabaseError with the stringified value', () => {
    const result = classifyDuckdbError(42);
    expect((result as McpError).data?.value).toBe('42');
  });
});
