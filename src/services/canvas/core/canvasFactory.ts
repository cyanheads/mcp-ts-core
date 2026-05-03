/**
 * @fileoverview Factory for the optional DataCanvas service. Switches on
 * `config.canvas.providerType`, fails closed in serverless for `duckdb`, and
 * returns `undefined` when canvas is disabled. The factory does not eager-load
 * `@duckdb/node-api`; the provider lazy-loads on first use.
 *
 * @module src/services/canvas/core/canvasFactory
 */

import type { AppConfig } from '@/config/index.js';
import { configurationError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

import { DuckdbProvider } from '../providers/duckdb/DuckdbProvider.js';
import { CanvasRegistry } from './CanvasRegistry.js';
import { DataCanvas } from './DataCanvas.js';

/** Evaluated at call time so worker.ts can set IS_SERVERLESS before first use. */
function isServerless(): boolean {
  return typeof process === 'undefined' || process.env.IS_SERVERLESS === 'true';
}

/**
 * Construct the canvas service from configuration. Returns `undefined` when
 * canvas is disabled. Fails closed with `ConfigurationError` in serverless
 * environments when `CANVAS_PROVIDER_TYPE=duckdb` — DuckDB has no V8-isolate
 * build, so canvas is unavailable on Workers.
 */
export function createCanvasService(config: AppConfig): DataCanvas | undefined {
  const providerType = config.canvas.providerType;
  if (providerType === 'none') return;

  const context = requestContextService.createRequestContext({
    operation: 'createCanvasService',
  });

  if (providerType === 'duckdb') {
    if (isServerless()) {
      throw configurationError(
        'DuckDB canvas requires Node.js or Bun. Set CANVAS_PROVIDER_TYPE=none or omit it for Cloudflare Workers deployment.',
        context,
      );
    }
    logger.info('Creating DuckDB canvas provider', context);
    const provider = new DuckdbProvider({
      memoryLimitMb: config.canvas.defaultMemoryLimitMb,
      exportRootPath: config.canvas.exportRootPath,
      defaultRowLimit: config.canvas.defaultRowLimit,
      schemaSniffRows: config.canvas.schemaSniffRows,
    });
    const registry = new CanvasRegistry(provider, {
      ttlMs: config.canvas.ttlMs,
      absoluteCapMs: config.canvas.absoluteCapMs,
      maxCanvasesPerTenant: config.canvas.maxCanvasesPerTenant,
      sweeperIntervalMs: config.canvas.sweeperIntervalMs,
    });
    return new DataCanvas(provider, registry);
  }

  const exhaustive: never = providerType;
  throw configurationError(`Unhandled canvas provider type: ${String(exhaustive)}`, context);
}
