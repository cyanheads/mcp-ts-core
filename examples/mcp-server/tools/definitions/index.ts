/**
 * @fileoverview Barrel for the example server's tool definitions — the single
 * list both entry points register.
 * @module examples/mcp-server/tools/definitions/index
 */

import { catFactTool } from './template-cat-fact.tool.js';
import { dataExplorerAppTool } from './template-data-explorer.app-tool.js';
import { echoTool } from './template-echo-message.tool.js';
import { imageTestTool } from './template-image-test.tool.js';
import { madlibsElicitationTool } from './template-madlibs-elicitation.tool.js';

export const allToolDefinitions = [
  catFactTool,
  dataExplorerAppTool,
  echoTool,
  imageTestTool,
  madlibsElicitationTool,
];
