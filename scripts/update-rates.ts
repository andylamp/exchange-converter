import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHistory, validateLatest, validateProviderRows } from '../src/data-validation';
import type { Currency, HistoryData, LatestData, Quote } from '../src/types';
import fiat from './fiat-currencies.json';

const API = 'https://api.frankfurter.dev/v2';
const ALLOWED = new Set(fiat.codes);
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../public/data', import.meta.url));
type Fetcher = typeof fetch;

export interface UpdateOptions {
  dataDir?: string;
  now?: Date;
  fetcher?: Fetcher;
  check?: boolean;
  log?: (message: string) => void;
}

export function yearStart(today: string): string {
  const [year, month, day] = today.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return new Date(Date.UTC(year - 1, month - 1, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export async function fetchJson(url: string, fetcher: Fetcher = fetch): Promise<unknown> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error(`Provider returned HTTP ${response.status}: ${url}`);
        if (response.status !== 429 && response.status < 500) throw { permanent: error };
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (error && typeof error === 'object' && 'permanent' in error) throw error.permanent;
      failure = error;
      if (attempt < 2) await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
    }
  }
  throw failure;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

export function parseCatalogue(value: unknown): Currency[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('Empty or invalid currency catalogue');
  const entries = new Map<string, Currency>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || typeof row.iso_code !== 'string') {
      throw new Error('Invalid currency catalogue entry');
    }
    if (!ALLOWED.has(row.iso_code)) continue;
    if (
      typeof row.name !== 'string' ||
      row.name.length === 0 ||
      row.name.length > 120 ||
      (row.symbol !== null && row.symbol !== undefined && typeof row.symbol !== 'string')
    ) {
      throw new Error(`Invalid currency metadata: ${row.iso_code}`);
    }
    if (entries.has(row.iso_code)) throw new Error(`Duplicate currency: ${row.iso_code}`);
    entries.set(row.iso_code, {
      code: row.iso_code,
      name: row.name,
      symbol: row.symbol || row.iso_code,
    });
  }
  if (!entries.has('EUR')) throw new Error('Currency catalogue has no EUR');
  return [...entries.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function mergeQuotes(
  previous: Record<string, Quote>,
  incoming: Record<string, Quote>,
): Record<string, Quote> {
  const merged: Record<string, Quote> = {};
  for (const code of [...new Set([...Object.keys(previous), ...Object.keys(incoming)])].sort()) {
    if (!ALLOWED.has(code)) continue;
    const old = previous[code];
    const next = incoming[code];
    // A failed/partial fetch or older observation must never downgrade stored rates.
    merged[code] =
      !next || (old && (old.date > next.date || (old.date === next.date && old.rate === next.rate)))
        ? old
        : next;
  }
  return merged;
}

export function mergeHistory(
  code: string,
  previous: HistoryData | undefined,
  incoming: [string, string][],
  start: string,
  today: string,
  generatedAt: string,
): HistoryData {
  const points = new Map(previous?.points ?? []);
  for (const [date, rate] of incoming) points.set(date, rate);
  const sorted = [...points]
    .filter(([date]) => date >= start && date <= today)
    .sort(([left], [right]) => left.localeCompare(right));
  if (previous && JSON.stringify(sorted) === JSON.stringify(previous.points)) return previous;
  return { schemaVersion: 1, base: 'EUR', quote: code, generatedAt, points: sorted };
}

/** Build and validate the complete replacement before touching the published directory. */
export async function updateRates(
  options: UpdateOptions = {},
): Promise<{ changed: boolean; currencies: number; points: number }> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const today = generatedAt.slice(0, 10);
  const start = yearStart(today);
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? console.log;
  const previousValue = await readJson(join(dataDir, 'latest.json'));
  const previous = previousValue === undefined ? undefined : validateLatest(previousValue);
  const [catalogueValue, latestValue] = await Promise.all([
    fetchJson(`${API}/currencies`, fetcher),
    // The provider's undated latest endpoint can include tomorrow's observations.
    fetchJson(`${API}/rates?base=EUR&date=${today}`, fetcher),
  ]);
  const catalogue = parseCatalogue(catalogueValue);
  const incoming = validateProviderRows(latestValue, generatedAt);
  if (!Object.keys(incoming).some((code) => code !== 'EUR' && ALLOWED.has(code))) {
    throw new Error('Provider returned no supported exchange rates');
  }
  for (const quote of Object.values(incoming)) {
    if (quote.date > today) throw new Error(`Future observation: ${quote.date}`);
  }
  const rates = mergeQuotes(previous?.rates ?? {}, incoming);
  const metadata = new Map(
    (previous?.currencies ?? []).map((currency) => [currency.code, currency]),
  );
  for (const currency of catalogue) metadata.set(currency.code, currency);
  const currencies = [...metadata.values()]
    .filter(({ code }) => ALLOWED.has(code) && rates[code])
    .sort((a, b) => a.code.localeCompare(b.code));
  for (const code of Object.keys(rates)) if (!metadata.has(code)) delete rates[code];
  if (!rates.EUR || rates.EUR.rate !== '1')
    throw new Error('Provider did not return the EUR identity rate');
  let latest: LatestData = { schemaVersion: 1, base: 'EUR', generatedAt, currencies, rates };
  if (
    previous &&
    JSON.stringify(previous.currencies) === JSON.stringify(currencies) &&
    JSON.stringify(previous.rates) === JSON.stringify(rates)
  )
    latest = previous;
  validateLatest(latest);

  const historyUrl = new URL(`${API}/rates`);
  historyUrl.search = new URLSearchParams({
    base: 'EUR',
    quotes: currencies.map(({ code }) => code).join(','),
    from: start,
    to: today,
  }).toString();
  const historyValue = await fetchJson(historyUrl.href, fetcher);
  if (!Array.isArray(historyValue) || historyValue.length === 0)
    throw new Error('Provider returned empty history');
  const byCurrency = new Map<string, Map<string, string>>();
  const permitted = new Set(currencies.map(({ code }) => code));
  for (const row of historyValue) {
    const validated = validateProviderRows([row], generatedAt);
    for (const [code, quote] of Object.entries(validated)) {
      if (quote.date > today) throw new Error(`Future historical observation: ${quote.date}`);
      if (!permitted.has(code) || quote.date < start) continue;
      const points = byCurrency.get(code) ?? new Map<string, string>();
      if (points.has(quote.date) && points.get(quote.date) !== quote.rate) {
        throw new Error(`Conflicting historical observations: ${code} ${quote.date}`);
      }
      points.set(quote.date, quote.rate);
      byCurrency.set(code, points);
    }
  }
  if (![...byCurrency].some(([code, points]) => code !== 'EUR' && points.size > 0)) {
    throw new Error('Provider returned no usable history');
  }
  const histories: HistoryData[] = [];
  let historiesChanged = false;
  for (const { code } of currencies) {
    const stored = await readJson(join(dataDir, 'history', `${code}.json`));
    const oldHistory = stored === undefined ? undefined : validateHistory(stored);
    if (oldHistory && oldHistory.quote !== code)
      throw new Error(`Mismatched history file: ${code}`);
    const history = mergeHistory(
      code,
      oldHistory,
      [...(byCurrency.get(code) ?? [])],
      start,
      today,
      generatedAt,
    );
    validateHistory(history);
    historiesChanged ||= history !== oldHistory;
    histories.push(history);
  }
  const changed = latest !== previous || historiesChanged;
  const points = histories.reduce((sum, history) => sum + history.points.length, 0);
  log(
    `${options.check ? 'Validated' : changed ? 'Updating' : 'Unchanged'}: ${currencies.length} currencies, ${points} historical observations (${start}–${today}).`,
  );
  if (options.check || !changed) return { changed, currencies: currencies.length, points };

  await mkdir(dirname(dataDir), { recursive: true });
  const stage = await mkdtemp(join(dirname(dataDir), '.exchange-data-'));
  const backup = `${stage}-previous`;
  let backedUp = false;
  try {
    await mkdir(join(stage, 'history'));
    await writeFile(join(stage, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
    await Promise.all(
      histories.map((history) =>
        writeFile(join(stage, 'history', `${history.quote}.json`), `${JSON.stringify(history)}\n`),
      ),
    );
    try {
      await rename(dataDir, backup);
      backedUp = true;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw error;
    }
    try {
      await rename(stage, dataDir);
    } catch (error) {
      if (backedUp) await rename(backup, dataDir);
      backedUp = false;
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { changed, currencies: currencies.length, points };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--check');
  if (unknown.length) {
    console.error(`Unknown argument: ${unknown.join(', ')}`);
    process.exitCode = 1;
  } else {
    updateRates({ check: process.argv.includes('--check') }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
