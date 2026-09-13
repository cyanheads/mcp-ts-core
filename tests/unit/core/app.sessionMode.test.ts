/**
 * @fileoverview Tests for the `createApp` `sessionMode` option (#376) — its
 * precedence against `MCP_SESSION_MODE`, what it publishes on the manifest, and
 * the startup refusal a declared `stateful` requirement produces.
 *
 * Deliberately runs against the real config module rather than a stub: the
 * empty-string and unsubstituted-placeholder cases are decisions `parseConfig`
 * makes during normalization, and a mocked config object cannot express them.
 * @module tests/unit/core/app.sessionMode.test
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config, resetConfig } from '@/config/index.js';
import { type CreateAppOptions, composeServices } from '@/core/app.js';
import { JsonRpcErrorCode } from '@/types-global/errors.js';

const originalEnv = { ...process.env };

/** Composes services and disposes what they allocated, returning the manifest. */
async function compose(options: CreateAppOptions = {}) {
  const composed = await composeServices(options);
  composed.coreServices.rateLimiter.dispose();
  return composed;
}

/** An install-time `${…}` reference nothing substituted. */
const placeholder = `\${${'user_config.session_mode'}}`;

describe('createApp sessionMode (#376)', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MCP_TRANSPORT_TYPE = 'http';
    delete process.env.MCP_SESSION_MODE;
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  describe('precedence', () => {
    it('seeds the mode when the environment sets none', async () => {
      const { manifest } = await compose({ sessionMode: 'stateless' });

      expect(config.mcpSessionMode).toBe('stateless');
      expect(manifest.transport.sessionMode).toBe('stateless');
    });

    it('yields to a meaningful MCP_SESSION_MODE', async () => {
      process.env.MCP_SESSION_MODE = 'stateful';

      const { manifest } = await compose({ sessionMode: 'stateless' });

      expect(config.mcpSessionMode).toBe('stateful');
      expect(manifest.transport.sessionMode).toBe('stateful');
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['an unsubstituted placeholder', placeholder],
    ])('falls through to the option when MCP_SESSION_MODE is %s', async (_label, value) => {
      process.env.MCP_SESSION_MODE = value;

      const { manifest } = await compose({ sessionMode: 'stateless' });

      // Not the schema default (`auto`, which resolves to stateful).
      expect(config.mcpSessionMode).toBe('stateless');
      expect(manifest.transport.sessionMode).toBe('stateless');
    });

    it('reads the bare string as shorthand for { default }', async () => {
      const bare = await compose({ sessionMode: 'stateful' });
      const bareMode = config.mcpSessionMode;

      delete process.env.MCP_SESSION_MODE;
      resetConfig();
      const object = await compose({ sessionMode: { default: 'stateful' } });

      expect(bareMode).toBe('stateful');
      expect(config.mcpSessionMode).toBe('stateful');
      expect(object.manifest.transport.sessionMode).toBe(bare.manifest.transport.sessionMode);
    });

    it('leaves the schema default in place when the option is absent', async () => {
      const { manifest } = await compose();

      expect(config.mcpSessionMode).toBe('auto');
      expect(process.env.MCP_SESSION_MODE).toBeUndefined();
      expect(manifest.transport.sessionMode).toBe('stateful');
    });

    it.each([
      [undefined, undefined],
      ['stateless' as const, undefined],
      ['stateful' as const, undefined],
      ['auto' as const, undefined],
      [undefined, 'auto'],
      ['stateless' as const, 'auto'],
      ['auto' as const, 'stateful'],
    ])('never advertises `auto` (option %s, env %s)', async (option, env) => {
      if (env === undefined) delete process.env.MCP_SESSION_MODE;
      else process.env.MCP_SESSION_MODE = env;
      resetConfig();

      const { manifest } = await compose(option ? { sessionMode: option } : {});

      expect(['stateful', 'stateless']).toContain(manifest.transport.sessionMode);
    });
  });

  describe('declared stateful requirement', () => {
    it('refuses startup over HTTP when the resolved mode is stateless', async () => {
      process.env.MCP_SESSION_MODE = 'stateless';

      const error = await composeServices({
        sessionMode: { default: 'stateful', require: 'stateful' },
      }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeMcpError(JsonRpcErrorCode.ConfigurationError);
      expect((error as Error).message).toContain("sessionMode.require: 'stateful'");
      expect((error as Error).message).toContain('MCP_SESSION_MODE=stateless');
      expect((error as Error).message).toContain('Set MCP_SESSION_MODE=stateful or unset it.');
    });

    it('refuses when the option itself resolves stateless, naming the option as the cause', async () => {
      const error = await composeServices({
        sessionMode: { default: 'stateless', require: 'stateful' },
      }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeMcpError(JsonRpcErrorCode.ConfigurationError);
      expect((error as Error).message).toContain("sessionMode.default: 'stateless' contradicts");
      expect((error as Error).message).not.toContain('unset it');
    });

    it.each(['stateful', 'auto'] as const)('accepts a resolved %s mode', async (mode) => {
      process.env.MCP_SESSION_MODE = mode;

      const { manifest } = await compose({ sessionMode: { require: 'stateful' } });

      expect(manifest.transport.sessionMode).toBe('stateful');
    });

    it.each(['stateless', 'stateful', 'auto', ''] as const)(
      'never refuses a stdio start (MCP_SESSION_MODE=%s)',
      async (mode) => {
        process.env.MCP_TRANSPORT_TYPE = 'stdio';
        process.env.MCP_SESSION_MODE = mode;
        resetConfig();

        await expect(
          compose({ sessionMode: { default: 'stateful', require: 'stateful' } }),
        ).resolves.toBeDefined();
      },
    );

    it('refuses before any service is constructed', async () => {
      process.env.MCP_SESSION_MODE = 'stateless';
      let setupRan = false;

      await expect(
        composeServices({
          sessionMode: { require: 'stateful' },
          setup: () => {
            setupRan = true;
          },
        }),
      ).rejects.toBeDefined();

      expect(setupRan).toBe(false);
    });
  });
});
