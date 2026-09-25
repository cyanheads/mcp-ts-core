/**
 * @fileoverview UI Resource for the data explorer MCP App.
 *
 * Serves a self-contained HTML application that renders sales data as an
 * interactive table. Demonstrates MCP Apps client-side capabilities:
 * `app.ontoolresult`, `app.callServerTool()`, `app.sendMessage()`, `app.connect()`,
 * and host theming through `app.onhostcontextchanged` / `app.getHostContext()`.
 *
 * @module examples/mcp-server/resources/definitions/data-explorer-ui.app-resource
 */

import { appResource, z } from '@cyanheads/mcp-ts-core';

import { UI_RESOURCE_URI } from '../../tools/definitions/template-data-explorer.app-tool.js';

const ParamsSchema = z.object({}).describe('No parameters. Returns the static HTML app.');

// ─── HTML Application ─────────────────────────────────────────────────────────

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Data Explorer</title>
  <style>
    /*
     * Local tokens are the pre-connect baseline: light by default, dark when the
     * OS prefers it, and pinned by the data-theme attribute applyDocumentTheme sets.
     * Every rule reads the host's variable first (installed by applyHostStyleVariables)
     * and falls back to the local token until host context arrives.
     */
    :root {
      color-scheme: light dark;
      --bg: #ffffff; --surface: #f8fafc; --fg: #0f172a; --muted: #64748b;
      --border: #e2e8f0; --accent: #2563eb; --accent-fg: #ffffff; --selected: #dbeafe;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #0f172a; --surface: #1e293b; --fg: #e2e8f0; --muted: #94a3b8;
        --border: #334155; --accent: #3b82f6; --accent-fg: #ffffff; --selected: #1e3a5f;
      }
    }
    :root[data-theme="dark"] {
      --bg: #0f172a; --surface: #1e293b; --fg: #e2e8f0; --muted: #94a3b8;
      --border: #334155; --accent: #3b82f6; --accent-fg: #ffffff; --selected: #1e3a5f;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
      background: var(--color-background-primary, var(--bg));
      color: var(--color-text-primary, var(--fg));
      padding: 1.25rem; min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;
    }
    .header h1 {
      font-size: var(--font-heading-xs-size, 1.125rem);
      font-weight: var(--font-weight-semibold, 600);
    }
    .controls { display: flex; gap: 0.5rem; align-items: center; }
    input[type="text"] {
      padding: 0.375rem 0.75rem; width: 200px;
      background: var(--color-background-secondary, var(--surface));
      border: 1px solid var(--color-border-primary, var(--border));
      border-radius: var(--border-radius-md, 0.375rem);
      color: var(--color-text-primary, var(--fg));
      font: inherit; font-size: var(--font-text-sm-size, 0.8125rem); outline: none;
    }
    input[type="text"]:focus { border-color: var(--color-ring-primary, var(--accent)); }
    input[type="text"]::placeholder { color: var(--color-text-tertiary, var(--muted)); }
    button {
      padding: 0.375rem 0.875rem; border: 1px solid transparent;
      background: var(--color-background-inverse, var(--accent));
      color: var(--color-text-inverse, var(--accent-fg));
      border-radius: var(--border-radius-md, 0.375rem);
      font: inherit; font-size: var(--font-text-sm-size, 0.8125rem);
      cursor: pointer; white-space: nowrap;
    }
    button:hover { opacity: 0.9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: var(--color-background-secondary, var(--surface));
      color: var(--color-text-primary, var(--fg));
      border-color: var(--color-border-primary, var(--border));
    }

    /* ── Summary Cards ── */
    .summary { display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .card {
      background: var(--color-background-secondary, var(--surface));
      border: 1px solid var(--color-border-primary, var(--border));
      border-radius: var(--border-radius-lg, 0.5rem);
      padding: 0.75rem 1rem; flex: 1; min-width: 140px;
    }
    .card-label {
      font-size: var(--font-text-xs-size, 0.6875rem);
      color: var(--color-text-secondary, var(--muted));
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .card-value {
      font-size: var(--font-heading-sm-size, 1.25rem);
      font-weight: var(--font-weight-bold, 700);
      margin-top: 0.125rem; font-variant-numeric: tabular-nums;
    }

    /* ── Table ── */
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--color-border-primary, var(--border));
      border-radius: var(--border-radius-lg, 0.5rem);
    }
    table { width: 100%; border-collapse: collapse; font-size: var(--font-text-sm-size, 0.8125rem); }
    th {
      background: var(--color-background-secondary, var(--surface));
      color: var(--color-text-secondary, var(--muted));
      border-bottom: 1px solid var(--color-border-primary, var(--border));
      padding: 0.625rem 0.75rem; text-align: left; font-weight: var(--font-weight-semibold, 600);
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    th:hover { color: var(--color-text-primary, var(--fg)); }
    th .sort-indicator { margin-left: 0.25rem; font-size: 0.625rem; }
    td {
      padding: 0.5rem 0.75rem; white-space: nowrap;
      border-bottom: 1px solid var(--color-border-secondary, var(--border));
    }
    tr { cursor: pointer; }
    tr:hover td { background: var(--color-background-secondary, var(--surface)); }
    tr.selected td { background: var(--color-background-info, var(--selected)); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }

    /* ── Footer ── */
    .footer {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 0.75rem; font-size: var(--font-text-xs-size, 0.75rem);
      color: var(--color-text-secondary, var(--muted));
    }
    .selection-info { color: var(--color-text-info, var(--accent)); }
  </style>
</head>
<body>
  <div class="header">
    <h1>Data Explorer</h1>
    <div class="controls">
      <input type="text" id="filter" placeholder="Filter rows…" />
      <button id="refresh">Refresh Data</button>
      <button id="send-selection" class="secondary" disabled>Send Selection</button>
    </div>
  </div>
  <div class="summary" id="summary"></div>
  <div class="table-wrap">
    <table>
      <thead id="thead"></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div class="footer">
    <span id="row-count"></span>
    <span id="selection-info" class="selection-info"></span>
  </div>

  <script type="module">
    import {
      App,
      applyDocumentTheme,
      applyHostFonts,
      applyHostStyleVariables,
    } from "https://unpkg.com/@modelcontextprotocol/ext-apps@2/app-with-deps";

    const app = new App({ name: "Data Explorer", version: "1.0.0" });

    function applyHostContext(hostContext) {
      if (hostContext?.theme) {
        applyDocumentTheme(hostContext.theme);
      }
      if (hostContext?.styles?.variables) {
        applyHostStyleVariables(hostContext.styles.variables);
      }
      if (hostContext?.styles?.css?.fonts) {
        applyHostFonts(hostContext.styles.css.fonts);
      }
    }

    // ── State ──
    let allRows = [];
    let sortCol = "id";
    let sortAsc = true;
    const selected = new Set();

    const columns = [
      { key: "id",           label: "ID",      numeric: true  },
      { key: "region",       label: "Region",  numeric: false },
      { key: "product",      label: "Product", numeric: false },
      { key: "units",        label: "Units",   numeric: true  },
      { key: "revenueInUsd", label: "Revenue", numeric: true  },
      { key: "date",         label: "Date",    numeric: false },
    ];

    const usd = (value) => "$" + value.toLocaleString("en-US");
    const count = (value) => value.toLocaleString("en-US");

    // ── Rendering (textContent only — tool data never reaches innerHTML) ──
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }

    function renderSummary(summary) {
      const cards = [
        { label: "Total Rows", value: count(summary.totalRows) },
        { label: "Total Units", value: count(summary.totalUnits) },
        { label: "Total Revenue", value: usd(summary.totalRevenueInUsd) },
      ].map((c) => {
        const card = el("div", "card");
        card.append(el("div", "card-label", c.label), el("div", "card-value", c.value));
        return card;
      });
      document.getElementById("summary").replaceChildren(...cards);
    }

    function renderHead() {
      const tr = el("tr");
      for (const col of columns) {
        const th = el("th", col.numeric ? "num" : "", col.label);
        th.dataset.col = col.key;
        const indicator = sortCol === col.key ? (sortAsc ? "▲" : "▼") : "";
        th.append(el("span", "sort-indicator", indicator));
        tr.append(th);
      }
      document.getElementById("thead").replaceChildren(tr);
    }

    function getFilteredSorted() {
      const q = document.getElementById("filter").value.toLowerCase();
      const rows = q
        ? allRows.filter((r) => columns.some((c) => String(r[c.key]).toLowerCase().includes(q)))
        : allRows;
      return [...rows].sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortAsc ? cmp : -cmp;
      });
    }

    function renderBody() {
      const rows = getFilteredSorted();
      const trs = rows.map((r) => {
        const tr = el("tr", selected.has(r.id) ? "selected" : "");
        tr.dataset.id = String(r.id);
        for (const col of columns) {
          const value = col.key === "revenueInUsd" ? usd(r[col.key]) : r[col.key];
          tr.append(el("td", col.numeric ? "num" : "", value));
        }
        return tr;
      });
      document.getElementById("tbody").replaceChildren(...trs);
      document.getElementById("row-count").textContent =
        rows.length + " of " + allRows.length + " rows";
      updateSelectionUI();
    }

    function updateSelectionUI() {
      const btn = document.getElementById("send-selection");
      const info = document.getElementById("selection-info");
      btn.disabled = selected.size === 0;
      info.textContent = selected.size > 0
        ? selected.size + " row" + (selected.size > 1 ? "s" : "") + " selected"
        : "";
    }

    function loadData(content) {
      const text = content?.find((c) => c.type === "text")?.text;
      if (!text) return;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return; // An error result carries prose, not the JSON block
      }
      allRows = data.rows;
      selected.clear();
      renderSummary(data.summary);
      renderHead();
      renderBody();
    }

    // ── MCP Apps Integration ──

    // 1. Receive the initial tool result pushed by the host, and track host theme changes
    app.ontoolresult = (result) => loadData(result.content);
    app.onhostcontextchanged = applyHostContext;

    // 2. Refresh: call the server tool from the UI
    document.getElementById("refresh").addEventListener("click", async () => {
      const btn = document.getElementById("refresh");
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        const result = await app.callServerTool({
          name: "template_data_explorer",
          arguments: { rowCount: allRows.length || 20 },
        });
        loadData(result.content);
      } catch (err) {
        console.error("Refresh failed:", err);
      } finally {
        btn.disabled = false;
        btn.textContent = "Refresh Data";
      }
    });

    // 3. Send selected rows as context to the model
    document.getElementById("send-selection").addEventListener("click", async () => {
      const selectedRows = allRows.filter((r) => selected.has(r.id));
      const text = "User selected " + selectedRows.length + " row(s):\\n" +
        JSON.stringify(selectedRows, null, 2);
      try {
        await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      } catch (err) {
        console.error("Failed to send selection:", err);
      }
    });

    // ── Table Interactions ──
    document.getElementById("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      const col = th.dataset.col;
      if (sortCol === col) { sortAsc = !sortAsc; }
      else { sortCol = col; sortAsc = true; }
      renderHead();
      renderBody();
    });

    document.getElementById("tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const id = Number(tr.dataset.id);
      if (selected.has(id)) { selected.delete(id); }
      else { selected.add(id); }
      renderBody();
    });

    document.getElementById("filter").addEventListener("input", () => renderBody());

    // 4. Connect to the host, then apply the host context it reports
    app.connect().then(() => {
      const hostContext = app.getHostContext();
      if (hostContext) applyHostContext(hostContext);
    });
  </script>
</body>
</html>`;

// ─── Definition ───────────────────────────────────────────────────────────────

export const dataExplorerUiResource = appResource(UI_RESOURCE_URI, {
  name: 'data-explorer-ui',
  title: 'Data Explorer UI',
  description:
    'Interactive HTML app for the data explorer tool. Renders a sortable, filterable table with row selection.',
  params: ParamsSchema,
  auth: ['resource:data-explorer-ui:read'],
  // Static HTML that changes only on redeploy — safe for shared caches.
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  _meta: {
    ui: {
      csp: { resourceDomains: ['https://unpkg.com'] },
    },
  },

  handler: () => APP_HTML,
});
