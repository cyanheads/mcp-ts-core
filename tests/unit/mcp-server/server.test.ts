/**
 * @fileoverview Test suite for createMcpServerInstance — server initialization,
 * registry wiring, capability registration, and error handling.
 * @module tests/mcp-server/server.test
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * File-level override of the global McpServer mock so the suite can read
 * constructor arguments. Without this we'd only see the stub class from
 * `tests/setup.ts`, which discards args. Static helpers expose the call log
 * to assertions; `clearCapturedArgs()` runs per-test to avoid cross-test
 * bleed.
 */
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const capturedArgs: unknown[][] = [];
  class McpServerMock {
    static getCapturedArgs(): unknown[][] {
      return capturedArgs;
    }
    static clearCapturedArgs(): void {
      capturedArgs.length = 0;
    }
    connect = vi.fn(async () => {});
    constructor(...args: unknown[]) {
      capturedArgs.push(args);
    }
  }
  class ResourceTemplateMock {
    match = vi.fn(() => null);
    render = vi.fn(() => '');
  }
  return { McpServer: McpServerMock, ResourceTemplate: ResourceTemplateMock };
});

// Mock logger and requestContextService
vi.mock('@/utils/internal/logger.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('@/utils/internal/requestContext.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    requestContextService: {
      createRequestContext: vi.fn(() => ({
        requestId: 'test-req-id',
        timestamp: new Date().toISOString(),
        operation: 'createMcpServerInstance',
      })),
    },
  };
});

import { createMcpServerInstance, type McpServerDeps } from '@/mcp-server/server.js';
import { logger } from '@/utils/internal/logger.js';

