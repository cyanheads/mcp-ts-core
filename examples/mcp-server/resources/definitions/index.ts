/**
 * @fileoverview Barrel for the example server's resource definitions — the
 * single list both entry points register.
 * @module examples/mcp-server/resources/definitions/index
 */

import { dataExplorerUiResource } from './data-explorer-ui.app-resource.js';
import { echoResourceDefinition } from './echo.resource.js';

export const allResourceDefinitions = [dataExplorerUiResource, echoResourceDefinition];
