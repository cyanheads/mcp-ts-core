/**
 * @fileoverview Tests for GraphService OTel metrics recording.
 * Verifies that `withGraphOp` records the correct counters, histograms,
 * and error metrics via public methods (relate, traverse, etc.).
 * @module tests/unit/services/graph/core/GraphService.metrics.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCounterAdd = vi.fn();
const mockHistogramRecord = vi.fn();
const mockErrorAdd = vi.fn();

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn((name: string) =>
    name.includes('errors') ? { add: mockErrorAdd } : { add: mockCounterAdd },
  ),
  createHistogram: vi.fn(() => ({ record: mockHistogramRecord })),
}));

vi.mock('@/utils/telemetry/trace.js', () => ({
  withSpan: vi.fn(async (_name: string, fn: (span: any) => Promise<any>) =>
    fn({ setAttribute: vi.fn(), setAttributes: vi.fn() }),
  ),
}));

vi.mock('@/utils/internal/performance.js', () => ({
  nowMs: vi
    .fn()
    .mockReturnValueOnce(100) // t0 captured inside withGraphOp
    .mockReturnValueOnce(150), // nowMs() in finally block → duration = 50ms
}));

vi.mock('@/utils/internal/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import { GraphService } from '@/services/graph/core/GraphService.js';
import type { IGraphProvider } from '@/services/graph/core/IGraphProvider.js';
import { nowMs } from '@/utils/internal/performance.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

function createMockProvider(overrides: Partial<IGraphProvider> = {}): IGraphProvider {
  return {
    name: 'mock',
    relate: vi.fn().mockResolvedValue({
      id: 'edge:1',
      table: 'follows',
      from: 'a',
      to: 'b',
      data: {},
    }),
    unrelate: vi.fn().mockResolvedValue(true),
    traverse: vi.fn().mockResolvedValue({
      start: { id: 'a', table: 'node', data: {} },
      paths: [],
    }),
    shortestPath: vi.fn().mockResolvedValue(null),
    getOutgoingEdges: vi.fn().mockResolvedValue([]),
    getIncomingEdges: vi.fn().mockResolvedValue([]),
    pathExists: vi.fn().mockResolvedValue(true),
    getStats: vi.fn().mockResolvedValue({
      vertexCount: 0,
      edgeCount: 0,
      avgDegree: 0,
      vertexTypes: {},
      edgeTypes: {},
    }),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const ctx: RequestContext = {
  requestId: 'r1',
  timestamp: new Date().toISOString(),
  operation: 'test',
};

describe('GraphService metrics', () => {
  beforeEach(() => {
    mockCounterAdd.mockClear();
    mockHistogramRecord.mockClear();
    mockErrorAdd.mockClear();
    // Reset nowMs sequence for each test
    vi.mocked(nowMs).mockReset().mockReturnValueOnce(100).mockReturnValueOnce(150);
  });

  describe('relate success', () => {
    it('records counter and duration with correct attributes', async () => {
      const provider = createMockProvider();
      const service = new GraphService(provider);

      await service.relate('a', 'follows', 'b', ctx);

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.graph.operation': 'relate',
        'mcp.graph.success': true,
      });
      expect(mockHistogramRecord).toHaveBeenCalledWith(50, {
        'mcp.graph.operation': 'relate',
        'mcp.graph.success': true,
      });
    });
  });

  describe('relate error', () => {
    it('records counter with success=false and error counter', async () => {
      const provider = createMockProvider({
        relate: vi.fn().mockRejectedValue(new Error('DB down')),
      });
      const service = new GraphService(provider);

      await expect(service.relate('a', 'follows', 'b', ctx)).rejects.toThrow('DB down');

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.graph.operation': 'relate',
        'mcp.graph.success': false,
      });
      expect(mockErrorAdd).toHaveBeenCalledWith(1, {
        'mcp.graph.operation': 'relate',
      });
    });
  });

  describe('traverse success', () => {
    it('records counter and duration with operation=traverse', async () => {
      const provider = createMockProvider();
      const service = new GraphService(provider);

      await service.traverse('a', ctx);

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        'mcp.graph.operation': 'traverse',
        'mcp.graph.success': true,
      });
      expect(mockHistogramRecord).toHaveBeenCalledWith(50, {
        'mcp.graph.operation': 'traverse',
        'mcp.graph.success': true,
      });
      expect(mockErrorAdd).not.toHaveBeenCalled();
    });
  });

  describe('traverse error', () => {
    it('records error counter with operation attribute', async () => {
      const provider = createMockProvider({
        traverse: vi.fn().mockRejectedValue(new Error('Traversal failed')),
      });
      const service = new GraphService(provider);

      await expect(service.traverse('a', ctx)).rejects.toThrow('Traversal failed');

      expect(mockErrorAdd).toHaveBeenCalledWith(1, {
        'mcp.graph.operation': 'traverse',
      });
    });
  });
});
