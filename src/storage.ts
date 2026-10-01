import { isValidAmount, MAX_CURRENCIES } from './core';
import { decimalRate, isTimestamp, validateQuote } from './data-validation';
import type { ChartRange, SavedState } from './types';

export const COOKIE_NAME = 'exchange_converter_v1';
export const COOKIE_PATH = '/exchange-converter/';
export const MAX_COOKIE_BYTES = 3500;
const YEAR_SECONDS = 365 * 24 * 60 * 60;

export function encodeState(state: SavedState): string {
  const rows = state.selected.map((code) => {
    const quote = state.quotes[code];
    const custom = state.custom[code];
    return [
      code,
      quote ? [quote.rate, quote.date, Date.parse(quote.fetchedAt)] : null,
      custom ? [custom.rate, Date.parse(custom.editedAt)] : null,
    ];
  });
  const value = encodeURIComponent(
    JSON.stringify([
      1,
      rows,
      state.source,
      state.amount,
      state.lastChecked ? Date.parse(state.lastChecked) : null,
      [state.chart.base, state.chart.quote, state.chart.range],
    ]),
  );
  if (new TextEncoder().encode(`${COOKIE_NAME}=${value}`).length > MAX_COOKIE_BYTES)
    throw new Error('Saved state exceeds the cookie size limit.');
  return value;
}
export function decodeState(value: string): SavedState {
  if (value.length > MAX_COOKIE_BYTES) throw new Error('Saved state is too large.');
  const data: unknown = JSON.parse(decodeURIComponent(value));
  if (
    !Array.isArray(data) ||
    data.length !== 6 ||
    data[0] !== 1 ||
    !Array.isArray(data[1]) ||
    data[1].length < 2 ||
    data[1].length > MAX_CURRENCIES ||
    typeof data[2] !== 'string' ||
    typeof data[3] !== 'string' ||
    !isValidAmount(data[3])
  )
    throw new Error('Invalid saved state.');
  const quotes: SavedState['quotes'] = {};
  const custom: SavedState['custom'] = {};
  const selected: string[] = [];
  for (const row of data[1]) {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      typeof row[0] !== 'string' ||
      !/^[A-Z]{3}$/.test(row[0]) ||
      selected.includes(row[0])
    )
      throw new Error('Invalid saved currency.');
    const code: string = row[0];
    selected.push(code);
    if (row[1] !== null) {
      if (
        !Array.isArray(row[1]) ||
        row[1].length !== 3 ||
        typeof row[1][2] !== 'number' ||
        row[1][2] > Date.now() + 300000
      )
        throw new Error('Invalid saved rate.');
      quotes[code] = validateQuote({
        rate: row[1][0],
        date: row[1][1],
        fetchedAt: new Date(row[1][2]).toISOString(),
      });
      if (code === 'EUR' && quotes[code].rate !== '1') throw new Error('Invalid EUR rate.');
    }
    if (row[2] !== null) {
      if (
        code === 'EUR' ||
        !Array.isArray(row[2]) ||
        row[2].length !== 2 ||
        typeof row[2][1] !== 'number' ||
        row[2][1] > Date.now() + 300000
      )
        throw new Error('Invalid saved custom rate.');
      const editedAt = new Date(row[2][1]).toISOString();
      if (!isTimestamp(editedAt)) throw new Error('Invalid custom rate date.');
      custom[code] = { rate: decimalRate(row[2][0]), editedAt };
    }
  }
  if (!selected.includes(data[2])) throw new Error('Invalid source currency.');
  const c: unknown = data[5];
  if (
    !Array.isArray(c) ||
    c.length !== 3 ||
    !selected.includes(c[0]) ||
    !selected.includes(c[1]) ||
    c[0] === c[1] ||
    !['1M', '3M', '1Y'].includes(c[2])
  )
    throw new Error('Invalid saved chart.');
  let lastChecked: string | null = null;
  if (data[4] !== null) {
    if (typeof data[4] !== 'number' || data[4] > Date.now() + 300000)
      throw new Error('Invalid refresh date.');
    lastChecked = new Date(data[4]).toISOString();
  }
  return {
    version: 1,
    selected,
    source: data[2],
    amount: data[3],
    quotes,
    custom,
    lastChecked,
    chart: { base: c[0], quote: c[1], range: c[2] as ChartRange },
  };
}
export function readSavedState(): { state: SavedState | null; warning: string | null } {
  try {
    const entry = document.cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COOKIE_NAME}=`));
    if (!entry) return { state: null, warning: null };
    return { state: decodeState(entry.slice(COOKIE_NAME.length + 1)), warning: null };
  } catch {
    return {
      state: null,
      warning: 'Your saved preferences could not be read. Using defaults for this session.',
    };
  }
}
export function writeSavedState(state: SavedState): boolean {
  try {
    const value = encodeState(state);
    document.cookie = `${COOKIE_NAME}=${value}; Path=${COOKIE_PATH}; Max-Age=${YEAR_SECONDS}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    return document.cookie.split(';').some((part) => part.trim() === `${COOKIE_NAME}=${value}`);
  } catch {
    return false;
  }
}
export function clearSavedState(): void {
  document.cookie = `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
