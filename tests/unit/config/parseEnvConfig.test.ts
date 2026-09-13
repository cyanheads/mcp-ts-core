/**
 * @fileoverview Unit tests for parseEnvConfig helper.
 * @module tests/unit/config/parseEnvConfig.test
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseEnvConfig } from '../../../src/config/parseEnvConfig.js';
import { JsonRpcErrorCode, McpError } from '../../../src/types-global/errors.js';

const Schema = z.object({
  apiKey: z.string().describe('External API key'),
  maxResults: z.coerce.number().default(100),
  enabled: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
});

const envMap = {
  apiKey: 'MY_API_KEY',
  maxResults: 'MY_MAX_RESULTS',
  enabled: 'MY_ENABLED',
};

describe('parseEnvConfig', () => {
  it('parses valid env into typed config', () => {
    const env = { MY_API_KEY: 'sk-123', MY_MAX_RESULTS: '50', MY_ENABLED: 'true' };
    const result = parseEnvConfig(Schema, envMap, env);
    expect(result).toEqual({ apiKey: 'sk-123', maxResults: 50, enabled: true });
  });

  it('applies Zod defaults when env var absent', () => {
    const env = { MY_API_KEY: 'sk-123' };
    const result = parseEnvConfig(Schema, envMap, env);
    expect(result.maxResults).toBe(100);
  });

  it('throws ConfigurationError naming the env var when required field missing', () => {
    const env = {};
    try {
      parseEnvConfig(Schema, envMap, env);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.code).toBe(JsonRpcErrorCode.ConfigurationError);
      expect(mcpErr.message).toContain('MY_API_KEY');
      expect(mcpErr.message).toContain('apiKey');
    }
  });

  it('includes the env var name in structured data.issues', () => {
    try {
      parseEnvConfig(Schema, envMap, {});
      expect.fail('should have thrown');
    } catch (err) {
      const mcpErr = err as McpError;
      const issues = mcpErr.data?.issues as Array<{ envVar: string; path: string }>;
      expect(issues).toBeDefined();
      expect(issues[0]?.envVar).toBe('MY_API_KEY');
      expect(issues[0]?.path).toBe('apiKey');
    }
  });

  it('reports multiple missing env vars in one error', () => {
    const RequireTwo = z.object({
      apiKey: z.string(),
      secret: z.string(),
    });
    const map = { apiKey: 'MY_API_KEY', secret: 'MY_SECRET' };
    try {
      parseEnvConfig(RequireTwo, map, {});
      expect.fail('should have thrown');
    } catch (err) {
      const mcpErr = err as McpError;
      expect(mcpErr.message).toContain('MY_API_KEY');
      expect(mcpErr.message).toContain('MY_SECRET');
    }
  });

  it('falls back to the schema path when no envMap entry exists', () => {
    const WithExtra = z.object({
      apiKey: z.string(),
      unmapped: z.string(),
    });
    const partialMap = { apiKey: 'MY_API_KEY' };
    try {
      parseEnvConfig(WithExtra, partialMap, { MY_API_KEY: 'x' });
      expect.fail('should have thrown');
    } catch (err) {
      const mcpErr = err as McpError;
      // When envMap has no entry, the schema path itself is shown.
      expect(mcpErr.message).toContain('unmapped');
    }
  });

  describe('values that mean "not provided"', () => {
    // Built without a template-literal-shaped string so Biome's
    // noTemplateCurlyInString does not flag a deliberate placeholder.
    const placeholder = (name: string) => ['$', '{', name, '}'].join('');

    it('treats an unsubstituted placeholder on a required field as missing', () => {
      const env = { MY_API_KEY: placeholder('user_config.api_key') };
      try {
        parseEnvConfig(Schema, envMap, env);
        expect.fail('should have thrown');
      } catch (err) {
        const mcpErr = err as McpError;
        expect(mcpErr.code).toBe(JsonRpcErrorCode.ConfigurationError);
        expect(mcpErr.message).toContain('MY_API_KEY');
        expect(mcpErr.message).not.toContain('user_config');
      }
    });

    it('treats an unsubstituted placeholder on an optional field as unset', () => {
      const Optional = z.object({ email: z.email().optional() });
      const result = parseEnvConfig(
        Optional,
        { email: 'MY_EMAIL' },
        { MY_EMAIL: placeholder('MY_EMAIL') },
      );
      expect(result.email).toBeUndefined();
    });

    it('lets a placeholder fall through to the field default', () => {
      const env = { MY_API_KEY: 'sk-123', MY_MAX_RESULTS: placeholder('user_config.max') };
      expect(parseEnvConfig(Schema, envMap, env).maxResults).toBe(100);
    });

    it('treats an empty string as unset', () => {
      const env = { MY_API_KEY: 'sk-123', MY_MAX_RESULTS: '' };
      expect(parseEnvConfig(Schema, envMap, env).maxResults).toBe(100);
    });

    it('passes a value that merely contains a placeholder through unchanged', () => {
      const inner = `prefix-${placeholder('x')}-suffix`;
      const env = { MY_API_KEY: inner };
      expect(parseEnvConfig(Schema, envMap, env).apiKey).toBe(inner);
    });
  });

  it('defaults to process.env when env argument is omitted', () => {
    const prev = process.env.MY_API_KEY;
    process.env.MY_API_KEY = 'from-process';
    try {
      const result = parseEnvConfig(Schema, envMap);
      expect(result.apiKey).toBe('from-process');
    } finally {
      if (prev === undefined) {
        delete process.env.MY_API_KEY;
      } else {
        process.env.MY_API_KEY = prev;
      }
    }
  });
});
