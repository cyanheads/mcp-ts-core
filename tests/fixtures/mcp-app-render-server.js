#!/usr/bin/env node
/**
 * @fileoverview MCP Apps render fixture using only the package's public API. One app tool
 * and its `ui://` view, built on the ext-apps `App` class (inlined from
 * `@modelcontextprotocol/ext-apps/app-with-deps`), plus an app-only tool the view calls
 * from a button. The view shows the tool input and result, attempts `eval`, requests an
 * undeclared origin, loads a script from the URL in `MCP_APP_RENDER_SCRIPT_URL` (its
 * origin is declared in `resourceDomains`), reports whether its permissions policy allows
 * `clipboard-write` (declared in `_meta.ui.permissions` when `MCP_APP_RENDER_CLIPBOARD_WRITE`
 * is set), and throws an uncaught error when `#throw` is clicked. Further controls send
 * `ui/message`, `ui/open-link`, and a fullscreen display-mode request, and typing into
 * `#name` reveals `#echo` after a short delay. Both inline scripts carry a `sourceURL`
 * so CSP violations name the script that raised them.
 * @module tests/fixtures/mcp-app-render-server
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { appResource, appTool, createApp, tool, z } from '@cyanheads/mcp-ts-core';

const resourceUri = 'ui://app-render/view.html';
const declaredScriptUrl = process.env.MCP_APP_RENDER_SCRIPT_URL;
const declaredOrigin = declaredScriptUrl ? new URL(declaredScriptUrl).origin : undefined;

/** The ext-apps browser bundle with its trailing `export{...}` turned into a global. */
function appBundle() {
  const file = fileURLToPath(import.meta.resolve('@modelcontextprotocol/ext-apps/app-with-deps'));
  const source = readFileSync(file, 'utf8');
  const match = /export\s*\{([^}]*)\};?\s*$/.exec(source);
  if (!match) throw new Error(`${file} does not end with an export list.`);
  const entries = match[1]
    .split(',')
    .map((entry) => entry.trim().split(/\s+as\s+/))
    .map(([local, exported]) => `${JSON.stringify(exported ?? local)}: ${local}`);
  return `${source.slice(0, match.index)}\nglobalThis.McpExtApps = { ${entries.join(', ')} };\n//# sourceURL=ext-apps-app-with-deps.js`.replaceAll(
    '</script',
    '<\\/script',
  );
}

const viewScript = `
const { App } = globalThis.McpExtApps;
const $ = (id) => document.getElementById(id);
const policy = document.permissionsPolicy || document.featurePolicy;
$('clipboard').textContent = 'clipboard-write: ' + (policy ? policy.allowsFeature('clipboard-write') : 'unsupported');
let partials = 0;
let clicks = 0;
const app = new App({ name: 'app-render-fixture-view', version: '1.0.0' }, {}, { autoResize: true });
app.ontoolinputpartial = () => { $('partials').textContent = 'partials: ' + ++partials; };
app.ontoolinput = ({ arguments: args }) => { $('input').textContent = 'input: ' + JSON.stringify(args); };
app.ontoolresult = (result) => { $('result').textContent = 'result: ' + JSON.stringify(result.structuredContent); };
app.ontoolcancelled = ({ reason }) => { $('result').textContent = 'cancelled: ' + reason; };
$('action').addEventListener('click', async () => {
  const result = await app.callServerTool({ name: 'app_render_action', arguments: { clicks: ++clicks } });
  $('action-result').textContent = 'action: ' + JSON.stringify(result.structuredContent);
});
$('throw').addEventListener('click', () => { throw new Error('app-render fixture: thrown on click'); });
$('message').addEventListener('click', async () => {
  const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello from the view' }] });
  $('message-result').textContent = 'message: ' + JSON.stringify(result);
});
$('open-link').addEventListener('click', async () => {
  const result = await app.openLink({ url: 'https://example.com/docs' });
  $('link-result').textContent = 'link: ' + JSON.stringify(result);
});
$('fullscreen').addEventListener('click', async () => {
  const result = await app.requestDisplayMode({ mode: 'fullscreen' });
  $('mode').textContent = 'mode: ' + result.mode;
});
$('name').addEventListener('input', () => {
  setTimeout(() => {
    let echo = $('echo');
    if (!echo) {
      echo = document.createElement('p');
      echo.id = 'echo';
      document.body.appendChild(echo);
    }
    echo.textContent = 'echo: ' + $('name').value;
  }, 150);
});
await app.connect();
$('status').textContent = 'connected';
try { eval('1 + 1'); $('eval').textContent = 'eval: ran'; }
catch (err) { $('eval').textContent = 'eval: blocked (' + err.name + ')'; }
const undeclared = new Image();
undeclared.src = 'https://undeclared.example.invalid/pixel.png';
//# sourceURL=app-render-view.js
`;

