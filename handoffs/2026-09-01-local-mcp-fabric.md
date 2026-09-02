# Local MCP fabric and federated DataCanvas composition

- Status: architecture note; no implementation has started
- Date: 2026-09-01
- Scope: same-machine mcp-ts-core servers first; broker federation later

## Decision

Every participating server keeps its current local DataCanvas:

- `CANVAS_PROVIDER_TYPE=duckdb` remains the only enabled backend.
- Each server process owns its `CanvasRegistry`, DuckDB instances, tenant checks, and TTLs.
- A `canvas_id` remains local to the server instance that minted it.
- The fabric supplies discovery, qualified references, authorization, snapshot transfer, and cross-canvas composition.

A cross-server query names tables from two or more qualified canvases. The fabric coordinator creates a normal, short-lived DuckDB-backed DataCanvas, streams snapshots of those tables into it, and runs the SQL there. Inline queries discard the composition canvas after the response. A materialized result can remain in a coordinator-owned canvas and receive its own qualified reference.

mcp-ts-core is a library, so it does not spawn a global DuckDB process by itself. The long-running process that hosts the composition operation, most likely the fabric daemon or a small MCP facade over it, creates the temporary DataCanvas using the existing mcp-ts-core DuckDB implementation.

The MCP transport has no bearing on this model. DataCanvas behaves the same way regardless of how the host reaches a server. Every participant uses the same fabric integration and data-transfer contract.

## User workflow

Assume PubMed and ClinicalTrials.gov each stage data in their own local canvas.

1. A PubMed fetch tool returns local canvas `A`, table `articles`.
2. A ClinicalTrials.gov fetch tool returns local canvas `B`, table `trials`.
3. The host calls the fabric composition surface with two qualified table references and assigns the aliases `articles` and `trials`.
4. The fabric freezes each source table as a Parquet snapshot and streams both into a temporary coordinator canvas.
5. The coordinator runs a SQL join using NCT ID, DOI, PMID, or an explicit crosswalk.
6. The result is returned inline or materialized into a new coordinator-owned canvas for follow-up queries.

Only previews, schemas, qualified references, and SQL travel through model context. Full tables move through the fabric data channel.

```text
MCP host
  |-- normal MCP --> server A --> local canvas A
  |-- normal MCP --> server B --> local canvas B
  `-- normal MCP --> fabric composition tools

server A --\
           >-- fabric registry + snapshot streams --> coordinator DataCanvas
server B --/                                          |
                                               SQL query/result
