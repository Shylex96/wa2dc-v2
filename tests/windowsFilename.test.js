import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import utils from '../src/utils.js';

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, idx) => `com${idx + 1}`),
  ...Array.from({ length: 9 }, (_, idx) => `lpt${idx + 1}`),
]);

const assertWindowsSafeFileName = (fileName) => {
  assert.ok(!/[. ]$/.test(fileName), `Se esperaba ningún punto/espacio al final: ${fileName}`);
  const parsed = path.parse(fileName);
  assert.ok(
    !WINDOWS_RESERVED_BASENAMES.has(parsed.name.toLowerCase()),
    `Se esperaba un nombre de archivo no reservado, pero se encontró uno reservado: ${parsed.name}`,
  );
};

test('saneamiento del nombre de archivo de descarga evita nombres reservados de Windows y puntos finales', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa2dc-windows-paths-'));
  try {
    const inputs = [
      'CON',
      'NUL.txt',
      'COM1.log',
      'LPT9',
      'file.',
      'trailing-space ',
      'aux.png',
    ];

    for (const input of inputs) {
      // eslint-disable-next-line no-await-in-loop
      const [absPath, safeName] = await utils.discord.findAvailableName(tempDir, input);
      assert.equal(absPath, path.resolve(tempDir, safeName));
      assertWindowsSafeFileName(safeName);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

