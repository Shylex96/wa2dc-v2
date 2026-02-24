import assert from 'node:assert/strict';
import test from 'node:test';

import { sentMessages, settings } from '../src/state.js';

test('Las configuraciones por defecto incluyen DownloadDir', () => {
  assert.equal(settings.DownloadDir, './downloads');
});

test('sentMessages comienza vacío', () => {
  assert.deepEqual(Array.from(sentMessages), []);
});

