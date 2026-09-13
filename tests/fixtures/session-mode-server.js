#!/usr/bin/env node
/**
 * @fileoverview Session-mode fixture. Declares its posture in code via the
 * `createApp` `sessionMode` option so a black-box test can confirm the option
 * reaches the HTTP transport and the advertised manifest, and that an explicit
 * `MCP_SESSION_MODE` still wins over it (#376).
 * @module tests/fixtures/session-mode-server
 */

import { createApp } from '@cyanheads/mcp-ts-core';

await createApp({
  name: 'session-mode-fixture',
  version: '0.0.0-test',
  sessionMode: 'stateless',
});
