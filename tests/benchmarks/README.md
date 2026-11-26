# Framework benchmarks

Run the same fixed workloads before and after an optimization:

```sh
BENCH_OUTPUT_DIR=reports/benchmarks/bun-before bun run bench
BENCH_OUTPUT_DIR=reports/benchmarks/bun-after BENCH_BASELINE_DIR=reports/benchmarks/bun-before bun run bench

BENCH_OUTPUT_DIR=reports/benchmarks/node-before bun run bench:node
BENCH_OUTPUT_DIR=reports/benchmarks/node-after BENCH_BASELINE_DIR=reports/benchmarks/node-before bun run bench:node
```

Both commands run once. Each workload writes its result to `<name>.json` in `BENCH_OUTPUT_DIR`, a path relative to the repository root that defaults to `reports/benchmarks/bun` or `reports/benchmarks/node` and is overwritten on the next run into it. With `BENCH_BASELINE_DIR` set, each workload runs beside the same workload's saved result and prints both; a workload with no saved result fails. A failed workload writes no result, so use only successful, complete runs as baselines. Each directory also holds `environment.json` with the runtime version, CPU, OS, framework version, Git revision, dirty-tree flag, and measurement settings. Reports are gitignored. Keep the result and environment files together; for a dirty tree, also retain the source diff and any new workload files outside the timed run.

`bench:node` resolves an actual Node binary even when Bun's run configuration shadows `node`. The environment file records the runtime that executed the command. Compare Node with Node and Bun with Bun, using the same runtime version and machine.

| Workload | Sizes | What one operation measures |
| --- | --- | --- |
| Tool pipeline, default JSON format | 1, 100, 1,000 records | Input validation, Context construction, execution instrumentation, handler return, output validation, formatting |
| Tool pipeline, Markdown and enrichment | 1, 100, 1,000 records | The same pipeline plus enrichment validation and trailer rendering |
| Storage get | 100, 1,000, 10,000 resident keys | StorageService validation/instrumentation and one in-memory lookup |
| Storage getMany | Same | One batch of 100 reads |
| Storage setMany | Same | One batch overwriting 100 keys, including provider capacity bookkeeping |
| Storage list | Same | First 50 keys from a prefix matching the whole namespace, including scan/sort/cursor creation |
| Rate limiter hit | 100, 10,000 tracked keys | 100 checks of an existing, non-exhausted key |
| Rate limiter churn | Same | 100 new keys at capacity, each requiring eviction |

Rate-limiter operations batch 100 checks to amortize clock overhead and avoid millions of tiny timing samples.

The tool handler returns deterministic in-memory records. These measure framework processing, not upstream API latency. Storage has fixed occupancy throughout; writes overwrite existing keys. Rate-limit windows cannot expire during a normal run, quotas cannot be exhausted, and cleanup timers are disabled. Logger initialization and fixture construction happen before timing. Logging is initialized at `emerg`; OTel API calls remain in the measured path with no SDK or exporters registered.

Workload setup checks expected results. Untimed teardown checks observed results and resource state, so a faster implementation that omits output or silently grows storage fails. Files run serially in isolated forks. `benchmarkOptions` in `options.ts` sets the warmup and measurement budget every workload shares. There are no performance thresholds in `test:all`; security and resource-bound invariants remain ordinary regression tests.

For a focused run:

```sh
bun run bench storage
bun run bench:node tool-pipeline --testNamePattern '100 records'
```

Use a quiet machine on stable power. Run the baseline and candidate several times, alternating their order when practical. Check sample count and relative margin of error (RME); if variation is comparable to the claimed improvement, the result is inconclusive. Each workload's table holds only that workload and, in a comparison run, its baseline; the “fastest” label marks the faster of the two. Do not interpret throughput as HTTP request throughput or microbenchmark percentiles as end-to-end latency percentiles.

These microbenchmarks complement the I/O lane below. Cold startup, memory profiling, and telemetry-export cost remain separate measurements. Keep input sizes and benchmark names stable during a comparison; changing the workload requires a new baseline.

