/**
 * @fileoverview Provides a singleton service for scheduling and managing cron jobs.
 *
 * Wraps the `node-cron` library with a unified interface for defining, starting,
 * stopping, and listing recurring tasks. The `node-cron` module is loaded lazily
 * on first use — it is not imported at startup. This keeps the module importable
 * in any environment; runtime errors surface only when scheduling is actually
 * attempted in an unsupported environment (e.g., Cloudflare Workers).
 *
 * **Node.js only.** Calling `schedule()` in a non-Node.js runtime throws
 * `McpError(ConfigurationError)`.
 *
 * @module src/utils/scheduling/scheduler
 */
import type { ScheduledTask } from 'node-cron';
import { configurationError, conflict, invalidParams, notFound } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

/**
 * Lazily loads the `node-cron` module on first call and caches the resulting
 * promise so subsequent calls resolve from the same import. Throws
 * `McpError(ConfigurationError)` immediately if called outside a Node.js runtime.
 *
 * @throws {McpError} `ConfigurationError` when not running in Node.js.
 */
let cronModulePromise: Promise<typeof import('node-cron')> | null = null;

async function loadCron(): Promise<typeof import('node-cron')> {
  if (!runtimeCaps.isNode || runtimeCaps.isWorkerLike) {
    throw configurationError(
      'SchedulerService requires a Node.js runtime. Cron scheduling is not available in Workers or browser environments.',
    );
  }
  if (!cronModulePromise) {
    cronModulePromise = import('node-cron').catch((err: unknown) => {
      cronModulePromise = null;
      throw configurationError(
        'SchedulerService requires the "node-cron" peer dependency — add it to your server\'s dependencies (^4.2.1).',
        undefined,
        { cause: err instanceof Error ? err : undefined },
      );
    });
  }
  return await cronModulePromise;
}

/**
 * Represents a scheduled job managed by the {@link SchedulerService}.
 *
 * @example
 * const jobs = scheduler.listJobs();
 * for (const job of jobs) {
 *   console.log(`${job.id} (${job.schedule}): running=${job.isRunning}`);
 * }
 */
export interface Job {
  /** Human-readable description of what the job does. */
  description: string;
  /** Unique identifier for the job, supplied at scheduling time. */
  id: string;
  /**
   * Whether the task function is currently executing.
   * The scheduler skips a tick if `true` to prevent overlapping runs.
   */
  isRunning: boolean;
  /** Cron pattern that defines the job's schedule (e.g., `'0 * * * *'`). */
  schedule: string;
  /** The underlying `node-cron` task instance. Use `start()`/`stop()` via the service rather than directly. */
  task: ScheduledTask;
}

/**
 * Singleton service for scheduling and managing cron jobs.
 *
 * Depends on the `node-cron` peer dependency, which is loaded lazily on the
 * first call to {@link schedule}. Cron jobs skip overlapping executions: if a
 * task is still running when its next tick fires, that tick is logged and
 * discarded. Each execution receives a fresh {@link RequestContext} for
 * correlated logging.
 *
 * Use the pre-constructed {@link schedulerService} export rather than
 * instantiating this class directly.
 *
 * @example
 * import { schedulerService } from '@/utils/scheduling/scheduler.js';
 *
 * await schedulerService.schedule(
 *   'cleanup',
 *   '0 3 * * *',
 *   async (ctx) => { await purgeOldRecords(ctx); },
 *   'Nightly cleanup of expired records',
 * );
 * schedulerService.start('cleanup');
 */
export class SchedulerService {
  private static instance: SchedulerService;
  private jobs: Map<string, Job> = new Map();

  /** @private */
  private constructor() {
    // The constructor is intentionally left empty to prevent instantiation with 'new'.
    // Logging has been removed from here to break a circular dependency
    // with the logger, which was causing a ReferenceError on startup.
  }

  /**
   * Returns the singleton instance of {@link SchedulerService}, creating it on
   * first call.
   *
   * @returns The shared `SchedulerService` instance.
   * @example
   * const scheduler = SchedulerService.getInstance();
   */
  public static getInstance(): SchedulerService {
    if (!SchedulerService.instance) {
      SchedulerService.instance = new SchedulerService();
    }
    return SchedulerService.instance;
  }

