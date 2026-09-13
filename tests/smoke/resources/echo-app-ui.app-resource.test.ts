/**
 * @fileoverview Smoke tests for the MCP Apps echo app UI resource pattern.
 * Uses appResource() builder directly to validate the same pattern as the
 * template (templates/ has its own package.json that prevents direct import).
 * @module tests/smoke/resources/echo-app-ui.app-resource.test
 */

import { APP_RESOURCE_MIME_TYPE } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { appResource } from '@/mcp-server/apps/appBuilders.js';

/** Mirrors the template echo app UI resource. */
const echoAppUiResource = appResource('ui://template-echo-app/app.html', {
  name: 'echo-app-ui',
  title: 'Echo App UI',
  description: 'Interactive HTML app for the echo app tool.',
  params: z.object({}).describe('No parameters. Returns the static HTML app.'),
  auth: ['resource:echo-app-ui:read'],
  _meta: {
    ui: {
      csp: { resourceDomains: ['https://unpkg.com'] },
    },
  },

  handler(_params, ctx) {
    ctx.log.debug('Serving echo app UI.', { resourceUri: ctx.uri?.href });
    return '<!DOCTYPE html><html lang="en"><head><title>Echo App</title></head><body><h1>Echo App</h1><script type="module">import{App,applyDocumentTheme,applyHostFonts,applyHostStyleVariables}from"https://unpkg.com/@modelcontextprotocol/ext-apps@2/app-with-deps";const app=new App({name:"Echo App",version:"1.0.0"});function applyHostContext(ctx){if(ctx?.theme){applyDocumentTheme(ctx.theme)}if(ctx?.styles?.variables){applyHostStyleVariables(ctx.styles.variables)}if(ctx?.styles?.css?.fonts){applyHostFonts(ctx.styles.css.fonts)}}app.ontoolresult=(r)=>{};app.onhostcontextchanged=applyHostContext;app.connect().then(()=>{const ctx=app.getHostContext();if(ctx)applyHostContext(ctx)})</script></body></html>';
  },
});

describe('echoAppUiResource (MCP Apps pattern)', () => {
  it('has the correct URI template', () => {
    expect(echoAppUiResource.uriTemplate).toBe('ui://template-echo-app/app.html');
  });

  it('has the MCP Apps MIME type', () => {
    expect(echoAppUiResource.mimeType).toBe(APP_RESOURCE_MIME_TYPE);
    expect(echoAppUiResource.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('has audience: ["user"] annotation', () => {
    expect(echoAppUiResource.annotations?.audience).toEqual(['user']);
  });

  it('has a name', () => {
    expect(echoAppUiResource.name).toBe('echo-app-ui');
  });

  it('has a title', () => {
    expect(echoAppUiResource.title).toBe('Echo App UI');
  });

  it('has auth scopes', () => {
    expect(echoAppUiResource.auth).toEqual(['resource:echo-app-ui:read']);
  });

  it('handler returns HTML content', async () => {
    const ctx = createMockContext({ uri: new URL('ui://template-echo-app/app.html') });
    const params = echoAppUiResource.params!.parse({});
    const result = await echoAppUiResource.handler(params, ctx);
    expect(typeof result).toBe('string');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('Echo App');
  });

  it('HTML includes the MCP Apps client SDK import', async () => {
    const ctx = createMockContext({ uri: new URL('ui://template-echo-app/app.html') });
    const result = await echoAppUiResource.handler(echoAppUiResource.params!.parse({}), ctx);
    expect(result).toContain('@modelcontextprotocol/ext-apps');
    expect(result).toContain('onhostcontextchanged');
    expect(result).toContain('app.connect().then');
  });

  it('format preserves raw HTML and attaches content-item CSP metadata', () => {
    const html = '<!DOCTYPE html><html><body>Echo App</body></html>';
    const contents = echoAppUiResource.format!(html, {
      uri: new URL('ui://template-echo-app/app.html'),
      mimeType: APP_RESOURCE_MIME_TYPE,
    });

    expect(contents[0]).toMatchObject({
      uri: 'ui://template-echo-app/app.html',
      text: html,
      mimeType: APP_RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: { resourceDomains: ['https://unpkg.com'] },
        },
      },
    });
  });

  it('does not need a manual list callback for static discovery', () => {
    expect(echoAppUiResource.list).toBeUndefined();
  });
});
