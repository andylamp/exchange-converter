import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const directory = new URL('../dist/', import.meta.url);
const budget = 75 * 1024;

async function listAssets(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const target = join(path, entry.name);
      if (entry.isDirectory()) return listAssets(target);
      return entry.isFile() && /\.(?:js|css)$/.test(entry.name) ? [target] : [];
    }),
  );
  return groups.flat();
}

try {
  const { fileURLToPath } = await import('node:url');
  const assets = await listAssets(fileURLToPath(directory));
  if (assets.length === 0) throw new Error('No built JS/CSS found; run npm run build first');
  const sizes = await Promise.all(
    assets.map(async (path) => gzipSync(await readFile(path), { level: 9 }).byteLength),
  );
  const total = sizes.reduce((sum, size) => sum + size, 0);
  console.log(
    `App JS + CSS: ${(total / 1024).toFixed(2)} KiB gzip across ${assets.length} files (budget: ${budget / 1024} KiB)`,
  );
  if (total > budget)
    throw new Error(`App bundle exceeds its gzip budget by ${total - budget} bytes`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
