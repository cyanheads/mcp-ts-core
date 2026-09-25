/**
 * @fileoverview Tests for the data explorer MCP App UI resource.
 * @module tests/smoke/resources/data-explorer-ui.app-resource.test
 */

import { APP_RESOURCE_MIME_TYPE } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { dataExplorerUiResource } from '../../../examples/mcp-server/resources/definitions/data-explorer-ui.app-resource.js';
import {
  dataExplorerAppTool,
  UI_RESOURCE_URI,
} from '../../../examples/mcp-server/tools/definitions/template-data-explorer.app-tool.js';

async function readHtml(): Promise<string> {
  const ctx = createMockContext({ uri: new URL(UI_RESOURCE_URI) });
  const html = await dataExplorerUiResource.handler(dataExplorerUiResource.params!.parse({}), ctx);
  expect(typeof html).toBe('string');
  return html as string;
}

describe('dataExplorerUiResource', () => {
  it('carries the appResource defaults', () => {
    expect(dataExplorerUiResource.uriTemplate).toBe(UI_RESOURCE_URI);
    expect(dataExplorerUiResource.mimeType).toBe(APP_RESOURCE_MIME_TYPE);
    expect(dataExplorerUiResource.annotations?.audience).toEqual(['user']);
  });

  it('pairs with the app tool', () => {
    expect(dataExplorerAppTool._meta).toMatchObject({
      ui: { resourceUri: dataExplorerUiResource.uriTemplate },
    });
  });

  it('serves HTML that calls the tool and applies host context', async () => {
    const html = await readHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('@modelcontextprotocol/ext-apps@2');
    expect(html).toContain('app.callServerTool');
    expect(html).toContain('template_data_explorer');
    expect(html).toContain('applyHostStyleVariables');
    expect(html).toContain('onhostcontextchanged');
    expect(html).toContain('app.getHostContext()');
    expect(html).toContain('prefers-color-scheme');
  });

  it('reads host style variables by their ext-apps names', async () => {
    const html = await readHtml();
    expect(html).toContain('var(--color-background-primary, var(--bg))');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).not.toContain('--mcp-');
  });

  it('reads the tool output keys', async () => {
    const html = await readHtml();
    expect(html).toContain('revenueInUsd');
    expect(html).toContain('totalRevenueInUsd');
  });

  it('never writes tool data through innerHTML', async () => {
    expect(await readHtml()).not.toMatch(/\.(inner|outer)HTML\s*\+?=|insertAdjacentHTML/);
  });

  it('attaches the CSP to resources/read content items', async () => {
    const html = await readHtml();
    const contents = dataExplorerUiResource.format!(html, {
      uri: new URL(UI_RESOURCE_URI),
      mimeType: APP_RESOURCE_MIME_TYPE,
    });
    expect(contents[0]).toMatchObject({
      uri: UI_RESOURCE_URI,
      mimeType: APP_RESOURCE_MIME_TYPE,
      text: html,
      _meta: { ui: { csp: { resourceDomains: ['https://unpkg.com'] } } },
    });
  });
});
