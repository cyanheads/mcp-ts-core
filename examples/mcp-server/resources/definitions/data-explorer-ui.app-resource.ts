/**
 * @fileoverview UI Resource for the data explorer MCP App.
 *
 * Serves a self-contained HTML application that renders sales data as an
 * interactive table. Demonstrates MCP Apps client-side capabilities:
 * `app.ontoolresult`, `app.callServerTool()`, `app.sendMessage()`, `app.connect()`.
 *
 * @module examples/mcp-server/resources/definitions/data-explorer-ui.app-resource
 */
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { resource, z } from '@cyanheads/mcp-ts-core';

const ParamsSchema = z.object({}).describe('No parameters. Returns the static HTML app.');

// ─── HTML Application ─────────────────────────────────────────────────────────

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Data Explorer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      padding: 1.25rem; min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem;
    }
    .header h1 { font-size: 1.125rem; font-weight: 600; }
    .controls { display: flex; gap: 0.5rem; align-items: center; }
    input[type="text"] {
      padding: 0.375rem 0.75rem; background: #1e293b; border: 1px solid #334155;
      border-radius: 0.375rem; color: #e2e8f0; font-size: 0.8125rem;
      outline: none; width: 200px; transition: border-color 0.15s;
    }
    input[type="text"]:focus { border-color: #3b82f6; }
    input[type="text"]::placeholder { color: #64748b; }
    button {
      padding: 0.375rem 0.875rem; background: #3b82f6; color: #fff;
      border: none; border-radius: 0.375rem; font-size: 0.8125rem;
      cursor: pointer; transition: background 0.15s; white-space: nowrap;
    }
    button:hover { background: #2563eb; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary { background: #475569; }
    button.secondary:hover { background: #64748b; }

    /* ── Summary Cards ── */
    .summary {
      display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;
    }
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem;
      padding: 0.75rem 1rem; flex: 1; min-width: 140px;
    }
    .card-label { font-size: 0.6875rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
    .card-value { font-size: 1.25rem; font-weight: 700; margin-top: 0.125rem; font-variant-numeric: tabular-nums; }

    /* ── Table ── */
    .table-wrap {
      overflow-x: auto; border: 1px solid #334155; border-radius: 0.5rem;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th {
      background: #1e293b; padding: 0.625rem 0.75rem; text-align: left;
      font-weight: 600; color: #94a3b8; cursor: pointer; user-select: none;
      white-space: nowrap; border-bottom: 1px solid #334155; position: relative;
    }
    th:hover { color: #e2e8f0; }
    th .sort-indicator { margin-left: 0.25rem; font-size: 0.625rem; }
    td {
      padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e293b;
      white-space: nowrap;
    }
    tr:hover td { background: #1e293b; }
    tr.selected td { background: #1e3a5f; }
    tr { cursor: pointer; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }

    /* ── Footer ── */
    .footer {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 0.75rem; font-size: 0.75rem; color: #64748b;
    }
    .selection-info { color: #3b82f6; }
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
    import { App } from "https://unpkg.com/@modelcontextprotocol/ext-apps@1/app-with-deps";

    const app = new App({ name: "Data Explorer", version: "1.0.0" });

    // ── State ──
    let allRows = [];
    let sortCol = "id";
    let sortAsc = true;
    const selected = new Set();

    const columns = [
      { key: "id",      label: "ID",      numeric: true  },
      { key: "region",  label: "Region",  numeric: false },
      { key: "product", label: "Product", numeric: false },
      { key: "units",   label: "Units",   numeric: true  },
      { key: "revenue", label: "Revenue", numeric: true  },
      { key: "date",    label: "Date",    numeric: false },
    ];

    // ── Rendering ──
    function renderSummary(summary) {
      document.getElementById("summary").innerHTML = [
        { label: "Total Rows", value: summary.totalRows.toLocaleString() },
        { label: "Total Units", value: summary.totalUnits.toLocaleString() },
        { label: "Total Revenue", value: "$" + summary.totalRevenue.toLocaleString() },
      ].map(c => \`
        <div class="card">
          <div class="card-label">\${c.label}</div>
          <div class="card-value">\${c.value}</div>
        </div>
      \`).join("");
    }

    function renderHead() {
      document.getElementById("thead").innerHTML = "<tr>" + columns.map(col => {
        const indicator = sortCol === col.key
          ? (sortAsc ? "▲" : "▼")
          : "";
        return \`<th data-col="\${col.key}" class="\${col.numeric ? 'num' : ''}">\${col.label}<span class="sort-indicator">\${indicator}</span></th>\`;
      }).join("") + "</tr>";
    }

    function getFilteredSorted() {
      const q = document.getElementById("filter").value.toLowerCase();
      let rows = allRows;
      if (q) {
        rows = rows.filter(r =>
          columns.some(c => String(r[c.key]).toLowerCase().includes(q))
        );
      }
      rows = [...rows].sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
        return sortAsc ? cmp : -cmp;
      });
      return rows;
    }

    function renderBody() {
      const rows = getFilteredSorted();
      document.getElementById("tbody").innerHTML = rows.map(r => {
        const cls = selected.has(r.id) ? ' class="selected"' : "";
        return \`<tr data-id="\${r.id}"\${cls}>\` + columns.map(col => {
          const val = col.key === "revenue"
            ? "$" + r[col.key].toLocaleString()
            : r[col.key];
          return \`<td class="\${col.numeric ? 'num' : ''}">\${val}</td>\`;
        }).join("") + "</tr>";
      }).join("");
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
      const text = content?.find(c => c.type === "text")?.text;
      if (!text) return;
      try {
        const data = JSON.parse(text);
        allRows = data.rows || [];
        selected.clear();
        renderSummary(data.summary || { totalRows: 0, totalUnits: 0, totalRevenue: 0 });
        renderHead();
        renderBody();
      } catch { /* ignore malformed data */ }
    }

    // ── MCP Apps Integration ──

    // 1. Receive initial tool results pushed by host
    app.ontoolresult = (result) => loadData(result.content);

    // 2. Refresh: call the server tool from the UI
    document.getElementById("refresh").addEventListener("click", async () => {
      const btn = document.getElementById("refresh");
      btn.disabled = true;
      btn.textContent = "Loading…";
      try {
        const result = await app.callServerTool({
          name: "template_data_explorer",
          arguments: { rowCount: 20 },
        });
        loadData(result.content);
      } catch (err) {
        console.error("Refresh failed:", err);
      } finally {
        btn.disabled = false;
        btn.textContent = "Refresh Data";
      }
    });

    // 3. Send selected rows as context update to the model
    document.getElementById("send-selection").addEventListener("click", async () => {
      const selectedRows = allRows.filter(r => selected.has(r.id));
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

    // 4. Connect to host
    await app.connect();
  </script>
</body>
</html>`;

// ─── Definition ───────────────────────────────────────────────────────────────

export const dataExplorerUiResource = resource('ui://template-data-explorer/app.html', {
  name: 'data-explorer-ui',
  title: 'Data Explorer UI',
  description:
    'Interactive HTML app for the data explorer tool. Renders a sortable, filterable table with row selection.',
  params: ParamsSchema,
  mimeType: RESOURCE_MIME_TYPE,
  annotations: { audience: ['user'] },
  auth: ['resource:data-explorer-ui:read'],

  handler(_params, ctx) {
    ctx.log.debug('Serving data explorer UI resource.', {
      resourceUri: ctx.uri?.href,
    });
    return APP_HTML;
  },

  list: () => ({
    resources: [
      {
        uri: 'ui://template-data-explorer/app.html',
        name: 'Data Explorer App',
        description: 'Interactive data table for the template_data_explorer tool.',
        mimeType: RESOURCE_MIME_TYPE,
      },
    ],
  }),

  format: (_result, meta) => [
    {
      uri: meta.uri.href,
      mimeType: meta.mimeType,
      text: _result as string,
      _meta: {
        ui: {
          csp: { resourceDomains: ['https://unpkg.com'] },
        },
      },
    },
  ],
});
