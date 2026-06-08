/**
 * @fileoverview Unit tests for the scheduler service built on node-cron.
 * @module tests/utils/scheduling/scheduler.test
 */

import { trace } from '@opentelemetry/api';
import * as cron from 'node-cron';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { JsonRpcErrorCode, type McpError as McpErrorType } from '@/types-global/errors.js';
import { logger } from '../../../../src/utils/internal/logger.js';

const validateMock = vi.fn(() => true);
const createTaskMock = vi.fn(
  (schedule: string, handler: () => Promise<void> | void) =>
    ({
      start: vi.fn(),
      stop: vi.fn(),
      trigger: () => handler(),
      schedule,
    }) as unknown as {
      start: () => void;
      stop: () => void;
      trigger: () => Promise<void> | void;
    },
);

let validateSpy: MockInstance;
let createTaskSpy: MockInstance;

type SchedulerModule = typeof import('../../../../src/utils/scheduling/scheduler.js');
let schedulerService: SchedulerModule['schedulerService'];

describe('schedulerService', () => {
  let infoSpy: MockInstance;
  let warningSpy: MockInstance;
  let errorSpy: MockInstance;
  let getActiveSpanSpy: MockInstance;

  beforeEach(async () => {
    createTaskMock.mockClear();
    validateMock.mockClear();
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    warningSpy = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    getActiveSpanSpy = vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({ traceId: 'trace', spanId: 'span' }),
    } as never);

    validateSpy = vi.spyOn(cron, 'validate').mockImplementation(validateMock as never);
    createTaskSpy = vi.spyOn(cron, 'createTask').mockImplementation(createTaskMock as never);

    const module: SchedulerModule = await import('../../../../src/utils/scheduling/scheduler.js');
    schedulerService = module.schedulerService;
    (schedulerService as unknown as { jobs: Map<string, unknown> }).jobs.clear();
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warningSpy.mockRestore();
    errorSpy.mockRestore();
    getActiveSpanSpy.mockRestore();
    validateSpy?.mockRestore();
    createTaskSpy?.mockRestore();
    if (schedulerService) {
      (schedulerService as unknown as { jobs: Map<string, unknown> }).jobs.clear();
    }
  });

  it('refuses to schedule when the cron expression is invalid', async () => {
    validateMock.mockReturnValueOnce(false);

    await expect(
      schedulerService.schedule('invalid', 'bad pattern', () => undefined, 'Bad job'),
    ).rejects.toThrowError('Invalid cron schedule: bad pattern');
  });

  it('schedules a job, runs it successfully, and logs lifecycle events', async () => {
    const handler = vi.fn();
    const job = await schedulerService.schedule('job-1', '* * * * *', handler, 'Test job');

    expect(validateMock).toHaveBeenCalledWith('* * * * *');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(job.isRunning).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith("Job 'job-1' scheduled: Test job", expect.any(Object));

    await (job.task as unknown as { trigger: () => Promise<void> | void }).trigger();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', schedule: '* * * * *' }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "Job 'job-1' completed successfully.",
      expect.objectContaining({ jobId: 'job-1' }),
    );
    expect(job.isRunning).toBe(false);
  });

  it('prevents overlapping executions by logging a warning', async () => {
    const job = await schedulerService.schedule(
      'job-overlap',
      '* * * * *',
      () => undefined,
      'Overlap',
    );

    job.isRunning = true;
    await (job.task as unknown as { trigger: () => Promise<void> | void }).trigger();

    expect(warningSpy).toHaveBeenCalledWith(
      "Job 'job-overlap' is already running. Skipping this execution.",
      expect.objectContaining({
        operation: 'scheduler:job:job-overlap',
        jobId: 'job-overlap',
      }),
    );
  });

  it('captures errors thrown by the scheduled handler', async () => {
    const failure = new Error('boom');
    const job = await schedulerService.schedule(
      'job-fail',
      '* * * * *',
      () => {
        throw failure;
      },
      'Should fail',
    );

    await (job.task as unknown as { trigger: () => Promise<void> | void }).trigger();

    expect(errorSpy).toHaveBeenCalledWith(
      "Job 'job-fail' failed.",
      failure,
      expect.objectContaining({ jobId: 'job-fail' }),
    );
    expect(job.isRunning).toBe(false);
  });

  it('supports start, stop, and remove operations on jobs', async () => {
    const job = await schedulerService.schedule(
      'job-control',
      '* * * * *',
      () => undefined,
      'Control',
    );
    const task = job.task as unknown as {
      start: MockInstance;
      stop: MockInstance;
    };

    schedulerService.start('job-control');
    expect(task.start).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "Job 'job-control' started.",
      expect.objectContaining({ operation: 'scheduler:start', jobId: 'job-control' }),
    );

    schedulerService.stop('job-control');
    expect(task.stop).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "Job 'job-control' stopped.",
      expect.objectContaining({ operation: 'scheduler:stop', jobId: 'job-control' }),
    );

    schedulerService.remove('job-control');
    expect(infoSpy).toHaveBeenCalledWith(
      "Job 'job-control' removed.",
      expect.objectContaining({ operation: 'scheduler:remove', jobId: 'job-control' }),
    );
    expect(
      (schedulerService as unknown as { jobs: Map<string, unknown> }).jobs.has('job-control'),
    ).toBe(false);
  });

  it('rejects duplicate job identifiers', async () => {
    await schedulerService.schedule('job-duplicate', '* * * * *', () => undefined, 'First');

    await expect(
      schedulerService.schedule('job-duplicate', '* * * * *', () => undefined, 'Second'),
    ).rejects.toThrowError("Job with ID 'job-duplicate' already exists.");
  });

  it('lists all registered jobs in insertion order', async () => {
    await schedulerService.schedule('job-a', '* * * * *', () => undefined, 'A');
    await schedulerService.schedule('job-b', '* * * * *', () => undefined, 'B');

    expect(schedulerService.listJobs().map((j) => j.id)).toEqual(['job-a', 'job-b']);
  });

  it('throws NotFound when operating on an unknown job id', () => {
    expect(() => schedulerService.start('ghost')).toThrowError(/not found/);
    expect(() => schedulerService.stop('ghost')).toThrowError(/not found/);
    expect(() => schedulerService.remove('ghost')).toThrowError(/not found/);
  });

  it('destroys all jobs, stopping each underlying task', async () => {
    const jobA = await schedulerService.schedule('job-x', '* * * * *', () => undefined, 'X');
    const jobB = await schedulerService.schedule('job-y', '* * * * *', () => undefined, 'Y');
    const stopA = (jobA.task as unknown as { stop: MockInstance }).stop;
    const stopB = (jobB.task as unknown as { stop: MockInstance }).stop;

    schedulerService.destroyAll();

    expect(stopA).toHaveBeenCalled();
    expect(stopB).toHaveBeenCalled();
    expect(schedulerService.listJobs()).toHaveLength(0);
    expect(infoSpy).toHaveBeenCalledWith(
      'All scheduled jobs destroyed (2 removed).',
      expect.any(Object),
    );
  });

  it('wraps a non-Error value thrown by the handler', async () => {
    const job = await schedulerService.schedule(
      'job-throw-str',
      '* * * * *',
      () => {
        throw 'string failure';
      },
      'Throws a string',
    );

    await (job.task as unknown as { trigger: () => Promise<void> | void }).trigger();

    expect(errorSpy).toHaveBeenCalledWith(
      "Job 'job-throw-str' failed.",
      expect.any(Error),
      expect.objectContaining({ jobId: 'job-throw-str' }),
    );
  });
});

