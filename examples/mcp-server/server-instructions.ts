/**
 * @fileoverview Server-level `instructions` for the example server, shared by
 * the Node/Bun and Cloudflare Worker entry points. Sent on every `initialize`
 * as orientation for the calling agent.
 * @module examples/mcp-server/server-instructions
 */

export const serverInstructions =
  'Each tool here stands alone, and no call needs the output of another. `template_madlibs_elicitation` asks the user mid-call for any part of speech missing from its input, so pass noun, verb, and adjective up front to skip the prompts. `template_data_explorer` renders an interactive table in hosts that support MCP Apps and returns the same rows as a text table everywhere else.';
