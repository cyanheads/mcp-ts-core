/** @fileoverview Built-package HTTP fixture used only by local performance tests. */
import { createApp } from '../../dist/core/index.js';
import { loadTools } from './load-tools.js';

await createApp({ name: 'load-fixture', version: '0.0.0-test', tools: loadTools });
