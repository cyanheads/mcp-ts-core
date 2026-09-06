/** @fileoverview Async-resource retention from file collection through worker teardown. */
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';

interface Origin {
  owner: string | null;
  stack: string;
}
interface RecordEntry extends Origin {
  id: number;
  ref: WeakRef<object>;
  type: string;
}
/** Serializable evidence; startup identities remain separate from operation findings. */
export interface ResourceFinding extends Origin {
  id: number;
  type: string;
}

/** Observe a file without retaining promises or counting the collector's own async work. */
export class ResourceObserver {
  private readonly records = new Map<number, RecordEntry>();
  private readonly instrumentation = new AsyncLocalStorage<boolean>();
  private readonly hook: ReturnType<typeof createHook>;
  private readonly gc: () => void;
  private readonly stackLimit = Error.stackTraceLimit;
  private startupOwner: string | null = null;
  private captured = 0;

  constructor() {
    if (process.versions.bun || typeof globalThis.gc !== 'function') {
      throw new Error('Resource observation requires real Node with --expose-gc');
    }
    this.gc = globalThis.gc;
    Error.stackTraceLimit = 100;
    this.hook = createHook({
      init: (id, type, _trigger, resource: object) => {
        if (this.instrumentation.getStore()) return;
        this.records.set(id, {
          id,
          type,
          ref: new WeakRef(resource),
          stack: new Error().stack!,
          owner: this.startupOwner,
        });
        this.captured++;
      },
      destroy: (id) => this.records.delete(id),
      promiseResolve: (id) => this.records.delete(id),
    }).enable();
  }

  /** Inventory exact allocations of a synchronous native-module load, never test operations. */
  bootstrap<T>(owner: string, load: () => T): T {
    this.startupOwner = owner;
    try {
      return load();
    } finally {
      this.startupOwner = null;
    }
  }

  /** Exclude only the observer's own collection and reporting continuations. */
  instrument<T>(work: () => T): T {
    return this.instrumentation.run(true, work);
  }

  /** Yield actual event-loop turns and collect unreachable promises before reporting retention. */
  collect() {
    return this.instrumentation.run(true, async () => {
      try {
        for (let turn = 0; turn < 8; turn++) {
          await setImmediate();
          this.gc();
        }
        // Some runtimes retire cleared socket timer wheels on their next maintenance tick.
        // A bounded quiescence window allows actual destruction, never type/stack suppression.
        const deadline = performance.now() + 2_000;
        while (
          [...this.records.values()].some((r) => !r.owner && r.type !== 'PROMISE') &&
          performance.now() < deadline
        ) {
          await setTimeout(25);
          this.gc();
        }
        await setImmediate();
        await setImmediate();
        const findings: ResourceFinding[] = [];
        const startup: ResourceFinding[] = [];
        for (const { id, type, ref, stack, owner } of this.records.values()) {
          // A collected promise cannot retain its losing race graph. Native resources
          // require a destroy callback: a collected wrapper alone proves nothing.
          if (type === 'PROMISE' && !ref.deref()) continue;
          (owner ? startup : findings).push({ id, type, stack, owner });
        }
        return { captured: this.captured, findings, startup };
      } finally {
        this.hook.disable();
        this.instrumentation.disable();
        this.records.clear();
        Error.stackTraceLimit = this.stackLimit;
      }
    });
  }
}