  /**
   * Registers and creates a new cron job. The job is created in a stopped
   * state — call {@link start} to begin execution.
   *
   * Lazily imports `node-cron` on the first call. Validates the cron pattern
   * before storing the job. Each execution of `taskFunction` receives a fresh
   * {@link RequestContext} with `operation` set to `scheduler:job:<id>`.
   * Overlapping runs are skipped: if the previous execution is still in
   * progress when the next tick fires, that tick is logged and discarded.
   * Errors thrown by `taskFunction` are caught and logged; they do not
   * propagate to the scheduler.
   *
   * @param id - Unique identifier for the job. Must not already be registered.
   * @param schedule - Standard cron expression (five or six fields, e.g. `'0 * * * *'`).
   * @param taskFunction - Async (or sync) function to run on each tick. Receives a
   *   `RequestContext` scoped to the job execution.
   * @param description - Human-readable description stored on the {@link Job} object.
   * @returns The newly created {@link Job} (in stopped state).
   * @throws {McpError} `Conflict` (-32002) if a job with the same `id` already exists.
   * @throws {McpError} `InvalidParams` (-32602) if `schedule` is not a valid cron expression.
   * @throws {McpError} `ConfigurationError` (-32008) if called outside a Node.js runtime.
   * @example
   * const job = await schedulerService.schedule(
   *   'ping',
   *   '* * * * *',
   *   async (ctx) => { logger.info('ping', ctx); },
   *   'Logs a ping every minute',
   * );
   * schedulerService.start('ping');
   */
  public async schedule(
    id: string,
    schedule: string,
    taskFunction: (context: RequestContext) => void | Promise<void>,
    description: string,
  ): Promise<Job> {
    if (this.jobs.has(id)) {
      throw conflict(`Job with ID '${id}' already exists.`);
    }

    const cron = await loadCron();

    if (!cron.validate(schedule)) {
      throw invalidParams(`Invalid cron schedule: ${schedule}`);
    }

    const task = cron.createTask(schedule, async () => {
      const job = this.jobs.get(id);
      const context = requestContextService.createRequestContext({
        operation: `scheduler:job:${id}`,
        jobId: id,
        schedule,
      });

      if (job?.isRunning) {
        logger.warning(`Job '${id}' is already running. Skipping this execution.`, context);
        return;
      }

      if (job) {
        job.isRunning = true;
      }

      logger.info(`Starting job '${id}'...`, context);
      try {
        await Promise.resolve(taskFunction(context));
        logger.info(`Job '${id}' completed successfully.`, context);
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Job '${id}' failed.`, err, context);
      } finally {
        if (job) {
          job.isRunning = false;
        }
      }
    });

    const newJob: Job = {
      id,
      schedule,
      description,
      task,
      isRunning: false,
    };

    const context = requestContextService.createRequestContext({
      operation: 'scheduler:schedule',
      jobId: id,
    });
    this.jobs.set(id, newJob);
    logger.info(`Job '${id}' scheduled: ${description}`, context);
    return newJob;
  }

  /**
   * Starts a previously registered job, causing it to execute on its cron schedule.
   *
   * @param id - ID of the job to start, as supplied to {@link schedule}.
   * @returns `void`
   * @throws {McpError} `NotFound` (-32001) if no job with the given `id` exists.
   * @example
   * schedulerService.start('cleanup');
   */
  public start(id: string): void {
    const job = this.resolveJob(id);
    void job.task.start();
    const context = requestContextService.createRequestContext({
      operation: 'scheduler:start',
      jobId: id,
    });
    logger.info(`Job '${id}' started.`, context);
  }

  /**
   * Stops a running job. The job remains registered and can be restarted with
   * {@link start}. Any in-progress execution completes normally.
   *
   * @param id - ID of the job to stop.
   * @returns `void`
   * @throws {McpError} `NotFound` (-32001) if no job with the given `id` exists.
   * @example
   * schedulerService.stop('cleanup');
   */
  public stop(id: string): void {
    const job = this.resolveJob(id);
    void job.task.stop();
    const context = requestContextService.createRequestContext({
      operation: 'scheduler:stop',
      jobId: id,
    });
    logger.info(`Job '${id}' stopped.`, context);
  }

  /**
   * Stops and permanently removes a job from the scheduler. The job cannot be
   * restarted after removal; call {@link schedule} to re-register it.
   *
   * @param id - ID of the job to remove.
   * @returns `void`
   * @throws {McpError} `NotFound` (-32001) if no job with the given `id` exists.
   * @example
   * schedulerService.remove('cleanup');
   */
  public remove(id: string): void {
    const job = this.resolveJob(id);
    void job.task.stop();
    this.jobs.delete(id);
    const context = requestContextService.createRequestContext({
      operation: 'scheduler:remove',
      jobId: id,
    });
    logger.info(`Job '${id}' removed.`, context);
  }

  /**
   * Looks up a job by ID.
   *
   * @param id - Job ID to look up.
   * @returns The {@link Job} record.
   * @throws {McpError} `NotFound` (-32001) if the job does not exist.
   */
  private resolveJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) {
      throw notFound(`Job with ID '${id}' not found.`);
    }
    return job;
  }

  /**
   * Stops and removes all registered jobs. Intended for use during server
   * shutdown to prevent `node-cron` timers from keeping the event loop alive.
   *
   * Each job's underlying `ScheduledTask` is stopped before the map is cleared.
   * In-progress executions are not forcibly interrupted — they will complete
   * naturally, but no further ticks will fire.
   *
   * @remarks
   * This method should be called from the application's shutdown sequence
   * (e.g., in `app.ts` signal handler) to ensure a clean exit.
   *
   * @example
   * // During server shutdown
   * schedulerService.destroyAll();
   */
  public destroyAll(): void {
    const context = requestContextService.createRequestContext({
      operation: 'scheduler:destroyAll',
    });
    for (const job of this.jobs.values()) {
      void job.task.stop();
    }
    const count = this.jobs.size;
    this.jobs.clear();
    logger.info(`All scheduled jobs destroyed (${count} removed).`, context);
  }

  /**
   * Returns a snapshot of all currently registered jobs, regardless of their
   * running state.
   *
   * @returns Array of all {@link Job} objects in insertion order.
   * @example
   * for (const job of schedulerService.listJobs()) {
   *   console.log(job.id, job.isRunning ? 'running' : 'stopped');
   * }
   */
  public listJobs(): Job[] {
    return Array.from(this.jobs.values());
  }
}

/**
 * Pre-constructed singleton instance of {@link SchedulerService}.
 *
 * Import and use this throughout the application rather than calling
 * `SchedulerService.getInstance()` directly.
 *
 * @example
 * import { schedulerService } from '@/utils/scheduling/scheduler.js';
 *
 * await schedulerService.schedule('heartbeat', '* * * * *', heartbeatFn, 'Heartbeat');
 * schedulerService.start('heartbeat');
 */
export const schedulerService = SchedulerService.getInstance();
