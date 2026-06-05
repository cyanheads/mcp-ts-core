/**
 * @fileoverview Unit tests for configuration parsing.
 * @module tests/config/index.test
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../../src/types-global/errors.js';

const originalEnv = { ...process.env };
const originalIsTTY = process.stdout.isTTY;

let parseConfig: typeof import('../../../src/config/index.js').parseConfig;

beforeAll(async () => {
  ({ parseConfig } = await import('../../../src/config/index.js'));
});

describe('config parsing', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.stdout.isTTY = originalIsTTY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.stdout.isTTY = originalIsTTY;
  });

  it('normalizes aliases, trims arrays, and applies defaults', async () => {
    process.env.MCP_LOG_LEVEL = 'Warning';
    process.env.NODE_ENV = 'prod';
    process.env.MCP_ALLOWED_ORIGINS = 'https://a.example.com, https://b.example.com ';
    process.env.DEV_MCP_SCOPES = 'scope:read, scope:write';
    process.env.STORAGE_PROVIDER_TYPE = 'fs';
    process.env.MCP_SESSION_MODE = ''; // exercise empty-string sanitization
    process.env.OTEL_ENABLED = 'true';
    process.env.OTEL_LOG_LEVEL = 'warning';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.5';
    process.env.OPENROUTER_APP_URL = 'https://app.example.com';
    delete process.env.OPENROUTER_APP_NAME;
    delete process.env.LOGS_DIR;
    process.env.LLM_DEFAULT_TEMPERATURE = '0.7';

    const parsed = parseConfig();

    expect(parsed.logLevel).toBe('warning');
    expect(parsed.environment).toBe('production');
    expect(parsed.mcpSessionMode).toBe('auto');
    expect(parsed.mcpAllowedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(parsed.devMcpScopes).toEqual(['scope:read', 'scope:write']);
    expect(parsed.storage.providerType).toBe('filesystem');
    expect(parsed.logsPath).toMatch(/logs$/);
    expect(parsed.openTelemetry.enabled).toBe(true);
    expect(parsed.openTelemetry.logLevel).toBe('WARN');
    expect(parsed.openTelemetry.samplingRatio).toBe(0.5);
    expect(parsed.openrouterAppUrl).toBe('https://app.example.com');
    expect(parsed.openrouterAppName).toBe('@cyanheads/mcp-ts-core');
    expect(parsed.llmDefaultTemperature).toBeCloseTo(0.7);
  });

  it('derives mcpServerKeywords from PACKAGE_KEYWORDS (comma-split, trimmed, empties dropped)', () => {
    process.env.PACKAGE_KEYWORDS = 'health, medical ,epidemiology,';
    const parsed = parseConfig();
    expect(parsed.mcpServerKeywords).toEqual(['health', 'medical', 'epidemiology']);
  });

  it('rejects DEV_MCP_AUTH_BYPASS=true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_MCP_AUTH_BYPASS = 'true';
    process.env.MCP_AUTH_MODE = 'jwt';
    process.env.MCP_AUTH_SECRET_KEY = 'a-secret-key-that-is-at-least-32-chars';

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const mcpError = thrown as McpError;
    expect(mcpError.code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('allows DEV_MCP_AUTH_BYPASS=true in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEV_MCP_AUTH_BYPASS = 'true';
    process.env.MCP_AUTH_MODE = 'jwt';

    const parsed = parseConfig();
    expect(parsed.devMcpAuthBypass).toBe(true);
  });

  it('treats DEV_MCP_AUTH_BYPASS=false as disabled (not truthy-coerced)', () => {
    process.env.NODE_ENV = 'development';
    process.env.MCP_AUTH_MODE = 'jwt';
    process.env.MCP_AUTH_SECRET_KEY = 'a-secret-key-that-is-at-least-32-chars';

    for (const value of ['false', '0', 'no', 'FALSE']) {
      process.env.DEV_MCP_AUTH_BYPASS = value;
      const parsed = parseConfig();
      expect(parsed.devMcpAuthBypass).toBe(false);
    }
  });

  it('parses env boolean flags via stringbool (the z.coerce.boolean footgun fix)', () => {
    for (const value of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
      process.env.OTEL_ENABLED = value;
      expect(parseConfig().openTelemetry.enabled, `OTEL_ENABLED=${value}`).toBe(false);
    }
    for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'On']) {
      process.env.OTEL_ENABLED = value;
      expect(parseConfig().openTelemetry.enabled, `OTEL_ENABLED=${value}`).toBe(true);
    }
  });

  it('defaults env boolean flags to false when unset or empty', () => {
    delete process.env.OTEL_ENABLED;
    expect(parseConfig().openTelemetry.enabled).toBe(false);
    process.env.OTEL_ENABLED = '';
    expect(parseConfig().openTelemetry.enabled).toBe(false);
  });

  it('rejects an unrecognized env boolean value instead of silently coercing it', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTEL_ENABLED = 'enable'; // plausible typo for "enabled" — must fail loudly

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
    consoleSpy.mockRestore();
  });

  it('parses MCP_PUBLIC_URL when set, defaults to undefined', () => {
    expect(parseConfig().mcpPublicUrl).toBeUndefined();

    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com';
    expect(parseConfig().mcpPublicUrl).toBe('https://mcp.example.com');

    process.env.MCP_PUBLIC_URL = '';
    expect(parseConfig().mcpPublicUrl).toBeUndefined();
  });

  it('rejects MCP_PUBLIC_URL that is not a valid URL', () => {
    process.env.MCP_PUBLIC_URL = 'not-a-url';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.stdout.isTTY = true;

    expect(() => parseConfig()).toThrow(McpError);
    consoleSpy.mockRestore();
  });

  it('throws a configuration error when validation fails', async () => {
    // Mock console.error BEFORE setting isTTY to suppress output during tests
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.env.MCP_LOG_LEVEL = 'invalid-level';
    process.stdout.isTTY = true;

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const mcpError = thrown as McpError;
    expect(mcpError.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(consoleSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration found. Please check your environment variables.',
      expect.any(Object),
    );

    consoleSpy.mockRestore();
  });
});
