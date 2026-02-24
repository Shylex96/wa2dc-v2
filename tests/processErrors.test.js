import assert from 'node:assert/strict';
import test from 'node:test';

import { isRecoverableUnhandledRejection } from '../src/processErrors.js';

test('clasifica cierres de sockets terminados de undici como recuperables', () => {
  const socketError = new Error('other side closed');
  socketError.code = 'UND_ERR_SOCKET';

  const reason = new TypeError('terminated');
  reason.cause = socketError;
  reason.stack = 'TypeError: terminated\n    at Fetch.onAborted (node:internal/deps/undici/undici:12707:53)';

  assert.equal(isRecoverableUnhandledRejection(reason), true);
});

test('clasifica fallas de fetch TLS de undici como recuperables', () => {
  const tlsError = new Error('tlsv1 alert internal error');
  tlsError.code = 'ECONNRESET';

  const reason = new TypeError('fetch failed');
  reason.cause = tlsError;
  reason.stack = 'TypeError: fetch failed\n    at node:internal/deps/undici/undici:16416:13';

  assert.equal(isRecoverableUnhandledRejection(reason), true);
});

test('clasifica errores de codificación generales como no recuperables', () => {
  const reason = new TypeError("Cannot read properties of undefined (reading 'x')");
  reason.stack = 'TypeError: Cannot read properties of undefined (reading \'x\')\n    at file:///app/src/handler.js:10:5';

  assert.equal(isRecoverableUnhandledRejection(reason), false);
});

