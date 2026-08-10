/** @fileoverview Exact source-barrel runtime export contract. */

import { describe, expect, it } from 'vitest';
import * as Config from '@/config/index.js';
import * as Core from '@/core/index.js';
import * as Worker from '@/core/worker.js';
import * as Linter from '@/linter/index.js';
import * as Prompts from '@/mcp-server/prompts/utils/promptDefinition.js';
import * as Resources from '@/mcp-server/resources/utils/resourceDefinition.js';
import * as Tasks from '@/mcp-server/tasks/utils/taskToolDefinition.js';
import * as Tools from '@/mcp-server/tools/utils/toolDefinition.js';
import * as Auth from '@/mcp-server/transports/auth/lib/checkScopes.js';
import * as Canvas from '@/services/canvas/index.js';
import * as Services from '@/services/index.js';
import * as Mirror from '@/services/mirror/index.js';
import * as StorageTypes from '@/storage/core/IStorageProvider.js';
import * as Storage from '@/storage/core/StorageService.js';
import * as TestingFuzz from '@/testing/fuzz.js';
import * as Testing from '@/testing/index.js';
import * as TestingVitest from '@/testing/vitest.js';
import * as Errors from '@/types-global/errors.js';
import * as Utils from '@/utils/index.js';
import { PUBLIC_RUNTIME_EXPORTS } from '../../scripts/public-api-contract.js';

const SOURCE_MODULES = {
  '.': Core,
  './worker': Worker,
  './tools': Tools,
  './resources': Resources,
  './prompts': Prompts,
  './tasks': Tasks,
  './errors': Errors,
  './config': Config,
  './auth': Auth,
  './storage': Storage,
  './storage/types': StorageTypes,
  './canvas': Canvas,
  './mirror': Mirror,
  './utils': Utils,
  './services': Services,
  './linter': Linter,
  './testing': Testing,
  './testing/fuzz': TestingFuzz,
  './testing/vitest': TestingVitest,
} satisfies Record<keyof typeof PUBLIC_RUNTIME_EXPORTS, object>;

describe('public source barrel contract', () => {
  for (const [subpath, expected] of Object.entries(PUBLIC_RUNTIME_EXPORTS)) {
    it(`${subpath} exposes exactly its intentional runtime names`, () => {
      const actual = Object.keys(SOURCE_MODULES[subpath as keyof typeof SOURCE_MODULES]).sort();
      expect(
        actual,
        `${subpath} runtime exports no longer match the manifest in scripts/public-api-contract.ts. If the barrel change is intentional, regenerate it with \`bun run scripts/public-api-contract-update.ts\`.`,
      ).toEqual([...expected].sort());
    });
  }
});
