import {
  decimalRate,
  isIsoDate,
  record,
  validateHistory,
  validateLatest,
  validateProviderRows,
} from './data-validation';
import type { HistoryData, LatestData, Quote } from './types';

const API = 'https://api.frankfurter.dev/v2';
const BASE = import.meta.env.BASE_URL;
const DAY = 24 * 60 * 60 * 1000;
const histories = new Map<string, { expiresAt: number; data: HistoryData }>();
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(15000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    credentials: 'omit',
    cache: 'no-cache',
  });
  if (!response.ok) throw new Error(`Rate service returned ${response.status}.`);
  return response.json();
}
export async function loadBundledLatest(signal?: AbortSignal): Promise<LatestData> {
  return validateLatest(await getJson(`${BASE}data/latest.json`, signal));
}
export async function fetchLatest(
  codes: string[],
  signal?: AbortSignal,
): Promise<Record<string, Quote>> {
  const quotes = [...new Set(codes)].filter((c) => c !== 'EUR' && /^[A-Z]{3}$/.test(c));
  if (!quotes.length) return {};
  const date = new Date().toISOString().slice(0, 10);
  const data = await getJson(
    `${API}/rates?base=EUR&quotes=${quotes.join(',')}&date=${date}`,
    signal,
  );
  const rates = validateProviderRows(data, new Date().toISOString());
  return Object.fromEntries(Object.entries(rates).filter(([code]) => quotes.includes(code)));
}
export async function loadHistory(code: string, signal?: AbortSignal): Promise<HistoryData> {
  if (!/^[A-Z]{3}$/.test(code)) throw new Error('Unknown currency.');
  signal?.throwIfAborted();
  if (code === 'EUR')
    return {
      schemaVersion: 1,
      base: 'EUR',
      quote: code,
      generatedAt: new Date().toISOString(),
      points: [],
    };
  const cached = histories.get(code);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const lastDay = new Date(
    Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const from = new Date(
    Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), Math.min(now.getUTCDate(), lastDay)),
  )
    .toISOString()
    .slice(0, 10);
  let bundled: HistoryData | undefined;
  try {
    const candidate = validateHistory(await getJson(`${BASE}data/history/${code}.json`, signal));
    if (candidate.quote !== code) throw new Error('Mismatched historical currency.');
    bundled = candidate;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const sources = [cached?.data, bundled]
    .filter((source): source is HistoryData => Boolean(source))
    .sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
  const knownPoints = new Map<string, string>();
  for (const source of sources)
    for (const [day, rate] of source.points) {
      if (day >= from && day <= date) knownPoints.set(day, rate);
    }
  const fallback = sources.length
    ? validateHistory({
        schemaVersion: 1,
        base: 'EUR',
        quote: code,
        generatedAt: sources.at(-1)!.generatedAt,
        points: [...knownPoints].sort(([a], [b]) => a.localeCompare(b)),
      })
    : undefined;
  try {
    const data = await getJson(
      `${API}/rates?base=EUR&quotes=${code}&from=${from}&to=${date}`,
      signal,
    );
    if (!Array.isArray(data) || data.length > 400) throw new Error('Invalid history response.');
    const points = new Map<string, string>();
    for (const raw of data) {
      const row = record(raw);
      if (row.base !== 'EUR' || row.quote !== code || !isIsoDate(row.date) || row.date > date)
        throw new Error('Invalid historical observation.');
      const rate = decimalRate(row.rate);
      if (points.has(row.date) && points.get(row.date) !== rate)
        throw new Error('Conflicting historical observations.');
      points.set(row.date, rate);
    }
    for (const [day, rate] of points) if (day >= from) knownPoints.set(day, rate);
    const history = validateHistory({
      schemaVersion: 1,
      base: 'EUR',
      quote: code,
      generatedAt: now.toISOString(),
      points: [...knownPoints].sort(([a], [b]) => a.localeCompare(b)),
    });
    histories.set(code, { expiresAt: Date.now() + DAY, data: history });
    return history;
  } catch (error) {
    if (signal?.aborted || !fallback) throw error;
    // Keep validated observations, including a newer expired memory snapshot, while allowing a retry soon.
    histories.set(code, { expiresAt: Date.now() + 60_000, data: fallback });
    return fallback;
  }
}
