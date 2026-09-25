#!/usr/bin/env node
/**
 * @fileoverview Example server entry point. Demonstrates how a consumer server
 * registers its definition barrels and starts via `createApp()`.
 * @module examples/index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { serverInstructions } from './mcp-server/server-instructions.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';

await createApp({
  name: 'example-mcp-server',
  title: 'example-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: serverInstructions,
  // template_madlibs_elicitation asks the user for input mid-call, which a stateless HTTP session cannot serve.
  sessionMode: { default: 'stateful', require: 'stateful' },
});
