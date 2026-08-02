/**
 * @fileoverview Smoke coverage for every definition shipped by the scaffold.
 * @module tests/smoke/definitions.smoke.test
 */

import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { echoPrompt } from '@/mcp-server/prompts/definitions/echo.prompt.js';
import { echoAppUiResource } from '@/mcp-server/resources/definitions/echo-app-ui.app-resource.js';
import { echoResource } from '@/mcp-server/resources/definitions/echo.resource.js';
import { echoAppTool } from '@/mcp-server/tools/definitions/echo-app.app-tool.js';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

describe('scaffold definition smoke test', () => {
  it('executes the shipped tool, resource, and prompt definitions', async () => {
    const ctx = createMockContext();
    const toolResult = await echoTool.handler(
      echoTool.input.parse({ message: 'smoke' }),
      ctx,
    );
    const resourceResult = await echoResource.handler(
      echoResource.params.parse({ message: 'smoke' }),
      ctx,
    );
    const promptMessages = echoPrompt.generate(echoPrompt.args.parse({ message: 'smoke' }));
    const appResult = await echoAppTool.handler(
      echoAppTool.input.parse({ message: 'smoke app' }),
      ctx,
    );
    const appContent = echoAppTool.format?.(appResult);
    const appHtml = await echoAppUiResource.handler(
      echoAppUiResource.params.parse({}),
      createMockContext({ uri: new URL('ui://template-echo-app/app.html') }),
    );

    expect(toolResult).toEqual({ message: 'smoke' });
    expect(resourceResult).toEqual({ message: 'smoke' });
    expect(promptMessages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Echo: smoke' } },
    ]);
    expect(appResult).toEqual(expect.schemaMatching(echoAppTool.output));
    expect(appContent?.[0]).toEqual({ type: 'text', text: JSON.stringify(appResult) });
    expect(appHtml).toContain('<title>Echo App</title>');
    expect(appHtml).toContain('app.callServerTool');
  });
});
