/**
 * @fileoverview Graph service orchestrator.
 * Manages graph database operations with provider abstraction.
 * @module src/services/graph/core/GraphService
 */

import { logger } from '@/utils/internal/logger.js';
import { nowMs } from '@/utils/internal/performance.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_CODE_NAMESPACE,
  ATTR_MCP_GRAPH_DURATION_MS,
  ATTR_MCP_GRAPH_OPERATION,
  ATTR_MCP_GRAPH_SUCCESS,
} from '@/utils/telemetry/attributes.js';
import { createCounter, createHistogram } from '@/utils/telemetry/metrics.js';
import { withSpan } from '@/utils/telemetry/trace.js';
import type { GraphStats } from '../types.js';
import type {
  Edge,
  GraphPath,
  IGraphProvider,
  PathOptions,
  RelateOptions,
  TraversalOptions,
  TraversalResult,
} from './IGraphProvider.js';

let _graphOpCounter: ReturnType<typeof createCounter> | undefined;
let _graphOpDuration: ReturnType<typeof createHistogram> | undefined;
let _graphOpErrors: ReturnType<typeof createCounter> | undefined;

function getGraphMetrics() {
  _graphOpCounter ??= createCounter('mcp.graph.operations', 'Total graph operations', '{ops}');
  _graphOpDuration ??= createHistogram('mcp.graph.duration', 'Graph operation duration', 'ms');
  _graphOpErrors ??= createCounter('mcp.graph.errors', 'Total graph operation errors', '{errors}');
  return {
    graphOpCounter: _graphOpCounter,
    graphOpDuration: _graphOpDuration,
    graphOpErrors: _graphOpErrors,
  };
}

/**
 * Provider-agnostic service for graph database operations.
 *
 * @remarks
 * Wraps an {@link IGraphProvider} implementation and adds request-scoped debug
 * logging around every operation. All graph I/O — relationship management,
 * traversal, pathfinding, edge queries, statistics, and health checks — is
 * delegated to the injected provider.
 *
 * @example
 * ```ts
 * import { GraphService } from '@cyanheads/mcp-ts-core/services';
 * import { MyGraphProvider } from './my-graph-provider.js'; // implements IGraphProvider
 *
 * const graphService = new GraphService(new MyGraphProvider());
 *
 * // Create a relationship
 * const edge = await graphService.relate(
 *   'user:alice',
 *   'follows',
 *   'user:bob',
 *   context,
 *   { data: { since: '2025-01-01' } },
 * );
 *
 * // Traverse the graph
 * const result = await graphService.traverse('user:alice', context, {
 *   maxDepth: 2,
 *   edgeTypes: ['follows'],
 * });
 * ```
 */
export class GraphService {
  constructor(private readonly provider: IGraphProvider) {
    logger.info(`Graph service initialized with provider: ${provider.name}`);
  }