Runner reference: [Vitest benchmarking](https://vitest.dev/guide/benchmarking).

Each workload is a Vitest test that runs one registration of the `bench` fixture through `harness/workload.ts`. Its setup and teardown checks are Tinybench `beforeAll`/`afterAll` hooks, which run once around the warmup phase and once around the measured phase. `harness/setup.ts` initializes logging before a file's workloads and closes it after them.

## HTTP, Worker, and native I/O

Rebuild first: HTTP and Worker fixtures import the built package and reject stale output.

```sh
bun run rebuild
bun run bench:io                     # Real Node: HTTP, Workerd, filesystem, SQLite, DuckDB
bun run bench:io:bun                 # Bun: HTTP, filesystem, SQLite, DuckDB
bun run bench:io --project worker    # Focused real Workerd timing
bun run bench:io --project http
bun run bench:io --project native --testNamePattern SQLite
```

The I/O lane uses ordinary Vitest tests with awaited cleanup. It fails on incorrect results, request timeouts, or cleanup errors, and has no speed thresholds. It runs serially, without coverage or telemetry exporters. `bench:io` resolves real Node even under Bun's PATH shim. Wrangler is the `devDependencies` entry, at the version `bun.lock` pins, with the Workerd it installs; no CLI is downloaded and no Cloudflare account, deployed service, or external API is used. Temporary Worker storage and native files are removed after each test.

| Workload | Fixed sizes | Measurement unit |
| --- | --- | --- |
| HTTP and Workerd echo | 128-byte and 16-KiB ASCII payloads; concurrency 1, 8, 32 | Authenticated modern MCP request through complete body consumption and JSON parsing |
| HTTP and Workerd state | Two JWT tenants, 128 keys each, concurrency 16 | MCP request performing set + get; same key names across tenants |
| HTTP and Workerd rejection | Invalid JWT, concurrency 16 | HTTP 401 response; authorized recovery checked afterward |
| Filesystem reads | 100 / 1,000 keys, 1-KiB values, concurrency 8 | StorageService get and file parsing |
| Filesystem overwrites | Same occupancy, 64 distinct keys, concurrency 8 | StorageService set and file write; contents verified afterward |
| Filesystem list | Same occupancy, all keys match | First 50 keys, TTL filtering, values, and cursor |
| SQLite mirror | 1,000 / 10,000 rows | getByIds(50), indexed query + count, FTS query + count |
| SQLite writes | Same occupancy, FTS enabled | Transactional upsert of 100 rows with changing scores and FTS text; contents/index/count/integrity verified afterward |
| DuckDB queries | 1,000 / 10,000 rows | SQL gate + capped 50-row read, or grouped aggregation |
| DuckDB exports | Same tables | CSV file overwrite, including native export and file metadata; full CSV checked afterward |

Per-case operation and warmup counts live with the workloads: `io/transport-workloads.ts` for the HTTP and Workerd cases, `io/native.perf.test.ts` for the filesystem, SQLite, and DuckDB cases. Every case runs three measured rounds, each preceded by warmup. This is a **closed-loop** load model: at most the configured number of operations are in flight, and a new operation starts after a prior one completes and passes verification. It measures latency at that offered concurrency; it does not model an arrival-rate queue or establish a production SLO. The harness stops scheduling after a failure and drains in-flight work before fixture cleanup.

Latency samples cover each awaited operation; correctness assertions run after its timer stops. Throughput includes client scheduling and verification overhead. Transport timings include request construction, loopback networking, JWT verification, framework work, body consumption, and JSON parsing. They exclude server startup. Untimed read-only probes verify that both tenants retain their own stored values after the concurrent write workload. Workerd timing uses the **host clock**, not the isolate's restricted clock, and includes local emulated KV for the state workload. It is not Cloudflare network latency or isolate CPU time. HTTP uses in-memory storage, so only the echo/rejection cases have matching backend work across these two servers.

Native measurements use warm OS caches. Filesystem writes do not claim fsync durability; SQLite uses the framework's WAL/NORMAL settings; DuckDB databases are in memory and exports write actual files. SQLite uses `bun:sqlite` on Bun and `better-sqlite3` on Node. Known issue [#364](https://github.com/cyanheads/mcp-ts-core/issues/364) means Bun statement disposal is not established by these timings; the isolated test process bounds native handle lifetime. No cold-disk, connection-release, or memory claim is made.

Successful workload families write timestamped JSON files under `reports/benchmarks/io/`; failed families produce no report. Use only a successful full run when comparing the whole lane. Set `BENCH_OUTPUT_DIR` to keep a baseline and candidate in separate directories:

```sh
BENCH_OUTPUT_DIR=reports/benchmarks/io-before bun run bench:io
# After the change and rebuild:
BENCH_OUTPUT_DIR=reports/benchmarks/io-after bun run bench:io
```

Reports retain every latency sample, per-round p50/p95/p99/min/max, throughput, operation counts, hardware/runtime details, lockfile hash, Git revision, and dirty-tree status. Compare the same named case and round configuration on the same machine/runtime; retain the diff and new files for uncommitted baselines. Small samples make p99 especially noisy: inspect all three rounds, repeat runs, and avoid treating a single tail sample as an optimization result. Reports never overwrite a previous run.

The deterministic harness tests run in the unit gate. `test:worker` also starts a standalone built Worker through Wrangler, outside the test pool's module loader, and checks concurrent tenant isolation and auth rejection/recovery. That startup gate catches [#406](https://github.com/cyanheads/mcp-ts-core/issues/406), where eager cursor-key generation passed inside the test pool but prevented a standalone bundle from starting.