describe('createMcpServerInstance', () => {
  let mockToolRegistry: { registerAll: ReturnType<typeof vi.fn> };
  let mockResourceRegistry: { registerAll: ReturnType<typeof vi.fn> };
  let mockPromptRegistry: { registerAll: ReturnType<typeof vi.fn> };
  let deps: McpServerDeps;

  beforeEach(() => {
    vi.clearAllMocks();

    mockToolRegistry = { registerAll: vi.fn().mockResolvedValue(undefined) };
    mockResourceRegistry = { registerAll: vi.fn().mockResolvedValue(undefined) };
    mockPromptRegistry = { registerAll: vi.fn() };

    deps = {
      config: {
        mcpServerName: 'test-server',
        mcpServerVersion: '1.0.0',
      } as McpServerDeps['config'],
      toolRegistry: mockToolRegistry as unknown as McpServerDeps['toolRegistry'],
      resourceRegistry: mockResourceRegistry as unknown as McpServerDeps['resourceRegistry'],
      promptRegistry: mockPromptRegistry as unknown as McpServerDeps['promptRegistry'],
    };
  });

  it('should return an McpServer instance', async () => {
    const server = await createMcpServerInstance(deps);
    expect(server).toBeInstanceOf(McpServer);
  });

  it('should call ToolRegistry.registerAll', async () => {
    await createMcpServerInstance(deps);
    expect(mockToolRegistry.registerAll).toHaveBeenCalledTimes(1);
    expect(mockToolRegistry.registerAll).toHaveBeenCalledWith(expect.any(McpServer));
  });

  it('should call ResourceRegistry.registerAll', async () => {
    await createMcpServerInstance(deps);
    expect(mockResourceRegistry.registerAll).toHaveBeenCalledTimes(1);
  });

  it('should call PromptRegistry.registerAll', async () => {
    await createMcpServerInstance(deps);
    expect(mockPromptRegistry.registerAll).toHaveBeenCalledTimes(1);
  });

  it('should log initialization and success messages', async () => {
    await createMcpServerInstance(deps);
    expect(logger.debug).toHaveBeenCalledWith(
      'Initializing MCP server instance',
      expect.any(Object),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'All MCP capabilities registered successfully',
      expect.any(Object),
    );
  });

  it('should rethrow and log when tool registration fails', async () => {
    const regError = new Error('tool registration failed');
    mockToolRegistry.registerAll.mockRejectedValue(regError);

    await expect(createMcpServerInstance(deps)).rejects.toThrow('tool registration failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to register MCP capabilities',
      expect.objectContaining({ message: 'tool registration failed' }),
      expect.any(Object),
    );
  });

  it('should rethrow and log when resource registration fails', async () => {
    const regError = new Error('resource registration failed');
    mockResourceRegistry.registerAll.mockRejectedValue(regError);

    await expect(createMcpServerInstance(deps)).rejects.toThrow('resource registration failed');
    expect(logger.error).toHaveBeenCalled();
  });

  it('should handle non-Error throws during registration', async () => {
    mockToolRegistry.registerAll.mockRejectedValue('string error');

    await expect(createMcpServerInstance(deps)).rejects.toBe('string error');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to register MCP capabilities',
      expect.objectContaining({ message: 'string error' }),
      expect.any(Object),
    );
  });

  describe('instructions option (#91)', () => {
    const McpServerMock = McpServer as unknown as {
      clearCapturedArgs(): void;
      getCapturedArgs(): unknown[][];
    };

    /**
     * Reads the most recent McpServer constructor arguments captured by the
     * file-level mock. Asserts against the options bag (second argument) since
     * that's where `instructions` lives — see `tests/setup.ts` for the global
     * stub and the file's own vi.mock for the args-capturing override.
     */
    function lastConstructorOptions(): Record<string, unknown> | undefined {
      const calls = McpServerMock.getCapturedArgs();
      const last = calls[calls.length - 1];
      return last?.[1] as Record<string, unknown> | undefined;
    }

    beforeEach(() => {
      McpServerMock.clearCapturedArgs();
    });

    it('threads instructions into the McpServer options when provided', async () => {
      await createMcpServerInstance({
        ...deps,
        instructions: 'Use shortcut alpha for the most common case.',
      });
      expect(lastConstructorOptions()?.instructions).toBe(
        'Use shortcut alpha for the most common case.',
      );
    });

    it('omits instructions from McpServer options when option is unset', async () => {
      await createMcpServerInstance(deps);
      expect(lastConstructorOptions()).not.toHaveProperty('instructions');
    });

    it('does not pass through an empty string (falsy guard)', async () => {
      await createMcpServerInstance({ ...deps, instructions: '' });
      expect(lastConstructorOptions()).not.toHaveProperty('instructions');
    });
  });

  describe('server identity fields (#213)', () => {
    const McpServerMock = McpServer as unknown as {
      clearCapturedArgs(): void;
      getCapturedArgs(): unknown[][];
    };

    function lastServerInfo(): Record<string, unknown> | undefined {
      const calls = McpServerMock.getCapturedArgs();
      const last = calls[calls.length - 1];
      return last?.[0] as Record<string, unknown> | undefined;
    }

    beforeEach(() => {
      McpServerMock.clearCapturedArgs();
    });

    it('forwards title to McpServer serverInfo when provided', async () => {
      await createMcpServerInstance({ ...deps, title: 'My Server' });
      expect(lastServerInfo()?.title).toBe('My Server');
    });

    it('omits title from McpServer serverInfo when not provided', async () => {
      await createMcpServerInstance(deps);
      expect(lastServerInfo()).not.toHaveProperty('title');
    });

    it('forwards websiteUrl to McpServer serverInfo when provided', async () => {
      await createMcpServerInstance({
        ...deps,
        websiteUrl: 'https://github.com/owner/my-server',
      });
      expect(lastServerInfo()?.websiteUrl).toBe('https://github.com/owner/my-server');
    });

    it('omits websiteUrl from McpServer serverInfo when not provided', async () => {
      await createMcpServerInstance(deps);
      expect(lastServerInfo()).not.toHaveProperty('websiteUrl');
    });

    it('forwards description to McpServer serverInfo when provided', async () => {
      await createMcpServerInstance({ ...deps, description: 'My server description.' });
      expect(lastServerInfo()?.description).toBe('My server description.');
    });

    it('omits description from McpServer serverInfo when not provided', async () => {
      await createMcpServerInstance(deps);
      expect(lastServerInfo()).not.toHaveProperty('description');
    });

    it('forwards icons to McpServer serverInfo when provided', async () => {
      const icons = [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }];
      await createMcpServerInstance({ ...deps, icons });
      expect(lastServerInfo()?.icons).toEqual(icons);
    });

    it('omits icons from McpServer serverInfo when not provided', async () => {
      await createMcpServerInstance(deps);
      expect(lastServerInfo()).not.toHaveProperty('icons');
    });

    it('always includes name and version in serverInfo', async () => {
      await createMcpServerInstance({ ...deps, title: 'T', websiteUrl: 'https://x.com' });
      expect(lastServerInfo()).toMatchObject({
        name: 'test-server',
        version: '1.0.0',
      });
    });
  });
});
