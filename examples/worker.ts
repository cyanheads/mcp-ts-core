/**
 * @fileoverview Example Cloudflare Worker entry point. Demonstrates how a consumer
 * server uses `createWorkerHandler()` with tool/resource/prompt definitions.
 * @module examples/worker
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { asyncCountdownTool } from './mcp-server/tools/definitions/template-async-countdown.tool.js';
import { catFactTool } from './mcp-server/tools/definitions/template-cat-fact.tool.js';
import { dataExplorerAppTool } from './mcp-server/tools/definitions/template-data-explorer.app-tool.js';
import { echoTool } from './mcp-server/tools/definitions/template-echo-message.tool.js';
import { imageTestTool } from './mcp-server/tools/definitions/template-image-test.tool.js';
import { madlibsElicitationTool } from './mcp-server/tools/definitions/template-madlibs-elicitation.tool.js';
import { dataExplorerUiResource } from './mcp-server/resources/definitions/data-explorer-ui.app-resource.js';
import { echoResourceDefinition } from './mcp-server/resources/definitions/echo.resource.js';
import { codeReviewPrompt } from './mcp-server/prompts/definitions/code-review.prompt.js';

export default createWorkerHandler({
  name: 'example-mcp-server',
  version: '0.1.0',
  tools: [
    catFactTool,
    echoTool,
    imageTestTool,
    madlibsElicitationTool,
    asyncCountdownTool,
    dataExplorerAppTool,
  ],
  resources: [echoResourceDefinition, dataExplorerUiResource],
  prompts: [codeReviewPrompt],
});
