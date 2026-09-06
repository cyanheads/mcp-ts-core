/** @fileoverview Built-package Workerd fixture sharing the HTTP load tool definitions. */
import { createWorkerHandler } from '../../dist/core/worker.js';
import { loadTools } from './load-tools.js';

export default createWorkerHandler({
  name: 'load-fixture',
  version: '0.0.0-test',
  tools: loadTools,
});
