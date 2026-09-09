/**
 * @fileoverview Type definitions for the graph service layer.
 * Re-exports core graph primitives from IGraphProvider and defines the
 * service-level statistics type.
 * @module src/services/graph/types
 */

export type {
  Edge,
  GraphPath,
  PathOptions,
  RelateOptions,
  TraversalDirection,
  TraversalOptions,
  TraversalResult,
  Vertex,
} from './core/IGraphProvider.js';

/**
 * Aggregate statistics describing the current state of a graph.
 *
 * @example
 * ```ts
 * const stats: GraphStats = await graphService.getStats(context);
 * console.log(`${stats.vertexCount} vertices, ${stats.edgeCount} edges`);
 * console.log(`Avg degree: ${stats.avgDegree}`);
 * ```
 */
export interface GraphStats {
  /** Mean number of edges per vertex across the entire graph */
  avgDegree: number;
  /** Total number of edges (relationships) in the graph */
  edgeCount: number;
  /** Map of edge table name to count of edges of that type */
  edgeTypes: Record<string, number>;
  /** Total number of vertices (nodes) in the graph */
  vertexCount: number;
  /** Map of vertex table name to count of vertices of that type */
  vertexTypes: Record<string, number>;
}
