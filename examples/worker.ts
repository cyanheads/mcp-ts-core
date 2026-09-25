/**
 * @fileoverview Example Cloudflare Worker entry point. Demonstrates how a consumer
 * server registers its definition barrels with `createWorkerHandler()`.
 * @module examples/worker
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { serverInstructions } from './mcp-server/server-instructions.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';

export default createWorkerHandler({
  name: 'example-mcp-server',
  title: 'example-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: serverInstructions,
});
