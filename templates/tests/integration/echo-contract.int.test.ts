/**
 * @fileoverview Tool-contract integration coverage for the scaffolded echo tool.
 * @module tests/integration/echo-contract.int.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

toolContractSuite(echoTool, {
  success: [
    {
      name: 'validates, invokes, and formats a successful call',
      input: { message: 'integration' },
    },
  ],
  errors: [
    {
      name: 'returns the declared dual-surface error envelope',
      input: { message: '   ' },
      code: JsonRpcErrorCode.InvalidParams,
      reason: 'empty_message',
    },
  ],
});
