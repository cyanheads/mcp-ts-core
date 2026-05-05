/**
 * @fileoverview Worker-runtime fixture for createWorkerHandler tests.
 * @module tests/fixtures/worker-runtime.fixture
 */

import { type CloudflareBindings, createWorkerHandler } from '@/core/worker.js';

interface WorkerRuntimeBindings extends CloudflareBindings {
  CUSTOM_API_KEY?: string;
  CUSTOM_KV?: KVNamespace;
}

type RuntimeProbe = {
  customApiKey: string | undefined;
  hasCustomKv: boolean;
  storageProvider: string | undefined;
};

type ScheduledProbe = {
  cron: string;
  customApiKey: string | undefined;
  hasCustomKv: boolean;
  scheduledTime: number;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  CUSTOM_KV_GLOBAL?: KVNamespace;
  __WORKER_RUNTIME_PROBE__?: RuntimeProbe;
  __WORKER_SCHEDULED_PROBE__?: ScheduledProbe;
};

export default createWorkerHandler({
  name: 'worker-runtime-fixture',
  version: '0.0.0-test',
  extraEnvBindings: [['CUSTOM_API_KEY', 'CUSTOM_API_KEY']],
  extraObjectBindings: [['CUSTOM_KV', 'CUSTOM_KV_GLOBAL']],
  setup() {
    runtimeGlobal.__WORKER_RUNTIME_PROBE__ = {
      customApiKey: process.env.CUSTOM_API_KEY,
      hasCustomKv: runtimeGlobal.CUSTOM_KV_GLOBAL != null,
      storageProvider: process.env.STORAGE_PROVIDER_TYPE,
    };
  },
  async onScheduled(controller, env: WorkerRuntimeBindings) {
    runtimeGlobal.__WORKER_SCHEDULED_PROBE__ = {
      cron: controller.cron,
      customApiKey: process.env.CUSTOM_API_KEY,
      hasCustomKv: env.CUSTOM_KV === runtimeGlobal.CUSTOM_KV_GLOBAL,
      scheduledTime: controller.scheduledTime,
    };
  },
});
