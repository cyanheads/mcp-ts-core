#!/usr/bin/env node
/**
 * @fileoverview Example server entry point. Demonstrates how a consumer server
 * registers tool/resource/prompt definitions and starts via `createApp()`.
 * @module examples/index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { asyncCountdownTool } from './mcp-server/tools/definitions/template-async-countdown.tool.js';
import { catFactTool } from './mcp-server/tools/definitions/template-cat-fact.tool.js';
import { dataExplorerAppTool } from './mcp-server/tools/definitions/template-data-explorer.app-tool.js';
import { echoTool } from './mcp-server/tools/definitions/template-echo-message.tool.js';
import { imageTestTool } from './mcp-server/tools/definitions/template-image-test.tool.js';
import { madlibsElicitationTool } from './mcp-server/tools/definitions/template-madlibs-elicitation.tool.js';
import { dataExplorerUiResource } from './mcp-server/resources/definitions/data-explorer-ui.app-resource.js';
import { echoResourceDefinition } from './mcp-server/resources/definitions/echo.resource.js';
import { codeReviewPrompt } from './mcp-server/prompts/definitions/code-review.prompt.js';

await createApp({
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
