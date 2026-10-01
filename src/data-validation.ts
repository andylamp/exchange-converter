import Decimal from 'decimal.js';
import type { Currency, HistoryData, LatestData, Quote } from './types';

export function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
export function decimalRate(value: unknown): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).length > 64)
    throw new Error('Invalid rate.');
  const rate = new Decimal(value);
  if (!rate.isFinite() || rate.lt('1e-30') || rate.gt('1e30'))
    throw new Error('Rates must be between 1e-30 and 1e30.');
  return rate.toSignificantDigits(15).toString();
}
export function validateQuote(value: unknown): Quote {
  const row = record(value);
  if (
    !isIsoDate(row.date) ||
    row.date > new Date().toISOString().slice(0, 10) ||
    !isTimestamp(row.fetchedAt)
  )
    throw new Error('Invalid quote date.');
  return { rate: decimalRate(row.rate), date: row.date, fetchedAt: row.fetchedAt };
}
export function validateLatest(value: unknown): LatestData {
  const data = record(value);
  if (
    data.schemaVersion !== 1 ||
    data.base !== 'EUR' ||
    !isTimestamp(data.generatedAt) ||
    !Array.isArray(data.currencies) ||
    !data.currencies.length ||
    data.currencies.length > 300
  )
    throw new Error('Unsupported rate dataset.');
  const seen = new Set<string>();
  const currencies: Currency[] = data.currencies.map((entry) => {
    const c = record(entry);
    if (
      typeof c.code !== 'string' ||
      !/^[A-Z]{3}$/.test(c.code) ||
      seen.has(c.code) ||
      typeof c.name !== 'string' ||
      !c.name ||
      c.name.length > 150 ||
      typeof c.symbol !== 'string' ||
      c.symbol.length > 30
    )
      throw new Error('Invalid currency catalogue.');
    seen.add(c.code);
    return { code: c.code, name: c.name, symbol: c.symbol };
  });
  const rates: Record<string, Quote> = {};
  for (const [code, quote] of Object.entries(record(data.rates))) {
    if (!seen.has(code)) throw new Error('A rate is missing its currency metadata.');
    rates[code] = validateQuote(quote);
  }
  if (
    !seen.has('EUR') ||
    !rates.GBP ||
    !rates.USD ||
    currencies.some((c) => c.code !== 'EUR' && !rates[c.code])
  )
    throw new Error('Incomplete default rates.');
  if (rates.EUR && rates.EUR.rate !== '1') throw new Error('EUR must equal one.');
  return { schemaVersion: 1, base: 'EUR', generatedAt: data.generatedAt, currencies, rates };
}
export function validateHistory(value: unknown): HistoryData {
  const data = record(value);
  if (
    data.schemaVersion !== 1 ||
    data.base !== 'EUR' ||
    typeof data.quote !== 'string' ||
    !/^[A-Z]{3}$/.test(data.quote) ||
    !isTimestamp(data.generatedAt) ||
    !Array.isArray(data.points) ||
    data.points.length > 400
  )
    throw new Error('Invalid historical dataset.');
  let previous = '';
  const points: [string, string][] = data.points.map((point) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isIsoDate(point[0]) ||
      point[0] <= previous ||
      point[0] > new Date().toISOString().slice(0, 10)
    )
      throw new Error('Invalid historical observation.');
    previous = point[0];
    return [point[0], decimalRate(point[1])];
  });
  return {
    schemaVersion: 1,
    base: 'EUR',
    quote: data.quote,
    generatedAt: data.generatedAt,
    points,
  };
}
export function validateProviderRows(value: unknown, fetchedAt: string): Record<string, Quote> {
  if (!Array.isArray(value) || value.length > 500 || !isTimestamp(fetchedAt))
    throw new Error('Invalid provider response.');
  const result: Record<string, Quote> = {};
  for (const item of value) {
    const row = record(item);
    if (row.base !== 'EUR' || typeof row.quote !== 'string' || !/^[A-Z]{3}$/.test(row.quote))
      throw new Error('Invalid provider currency.');
    const quote = validateQuote({ rate: row.rate, date: row.date, fetchedAt });
    if (!result[row.quote] || result[row.quote].date < quote.date) result[row.quote] = quote;
  }
  return result;
}
