/**
 * @fileoverview Integration-suite build precondition.
 * Fails collection when required package outputs are absent or stale.
 * @module tests/integration/setup
 */

import { assertBuildFresh } from '../helpers/server-process.js';

assertBuildFresh();
