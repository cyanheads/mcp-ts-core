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
  // Server-level orientation forwarded to the model on every initialize: two to three
  // cohesive sentences in one string literal, written for the calling agent (which tool
  // opens a workflow, what chains into what). Operator configuration stays in the README.
  // instructions: 'Resolve a name to an id with example_search, then pass that id to example_get for the full record. Results are paged; follow nextOffset until it is absent.',

  // Session posture in code rather than in a Dockerfile. MCP_SESSION_MODE still
  // wins when it is set. Add `require: 'stateful'` — `{ default: 'stateful',
  // require: 'stateful' }` — when a tool asks the caller for input mid-handler,
  // so a stateless deployment fails at startup instead of losing that tool.
  // sessionMode: 'stateless',

  // Release what setup() allocated: a watcher, a socket, a timer the framework
  // cannot see. Runs after the transport stops and before the logger closes.
  // teardown(core) { core.logger.info('bye', { requestId: 'shutdown', timestamp: new Date().toISOString() }); },
});