```

The host still chooses the sources and query. The fabric moves snapshots and executes the requested composition; it does not make autonomous tool calls.

## Canvas references

The current identity is effectively `(tenantId, process instance, canvasId)`. A raw ten-character `canvas_id` cannot identify a canvas across servers, and a server name is still ambiguous when two instances are running.

A federated table reference needs an opaque fabric authority plus the local identifiers:

```ts
interface FabricTableRef {
  authority: string;
  canvas_id: string;
  table_name: string;
}
```

`authority` is minted by the fabric registry and bound to one live participant connection and process instance. The fabric resolves the qualified table reference together with a separate source-issued access grant. The server name is display metadata, never identity. A process restart invalidates its prior authorities and references.

For a single-user prototype, the fabric can map a qualified reference to the participant's default tenant. A production implementation needs a source-issued, read-only grant that remembers the original tenant without forwarding or trusting a caller-supplied `tenantId`. Grants should be table-scoped, expire no later than the source canvas, and be revoked when the canvas or participant disappears.

The agent assigns every source a unique SQL-safe relation name:

```ts
interface FederatedSource {
  ref: FabricTableRef;
  as: string;
}
```

`as` is required. The coordinator must not derive it from a hyphenated server name, a possibly duplicated table name, or source order. The composition SQL references these names directly, such as `articles` and `trials`.

## Agent-facing surface

A first fabric coordinator needs two tools. The names are provisional, but their separation is useful because source tool responses do not always include complete schemas.

### `fabric_dataframe_describe`

Accepts `FederatedSource[]`, resolves every authority, validates access, and returns:

- the exact coordinator relation binding for each source
- source server display name
- columns and types
- row count and approximate size
- source and table expiry

This gives the agent enough information to write the composition SQL without guessing names or learning schemas from binder errors.

### `fabric_dataframe_query`

Accepts:

```ts
interface FederatedQueryInput {
  sources: FederatedSource[];
  sql: string;
  result:
    | { mode: 'inline'; row_limit?: number }
    | { mode: 'materialize'; table_name: string; preview_rows?: number; ttl_ms?: number };
}
```

Inline mode returns a bounded `QueryResult` and destroys the temporary composition canvas.

Materialize mode fully evaluates the query, drops the imported staging relations, retains the result table in the coordinator's ordinary local DataCanvas, and returns a new `FabricTableRef`. The coordinator registers as a normal fabric participant, so that reference has its own authority. The coordinator process is long-running; its result canvas follows the same TTL and restart behavior as any other server's DataCanvas. Writing the result into an arbitrary source server is a later capability because it needs a separate write grant and reverse import path.

The coordinator forces `denySystemCatalogs: true`. User SQL cannot discover spool paths or call `read_parquet`; those operations remain behind typed framework methods.

## Exact composition flow

1. A source server stages rows through `DataCanvas.acquire()` and `CanvasInstance.registerTable()` exactly as it does today.
2. Its fabric participant issues a qualified, read-only reference to an allowed table.
3. The coordinator resolves all authorities and checks source count, table count, declared size, tenant/workspace policy, and expiry before moving bytes.
4. Each source reacquires its own canvas under the tenant stored with the grant and exports the table through the existing `CanvasInstance.export()` stream target with `format: 'parquet'`.
5. The coordinator creates a fresh local canvas and imports each Parquet stream under its required `as` name.
6. It runs the supplied SQL through the existing four-layer DataCanvas query gate.
7. Inline mode returns the bounded rows and destroys the canvas. Materialize mode keeps only the result relation and returns its qualified reference.

Every source is a snapshot taken when its export starts. There is no atomic transaction across several servers, and later source changes do not update the composition result. Provenance must therefore record a snapshot ID, content hash, source authority, canvas and table IDs, and capture time for every binding.

## Framework seam

This model does not require a new provider, a remote `DataCanvas`, or a change to `CoreServices.canvas`.

The current framework already has most of the source side:

- `CanvasInstance.export()` touches the canvas and table, then delegates to the provider.
- `DuckdbProvider.export()` can write Parquet to scratch storage and pipe it into a `WritableStream`.
- `CanvasInstance.query()` supplies the read-only SQL gate and materialization behavior.
- `CreateAppOptions.extensions` can advertise fabric protocol support and roles.

The missing DataCanvas primitive is a trusted binary import:

```ts
instance.importTable(
  name: string,
  source: {
    format: 'parquet';
    stream: ReadableStream<Uint8Array>;
  },
  options?: {
    signal?: AbortSignal;
    ttlMs?: number;
  },
): Promise<RegisterTableResult>;
```

The implementation should reuse the existing type-preserving Parquet path behind `importFrom()`:

- accept bytes, never a caller-supplied filesystem path
- spool under the configured canvas scratch root with a byte cap
- validate the destination identifier
- import into a temporary relation and publish it only after the full stream and hash verify
- clean scratch files and partial relations on cancellation or failure

One lifecycle fix is also needed: an active export/import must pin the affected canvas and table until the operation settles. The current export path touches TTL once at the beginning, so a very short TTL could expire during a long snapshot transfer. The source bridge must also serialize table replacement, drop, and clear operations against snapshot creation so one Parquet export represents one stable source relation.

The fabric client, participant registration, grants, routing, and composition tools belong in an optional companion package while the protocol is proven. mcp-ts-core owns only the generic import primitive and any small lifecycle seam the companion needs, such as disposer registration.

## Data path and limits

Parquet is the right first snapshot format because the current provider already exports it and `importFrom()` proves the DuckDB round-trip preserves `TIMESTAMP`, `DATE`, and `BLOB` columns. Arrow IPC may outperform it later, but it is not required to prove the design.

The fabric protocol carries binary frames with backpressure, operation IDs, cancellation, and end-to-end hashes. It does not send base64 tables through agent-facing MCP tool arguments or accept arbitrary paths and URLs.

The coordinator applies limits before and during composition:

- source and table count
- total declared and received bytes
- query runtime and memory
- result rows and retained-canvas TTL
- per-participant concurrency

Source exports can run in parallel. Coordinator imports and catalog mutations serialize around the destination canvas. Cancellation propagates from the host request through the coordinator to every source export. Any failure removes all temporary files, imported staging tables, and partial results.

The first implementation transfers complete selected tables. Predicate and projection pushdown can later let each source execute a restricted local `SELECT` before export, but that changes snapshot semantics and should be measured before it becomes protocol surface.

## Ownership and failure behavior

| Situation | Behavior |
|---|---|
| Fabric unavailable | Every server's local DataCanvas continues working; only federated describe/query is unavailable |
| Source canvas or table expired | Composition fails with the qualified source and existing re-stage guidance |
| Source process restarted | Its old authority is stale and must never route to the new process |
| Coordinator fails during composition | Source canvases are untouched; partial coordinator state is cleaned on recovery |
| Coordinator restarts after materialization | Its retained result canvases are lost, matching current in-memory DataCanvas behavior |
| One source export fails | The whole composition fails; no partial result is returned or retained |
| Source changes while exporting | The exported Parquet file is the snapshot boundary; provenance records its capture time and hash |

Sources grant read/export access only. They do not give peers the ability to register, replace, drop, or clear local tables. A later result-write feature must use a separate destination-issued write grant and an atomic import.

The fabric never receives upstream API keys or OAuth tokens. Fabric credentials are audience-bound, excluded from logs and traces, and useless against the upstream data source.

## Why keep a broker

Canvas ownership does not require a daemon. The broker earns its place by providing one transport-independent fabric connection for every participant:

- live instance discovery and leases
- authority and grant resolution
- snapshot routing and stream multiplexing
- cancellation and backpressure
- policy and audit records
- a stable home for the composition tools

The broker owns no source canvas registry or source DuckDB. It may run its own ordinary DuckDB-backed DataCanvas as the query coordinator, just as another participating server would.

## The rest of the fabric

Federated DataCanvas composition is the first useful application. The broker can later add:

1. Typed fact events with replay, deduplication, expiry, causation IDs, and trace context.
2. Host-mediated recipes that turn events into proposed MCP calls.
3. Policy-gated background workflows for explicitly approved effects.
4. Capability packs that activate when the required producers, resolvers, and sinks are present.
5. Federation between brokers. LAN discovery advertises brokers, pairing establishes trust, and mutual TLS carries an explicitly exported capability set. Tailcat can be one federation adapter.

## Applications

| Application | Example sources | Composition |
|---|---|---|
| Drug safety radar | openFDA, ClinicalTrials.gov, ChEMBL, PubMed | Join recalls, adverse events, trials, mechanisms, and literature into a drug dossier |
| Exposure-aware security watch | attack surface, NIST NVD, OSV, service status | Filter advisories against the user's packages, domains, certificates, and services |
| Disaster impact workspace | earthquakes, NWS, FEMA, OpenStreetMap, Census | Combine facilities, roads, population, weather, and declarations into one incident view |
| Living evidence graph | bioRxiv, Crossref, OpenAlex, ORCID, PubMed | Reconcile preprints, publications, citations, and author identities |
| Economic model | Federal Reserve, BLS, Census, EIA, Treasury | Align vintage-aware indicators without putting raw series in model context |

Identifier metadata still matters. Producers should declare namespaces such as `doi`, `pmid`, `orcid`, `nct`, `cve`, `cpe`, `purl`, `sec.cik`, `geo.fips`, `drug.ndc`, and `chembl.id`. The fabric may suggest exact identifier matches or a resolver-backed crosswalk. It must not auto-join arbitrary names.

## Prototype sequence

1. Build the local broker registry, participant leases, and qualified table references.
2. Add a source participant bridge that issues read-only grants and streams a local table through the existing Parquet export path.
3. Add `CanvasInstance.importTable()` for a bounded, atomic Parquet stream import.
4. Host the two composition tools in a long-running fabric coordinator using an ordinary DuckDB DataCanvas.
5. Compose tables from two different participant authorities and two different local canvas IDs.
6. Return one inline result and one materialized coordinator-owned result reference.
7. Add snapshot provenance, cancellation, limits, stale-authority handling, and cleanup tests.

### Acceptance criteria

- Source servers remain on `CANVAS_PROVIDER_TYPE=duckdb`; no fabric provider exists.
- Existing local DataCanvas behavior and tool contracts remain unchanged.
- A raw `canvas_id` is insufficient for federation; every source is bound to a live authority and grant.
- Describe returns the exact schemas and aliases the composition SQL uses.
- Query joins snapshots from two independent source canvases without routing table data through model context.
- Inline mode destroys all coordinator state after returning bounded rows.
- Materialize mode returns a valid coordinator-owned `FabricTableRef` for follow-up composition or local querying.
- Fabric failure never breaks local DataCanvas operations.
- Restarted or expired sources fail with an actionable stale-reference or re-stage error.
- Cancellation and any source failure leave no partial result or scratch artifact.
- The composition path contains no conditional behavior based on the source server's MCP transport.
- Local DuckDB mode passes the existing test suite unchanged.

## Open prototype questions

- Whether the broker daemon and MCP composition facade should be one process or two.
- The default TTL and memory cap for retained coordinator result canvases.
- Whether a qualified reference is a structured object or one opaque fabric-minted token.
- How a host or deployment maps independently authenticated users into a shared fabric workspace.
- When predicate/projection pushdown earns the protocol complexity.
- Whether materializing into a named destination server is useful enough to add write grants.
- Whether persistent result canvases belong in the coordinator or an artifact store.

## Explicit non-goals

- A `fabric` DataCanvas provider type
- A globally portable raw `canvas_id`
- A shared DuckDB file or distributed canvas registry
- Live distributed SQL in the first version
- Any dependency on the server's MCP transport
- Silent peer tool invocation
- Sharing upstream credentials
- Automatic joins inferred from similar column names
- Broker federation in the first prototype

## Grounding references

- `src/services/canvas/core/CanvasRegistry.ts` — local process/tenant ownership and TTLs
- `src/services/canvas/core/DataCanvas.ts` and `CanvasInstance.ts` — current high-level canvas API
- `src/services/canvas/core/IDataCanvasProvider.ts` — current provider boundary
- `src/services/canvas/providers/duckdb/DuckdbProvider.ts` — Parquet export and same-process `importFrom()` implementation
- `src/services/canvas/types.ts` — current operation and result types
- `skills/api-canvas/SKILL.md` — current integration and token-sharing model
- `src/core/app.ts` — setup, capability extensions, core services, and shutdown lifecycle
- [MCP architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
- [Tailcat](https://tailscale.com/blog/tailcat)
