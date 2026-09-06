/**
 * @fileoverview Run a command on the real Node binary, bypassing Bun's `node` PATH shim.
 * @module scripts/with-node
 *
 * @example
 * // bun run scripts/with-node.ts ./node_modules/vitest/vitest.mjs run --config tests/config/vitest.worker.ts
 */
import { spawnSync } from 'node:child_process';
import { findNode } from '../tests/leaks/harness/process.js';

const args = process.argv.slice(2);
if (args.length === 0) throw new Error('Usage: with-node.ts <arguments for the real Node binary>');
const { status, signal } = spawnSync(findNode(), args, { stdio: 'inherit' });
process.exit(signal ? 1 : (status ?? 1));
