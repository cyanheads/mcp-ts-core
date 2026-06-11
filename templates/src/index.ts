#!/usr/bin/env node
/**
 * @fileoverview {{PACKAGE_NAME}} MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';
import { echoAppTool } from './mcp-server/tools/definitions/echo-app.app-tool.js';
import { echoResource } from './mcp-server/resources/definitions/echo.resource.js';
import { echoAppUiResource } from './mcp-server/resources/definitions/echo-app-ui.app-resource.js';
import { echoPrompt } from './mcp-server/prompts/definitions/echo.prompt.js';

await createApp({
  name: '{{PACKAGE_NAME}}',
  title: '{{PACKAGE_NAME}}',
  tools: [echoTool, echoAppTool],
  resources: [echoResource, echoAppUiResource],
  prompts: [echoPrompt],
  // instructions: 'Server-level orientation forwarded to the model on every initialize.\n' +
  //   '- Use shortcut `X` for the most common case\n' +
  //   '- Tools require auth via the `inventory:read` scope',
});