describe('schedulerService (non-Node runtime)', () => {
  it('should throw McpError when scheduling in a non-Node runtime', async () => {
    // Mock runtimeCaps to simulate a non-Node environment
    vi.doMock('@/utils/internal/runtime.js', () => ({
      runtimeCaps: {
        isNode: false,
        isWorkerLike: true,
        isBrowserLike: false,
        hasProcess: false,
        hasBuffer: false,
        hasTextEncoder: true,
        hasPerformanceNow: true,
      },
    }));

    // Reset the module cache so loadCron picks up the mocked runtimeCaps
    vi.resetModules();

    const { SchedulerService } = await import('../../../../src/utils/scheduling/scheduler.js');
    const service = SchedulerService.getInstance();

    await expect(service.schedule('test', '* * * * *', () => undefined, 'Test')).rejects.toThrow(
      /requires a Node\.js runtime/,
    );

    // Clean up
    vi.doUnmock('@/utils/internal/runtime.js');
    vi.resetModules();
  });
});

describe('schedulerService (missing node-cron peer)', () => {
  it('wraps a module-not-found error into a configurationError naming the peer', async () => {
    // Mock the node-cron module to simulate it not being installed.
    vi.doMock('node-cron', () => {
      throw new Error("Cannot find package 'node-cron'");
    });

    vi.resetModules();

    const { McpError } = await import('@/types-global/errors.js');
    const { SchedulerService } = await import('../../../../src/utils/scheduling/scheduler.js');
    const service = SchedulerService.getInstance();

    let caught: unknown;
    try {
      await service.schedule('test-peer', '* * * * *', () => undefined, 'Test');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(McpError);
    const err = caught as McpErrorType;
    expect(err.message).toMatch(/node-cron/);
    expect(err.message).toMatch(/peer dependency/);
    expect(err.message).toMatch(/\^4\.2\.1/);
    expect(err.code).toBe(JsonRpcErrorCode.ConfigurationError);
    // The underlying module-not-found error chains via `cause` (3rd factory arg),
    // not the wire-serialized `data` payload.
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.data).toBeUndefined();

    // Clean up
    vi.doUnmock('node-cron');
    vi.resetModules();
  });
});
