/**
 * @fileoverview Barrel for the example server's prompt definitions — the single
 * list both entry points register.
 * @module examples/mcp-server/prompts/definitions/index
 */

import { codeReviewPrompt } from './code-review.prompt.js';

export const allPromptDefinitions = [codeReviewPrompt];
