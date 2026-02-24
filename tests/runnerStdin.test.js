import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

test('Runner del monitor protege la entrada estándar para las primeras interacciones', async () => {
  const runnerPath = path.join(ROOT, 'src', 'runner.js');
  const content = await fs.readFile(runnerPath, 'utf8');

  assert.ok(
    /stdio:\s*\[\s*'inherit'\s*,\s*'pipe'\s*,\s*'pipe'\s*]/.test(content),
    'Se espera que el proceso hijo herede la entrada estándar (para que las interacciones de readline funcionen)',
  );

  assert.ok(
    !/stdio:\s*\[\s*'ignore'\s*,\s*'pipe'\s*,\s*'pipe'\s*]/.test(content),
    'La entrada estándar del proceso hijo no debe ignorarse (rompe las primeras interacciones)',
  );
});

