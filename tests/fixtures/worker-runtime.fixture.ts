/**
 * @fileoverview Worker-runtime fixture for createWorkerHandler tests.
 * Registers a tool, resource, and prompt so the suite can exercise real MCP
 * JSON-RPC traffic (initialize, tools/list, tools/call) against the worker.
 * Also captures `runtimeCaps` from inside the isolate so tests can assert
 * `isWorkerLike === true` under `nodejs_compat`.
 *
 * Storage probe tools (storage_set / storage_get / storage_delete / storage_list)
 * are included so per-provider worker tests (R2, D1) can exercise real storage
 * operations through the HTTP surface without bypassing the handler.
 * @module tests/fixtures/worker-runtime.fixture
 */

import { prompt, resource, tool, z } from '@/core/index.js';
import { type CloudflareBindings, createWorkerHandler } from '@/core/worker.js';
import { runtimeCaps } from '@/utils/internal/runtime.js';

interface WorkerRuntimeBindings extends CloudflareBindings {
  CUSTOM_API_KEY?: string;
  CUSTOM_KV?: KVNamespace;
}

type RuntimeProbe = {
  customApiKey: string | undefined;
  hasCustomKv: boolean;
  isNode: boolean;
  isWorkerLike: boolean;
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

/** Storage probe — set a key via ctx.state. */
const storageSetTool = tool('storage_set', {
  description: 'Sets a key in storage via ctx.state. Used by provider integration tests.',
  input: z.object({
    key: z.string().describe('Storage key'),
    value: z.string().describe('Value to store (serialized as a string)'),
    ttl: z.number().optional().describe('TTL in seconds'),
  }),
  output: z.object({ ok: z.boolean().describe('Always true on success') }),
  async handler(input, ctx) {
    await ctx.state.set(
      input.key,
      input.value,
      input.ttl !== undefined ? { ttl: input.ttl } : undefined,
    );
    return { ok: true };
  },
  format: (result) => [{ type: 'text', text: `ok=${result.ok}` }],
});

/** Storage probe — get a key via ctx.state. */
const storageGetTool = tool('storage_get', {
  description: 'Gets a key from storage via ctx.state. Used by provider integration tests.',
  input: z.object({ key: z.string().describe('Storage key') }),
  output: z.object({
    found: z.boolean().describe('Whether the key was found'),
    value: z.string().nullable().describe('The stored value, or null if not found'),
  }),
  async handler(input, ctx) {
    const value = await ctx.state.get<string>(input.key);
    return { found: value !== null, value };
  },
  format: (result) => [{ type: 'text', text: result.found ? (result.value ?? '') : '(not found)' }],
});

/** Storage probe — delete a key via ctx.state. */
const storageDeleteTool = tool('storage_delete', {
  description: 'Deletes a key from storage via ctx.state. Used by provider integration tests.',
  input: z.object({ key: z.string().describe('Storage key') }),
  output: z.object({ ok: z.boolean().describe('Always true — delete is best-effort') }),
  async handler(input, ctx) {
    await ctx.state.delete(input.key);
    return { ok: true };
  },
  format: (result) => [{ type: 'text', text: `ok=${result.ok}` }],
});

/** Storage probe — list keys by prefix via ctx.state. */
const storageListTool = tool('storage_list', {
  description:
    'Lists keys with a prefix from storage via ctx.state. Used by provider integration tests.',
  input: z.object({ prefix: z.string().describe('Key prefix to list') }),
  output: z.object({
    keys: z.array(z.string()).describe('Matching keys'),
    count: z.number().describe('Number of matching keys'),
  }),
  async handler(input, ctx) {
    // Use limit=100 so the provider's limit+1 pagination probe stays under
    // miniflare R2's hard cap of 1000 (provider fetches limit+1 to detect
    // more pages — default of 1000 would request 1001, exceeding the cap).
    const result = await ctx.state.list(input.prefix, { limit: 100 });
    const keys = result.items.map((item) => item.key);
    return { keys, count: keys.length };
  },
  format: (result) => [{ type: 'text', text: result.keys.join('\n') }],
});

const echoTool = tool('echo', {
  description: 'Echoes the supplied message.',
  input: z.object({ message: z.string().describe('Message to echo back') }),
  output: z.object({ echoed: z.string().describe('Echoed message') }),
  handler: (input) => ({ echoed: input.message }),
  format: (result) => [{ type: 'text', text: result.echoed }],
});

const runtimeResource = resource('worker-runtime://caps', {
  description: 'Returns runtime capability flags as observed inside the isolate.',
  mimeType: 'application/json',
  params: z.object({}).describe('No parameters.'),
  handler: () => ({
    isNode: runtimeCaps.isNode,
    isWorkerLike: runtimeCaps.isWorkerLike,
  }),
});

const greetingPrompt = prompt('worker_hello', {
  description: 'Renders a hello prompt for the worker fixture.',
  args: z.object({ name: z.string().describe('Name to greet') }),
  generate: (args) => [{ role: 'user', content: { type: 'text', text: `Hello, ${args.name}!` } }],
});

export default createWorkerHandler({
  name: 'worker-runtime-fixture',
  version: '0.0.0-test',
  tools: [echoTool, storageSetTool, storageGetTool, storageDeleteTool, storageListTool],
  resources: [runtimeResource],
  prompts: [greetingPrompt],
  // Exercises the (env) => string resolver for `instructions` (#91).
  // Concatenated literal so the test can match deterministic substrings.
  instructions: (env: WorkerRuntimeBindings) =>
    `worker-runtime-fixture orientation. env=${env.ENVIRONMENT ?? 'unset'}`,
  extraEnvBindings: [['CUSTOM_API_KEY', 'CUSTOM_API_KEY']],
  extraObjectBindings: [['CUSTOM_KV', 'CUSTOM_KV_GLOBAL']],
  setup() {
    runtimeGlobal.__WORKER_RUNTIME_PROBE__ = {
      customApiKey: process.env.CUSTOM_API_KEY,
      hasCustomKv: runtimeGlobal.CUSTOM_KV_GLOBAL != null,
      isNode: runtimeCaps.isNode,
      isWorkerLike: runtimeCaps.isWorkerLike,
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
