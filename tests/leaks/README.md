# Lifecycle gate

`bun run test:leaks` runs the root Vitest runtime projects on real Node >=24:
unit, compliance, smoke, and fuzz. Root type checks still run; integration and
Workerd are separate lanes and are not measured here. File filters work as with
Vitest: `bun run test:leaks tests/unit/services/llm/providers/openrouter.provider.test.ts`.

The gate observes every async allocation from test-file collection through
worker teardown, including callbacks without a test-file stack or async parent.
It collects retention evidence after Vitest acknowledges teardown and the parent
disconnects IPC, so the runner's own pending work can settle. It uses weak
references, removes destroyed resources (including promises), and gives GC and the event loop time to settle.
Pending promises that have become unreachable pass. Retained unresolved promises,
live timers (including unref'd timers), open sockets, and unclassified operation
resources fail. The observer never inherits Vitest's broad resource-type ignores.

Node's default DNS resolver and DuckDB's native reference reaper belong to their
module/Node environment. Their exact import-time allocation IDs are inventoried
separately. Only those declared owners qualify; later allocations from their
callbacks remain operations. A separate child loads both modules, runs and closes
five real DuckDB database/connection/query cycles, and must exit naturally. A
missing owner report, unexpected startup resource, or shutdown timeout fails.
A custom Vitest fork pool also disconnects its IPC channel after teardown and
requires each actual test worker to exit naturally within three seconds. A live
handle created by a finalizer without an attributable test stack still fails.
Forced termination records failure and propagates a nonzero process status.

Every invocation retains raw per-file resource stacks, startup identities, the
selected-file manifest, worker exit evidence, and process logs under
`reports/leaks/run-*`. Missing, malformed, mismatched, or failing evidence cannot produce a passing exit. The
collector allows up to two seconds for delayed destruction after its initial GC
turns; the outer root run has a ten-minute watchdog. Termination is failure cleanup.

`tests/unit/testing/leak-gate.test.ts` runs isolated sentinel suites that deliberately
retain promises, timers, and sockets, including resources allocated by asynchronous
callbacks in another file and unattributed finalizers. It also checks clean
cleanup, ordinary assertion failure, missing evidence, missing GC/runtime support, and process timeout behavior.
Each case spawns a full Vitest run, so it has its own `leak-gate` project
(`bun run test:leak-gate`) and the gate skips it rather than re-running itself.

This is an async-resource retention gate, not a general heap or native-memory leak
oracle. It cannot discover native allocations that expose no async-hooks lifetime,
or allocations made before file collection that do not keep the worker alive.
Machine-speed baselines remain in `tests/benchmarks`; the lifecycle deadlines are cleanup bounds,
not performance regression thresholds. Vitest's stock diagnostic is still available
with `bunx vitest run --detect-async-leaks`, but its exit status is not a leak gate.