const declaredTag = declaredScriptUrl
  ? `<script src="${declaredScriptUrl}"></script>`
  : '<p id="declared">declared: not configured</p>';

const viewHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>app-render fixture</title>
<style>body{font:14px system-ui,sans-serif;margin:16px}p{margin:4px 0}</style></head>
<body>
<h1>app-render fixture</h1>
<p id="status">loading</p>
<p id="partials">partials: 0</p>
<p id="input">input: (none)</p>
<p id="result">result: (none)</p>
<p id="eval">eval: (not tried)</p>
<p id="clipboard">clipboard-write: (not checked)</p>
<p id="declared">declared: (pending)</p>
<button id="action" type="button">Call app_render_action</button>
<button id="throw" type="button">Throw</button>
<p id="action-result">action: (not called)</p>
<button id="message" type="button">Send a message</button>
<button id="open-link" type="button">Open a link</button>
<button id="fullscreen" type="button">Go fullscreen</button>
<p id="message-result">message: (not sent)</p>
<p id="link-result">link: (not opened)</p>
<p id="mode">mode: inline</p>
<input id="name" type="text" aria-label="Name">
<script type="module">${appBundle()}</script>
<script type="module">${viewScript}</script>
${declaredTag}
</body></html>`;

const renderProbe = appTool('app_render_probe', {
  resourceUri,
  title: 'App Render Probe',
  description: 'Returns deterministic records and renders them in the app-render fixture view.',
  input: z.object({ query: z.string().describe('Search query.') }),
  output: z.object({
    query: z.string().describe('The query, echoed.'),
    items: z.array(z.string()).describe('Matched items.'),
  }),
  annotations: { readOnlyHint: true },
  handler: ({ query }) => ({ query, items: [`${query}-one`, `${query}-two`] }),
});

const renderAction = tool('app_render_action', {
  title: 'App Render Action',
  description: 'Echoes the click count the app-render fixture view sends.',
  input: z.object({ clicks: z.number().describe('How many times the view button was clicked.') }),
  output: z.object({ echoed: z.number().describe('The click count, echoed.') }),
  annotations: { readOnlyHint: true },
  _meta: { ui: { visibility: ['app'] } },
  handler: ({ clicks }) => ({ echoed: clicks }),
});

const ui = {
  ...(declaredOrigin && { csp: { resourceDomains: [declaredOrigin] } }),
  ...(process.env.MCP_APP_RENDER_CLIPBOARD_WRITE && { permissions: { clipboardWrite: {} } }),
};

const renderView = appResource(resourceUri, {
  name: 'app-render-view',
  title: 'App Render View',
  description: 'HTML view for the app-render fixture.',
  params: z.object({}).describe('No parameters.'),
  ...(Object.keys(ui).length > 0 && { _meta: { ui } }),
  handler: () => viewHtml,
});

await createApp({
  name: 'mcp-app-render-fixture',
  version: '0.0.0-test',
  tools: [renderProbe, renderAction],
  resources: [renderView],
});
