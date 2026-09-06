/** @fileoverview Node module owners must finish naturally after real database cleanup. */
import { createHook } from 'node:async_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const startup = new Map();
let owner = null;
const hook = createHook({
  init(id, type) {
    if (owner) startup.set(id, { id, type, owner });
  },
  destroy(id) {
    startup.delete(id);
  },
}).enable();
owner = 'node:dns: Node environment';
require('node:dns');
owner = '@duckdb/node-api: Node environment';
const { DuckDBInstance } = require('@duckdb/node-api');
owner = null;
for (let cycle = 0; cycle < 5; cycle++) {
  const db = await DuckDBInstance.create(':memory:');
  try {
    const connection = await db.connect();
    try {
      const reader = await connection.runAndReadAll('SELECT 42 AS answer');
      if (reader.getRowObjects()[0].answer !== 42) throw new Error('Native query failed');
    } finally {
      connection.closeSync();
    }
  } finally {
    db.closeSync();
  }
}
hook.disable();
const inventory = [...startup.values()];
if (
  inventory.length !== 2 ||
  inventory[0].type !== 'DNSCHANNEL' ||
  inventory[1].type !== 'DuckDBNapiRefReaper'
) {
  throw new Error(`Unclassified module startup inventory: ${JSON.stringify(inventory)}`);
}
console.log(JSON.stringify({ runtime: process.version, cycles: 5, startup: inventory }));
// No process.exit(): the parent requires natural napi_env teardown within its deadline.