  /**
   * Wraps a provider call with an OTel span and standard graph metrics.
   * All public methods delegate here to avoid repeating the instrumentation boilerplate.
   */
  private async withGraphOp<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return await withSpan(
      `graph:${operation}`,
      async (span) => {
        const t0 = nowMs();
        let ok = false;
        try {
          const result = await fn();
          ok = true;
          return result;
        } finally {
          const durationMs = Math.round((nowMs() - t0) * 100) / 100;
          span.setAttribute(ATTR_MCP_GRAPH_DURATION_MS, durationMs);
          span.setAttribute(ATTR_MCP_GRAPH_SUCCESS, ok);
          const m = getGraphMetrics();
          const attrs = { [ATTR_MCP_GRAPH_OPERATION]: operation, [ATTR_MCP_GRAPH_SUCCESS]: ok };
          m.graphOpCounter.add(1, attrs);
          m.graphOpDuration.record(durationMs, attrs);
          if (!ok) m.graphOpErrors.add(1, { [ATTR_MCP_GRAPH_OPERATION]: operation });
        }
      },
      {
        [ATTR_CODE_FUNCTION_NAME]: operation,
        [ATTR_CODE_NAMESPACE]: 'GraphService',
        [ATTR_MCP_GRAPH_OPERATION]: operation,
      },
    );
  }

  /**
   * Return the underlying {@link IGraphProvider} instance.
   * Useful for accessing provider-specific extensions not exposed by this service.
   *
   * @returns The active graph provider
   *
   * @example
   * ```ts
   * const provider = graphService.getProvider();
   * console.log(provider.name); // e.g. 'mock'
   * ```
   */
  getProvider(): IGraphProvider {
    return this.provider;
  }

  /**
   * Create a directed relationship edge between two vertices.
   *
   * @param from - ID of the source vertex
   * @param edgeTable - Table (type) name for the edge (e.g. `'follows'`)
   * @param to - ID of the target vertex
   * @param context - Request context used for correlated logging
   * @param options - Optional edge payload and duplicate-handling behaviour
   * @returns The newly created edge
   * @throws {Error} If either vertex does not exist or the provider rejects a duplicate
   *
   * @example
   * ```ts
   * const edge = await graphService.relate('user:alice', 'follows', 'user:bob', context, {
   *   data: { since: '2025-01-01' },
   * });
   * ```
   */
  async relate(
    from: string,
    edgeTable: string,
    to: string,
    context: RequestContext,
    options?: RelateOptions,
  ): Promise<Edge> {
    logger.debug(`[GraphService] Creating relationship: ${from} -[${edgeTable}]-> ${to}`, context);

    return await this.withGraphOp('relate', () =>
      this.provider.relate(from, edgeTable, to, context, options),
    );
  }

  /**
   * Delete a relationship edge by its ID.
   *
   * @param edgeId - ID of the edge to remove
   * @param context - Request context used for correlated logging
   * @returns `true` if the edge was found and deleted, `false` if it did not exist
   * @throws {Error} If the provider encounters a storage error
   *
   * @example
   * ```ts
   * const deleted = await graphService.unrelate('follows:1', context);
   * ```
   */
  async unrelate(edgeId: string, context: RequestContext): Promise<boolean> {
    logger.debug(`[GraphService] Deleting relationship: ${edgeId}`, context);

    return await this.withGraphOp('unrelate', () => this.provider.unrelate(edgeId, context));
  }

  /**
   * Traverse the graph outward (or inward/both) from a starting vertex.
   *
   * @param startVertexId - ID of the vertex to begin traversal from
   * @param context - Request context used for correlated logging
   * @param options - Direction, depth limit, edge/vertex type filters, and WHERE expression
   * @returns All discovered paths and the resolved start vertex
   * @throws {Error} If the start vertex does not exist or the provider query fails
   *
   * @example
   * ```ts
   * const result = await graphService.traverse('user:alice', context, {
   *   maxDepth: 2,
   *   edgeTypes: ['follows'],
   *   direction: 'out',
   * });
   * console.log(`Found ${result.paths.length} paths`);
   * ```
   */
  async traverse(
    startVertexId: string,
    context: RequestContext,
    options?: TraversalOptions,
  ): Promise<TraversalResult> {
    logger.debug(`[GraphService] Traversing from: ${startVertexId}`, context);

    return await this.withGraphOp('traverse', () =>
      this.provider.traverse(startVertexId, context, options),
    );
  }

  /**
   * Find the lowest-cost path between two vertices using the specified algorithm.
   *
   * @param from - ID of the source vertex
   * @param to - ID of the target vertex
   * @param context - Request context used for correlated logging
   * @param options - Algorithm selection, depth limit, and optional weight function
   * @returns The shortest path, or `null` if no path exists within the constraints
   * @throws {Error} If the provider encounters a storage or query error
   *
   * @example
   * ```ts
   * const path = await graphService.shortestPath('user:alice', 'user:charlie', context, {
   *   algorithm: 'bfs',
   *   maxLength: 4,
   * });
   * if (path) console.log(`${path.vertices.length} hops`);
   * ```
   */
  async shortestPath(
    from: string,
    to: string,
    context: RequestContext,
    options?: PathOptions,
  ): Promise<GraphPath | null> {
    logger.debug(`[GraphService] Finding shortest path: ${from} -> ${to}`, context);

    return await this.withGraphOp('shortestPath', () =>
      this.provider.shortestPath(from, to, context, options),
    );
  }

  /**
   * Get all outgoing edges originating from a vertex.
   *
   * @param vertexId - ID of the source vertex
   * @param context - Request context used for correlated logging
   * @param edgeTypes - When provided, only edges belonging to these tables are returned
   * @returns Array of matching outgoing edges, or an empty array if none
   * @throws {Error} If the provider encounters a storage or query error
   *
   * @example
   * ```ts
   * const edges = await graphService.getOutgoingEdges('user:alice', context, ['follows']);
   * ```
   */
  async getOutgoingEdges(
    vertexId: string,
    context: RequestContext,
    edgeTypes?: string[],
  ): Promise<Edge[]> {
    return await this.withGraphOp('getOutgoingEdges', () =>
      this.provider.getOutgoingEdges(vertexId, context, edgeTypes),
    );
  }

  /**
   * Get all incoming edges directed at a vertex.
   *
   * @param vertexId - ID of the target vertex
   * @param context - Request context used for correlated logging
   * @param edgeTypes - When provided, only edges belonging to these tables are returned
   * @returns Array of matching incoming edges, or an empty array if none
   * @throws {Error} If the provider encounters a storage or query error
   *
   * @example
   * ```ts
   * const edges = await graphService.getIncomingEdges('user:bob', context, ['follows']);
   * ```
   */
  async getIncomingEdges(
    vertexId: string,
    context: RequestContext,
    edgeTypes?: string[],
  ): Promise<Edge[]> {
    return await this.withGraphOp('getIncomingEdges', () =>
      this.provider.getIncomingEdges(vertexId, context, edgeTypes),
    );
  }

  /**
   * Determine whether any path exists between two vertices without returning it.
   * More efficient than `shortestPath` when only reachability is needed.
   *
   * @param from - ID of the source vertex
   * @param to - ID of the target vertex
   * @param context - Request context used for correlated logging
   * @param maxDepth - Maximum hop count to search. Unbounded when omitted.
   * @returns `true` if at least one path exists within the depth limit
   * @throws {Error} If the provider encounters a storage or query error
   *
   * @example
   * ```ts
   * const connected = await graphService.pathExists('user:alice', 'user:charlie', context, 3);
   * ```
   */
  async pathExists(
    from: string,
    to: string,
    context: RequestContext,
    maxDepth?: number,
  ): Promise<boolean> {
    return await this.withGraphOp('pathExists', () =>
      this.provider.pathExists(from, to, context, maxDepth),
    );
  }

  /**
   * Compute aggregate statistics about the current graph.
   *
   * @param context - Request context used for correlated logging
   * @returns Snapshot of vertex/edge counts and per-type breakdowns
   * @throws {Error} If the provider cannot compute statistics
   *
   * @example
   * ```ts
   * const stats = await graphService.getStats(context);
   * console.log(`${stats.vertexCount} vertices, avg degree ${stats.avgDegree}`);
   * ```
   */
  async getStats(context: RequestContext): Promise<GraphStats> {
    logger.debug('[GraphService] Getting graph statistics', context);

    return await this.withGraphOp('getStats', () => this.provider.getStats(context));
  }

  /**
   * Perform a liveness check on the underlying graph provider.
   *
   * @returns `true` if the provider is reachable and operational, `false` otherwise
   *
   * @example
   * ```ts
   * if (!(await graphService.healthCheck())) {
   *   throw new Error('Graph provider is unhealthy');
   * }
   * ```
   */
  async healthCheck(): Promise<boolean> {
    return await this.withGraphOp('healthCheck', () => this.provider.healthCheck());
  }
}
