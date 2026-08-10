/**
 * @fileoverview Node/Bun storage-provider compliance instantiations.
 * @module tests/compliance/storage-provider.test
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileSystemProvider } from '@/storage/providers/fileSystem/fileSystemProvider.js';
import { InMemoryProvider } from '@/storage/providers/inMemory/inMemoryProvider.js';

import { storageProviderTests } from './storage-provider.js';

storageProviderTests({
  create: () => new InMemoryProvider(),
  name: 'in-memory',
});

let fileSystemPath = '';
storageProviderTests({
  capabilities: {
    rejectsUnserializableValues: true,
  },
  async setup() {
    fileSystemPath = await mkdtemp(join(tmpdir(), 'mcp-ts-core-storage-compliance-'));
  },
  create: () => new FileSystemProvider(fileSystemPath),
  name: 'filesystem',
  async teardown() {
    await rm(fileSystemPath, { force: true, recursive: true });
  },
});
