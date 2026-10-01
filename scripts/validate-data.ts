import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHistory, validateLatest } from '../src/data-validation';
import fiat from './fiat-currencies.json';

export async function validateData(
  dataDir = fileURLToPath(new URL('../public/data', import.meta.url)),
): Promise<void> {
  const allowed = new Set(fiat.codes);
  const latest = validateLatest(JSON.parse(await readFile(join(dataDir, 'latest.json'), 'utf8')));
  const today = new Date().toISOString().slice(0, 10);
  const currencies = new Set(latest.currencies.map(({ code }) => code));
  for (const code of currencies) {
    if (!allowed.has(code)) throw new Error(`Currency is not approved fiat: ${code}`);
    if (latest.rates[code].date > today) throw new Error(`Future rate: ${code}`);
    const history = validateHistory(
      JSON.parse(await readFile(join(dataDir, 'history', `${code}.json`), 'utf8')),
    );
    if (history.quote !== code) throw new Error(`Mismatched history file: ${code}`);
    if (history.points.some(([date]) => date > today))
      throw new Error(`Future historical rate: ${code}`);
  }
  for (const file of await readdir(join(dataDir, 'history'))) {
    if (!file.endsWith('.json') || !currencies.has(file.slice(0, -5)))
      throw new Error(`Unexpected history file: ${file}`);
  }
  console.log(`Validated bundled rates and history for ${currencies.size} fiat currencies.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateData().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
