import Decimal from 'decimal.js';
import { decimalRate } from './data-validation';
import type { LatestData, Quote, SavedState } from './types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const MAX_CURRENCIES = 12;
export function isValidAmount(text: string): boolean {
  if (text.length > 32 || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,3})?$/i.test(text))
    return false;
  const value = new Decimal(text).abs();
  return value.isFinite() && value.lte('1e30') && (value.isZero() || value.gte('1e-30'));
}
export function createDefaultState(latest: LatestData): SavedState {
  return {
    version: 1,
    selected: ['GBP', 'EUR', 'USD'],
    source: 'GBP',
    amount: '100',
    quotes: Object.fromEntries(
      ['GBP', 'EUR', 'USD'].filter((c) => latest.rates[c]).map((c) => [c, latest.rates[c]]),
    ),
    custom: {},
    lastChecked: null,
    chart: { base: 'GBP', quote: 'USD', range: '3M' },
  };
}
export function mergeQuotes(
  state: SavedState,
  incoming: Record<string, Quote>,
  checkedAt?: string,
): { state: SavedState; replacedCustom: string[] } {
  const quotes = { ...state.quotes };
  const custom = { ...state.custom };
  const replacedCustom: string[] = [];
  for (const code of state.selected) {
    const candidate = incoming[code];
    const previous = quotes[code];
    if (
      candidate &&
      (!previous ||
        candidate.date > previous.date ||
        (candidate.date === previous.date && candidate.fetchedAt > previous.fetchedAt))
    )
      quotes[code] = candidate;
    if (custom[code] && quotes[code] && quotes[code].date > custom[code].editedAt.slice(0, 10)) {
      delete custom[code];
      replacedCustom.push(code);
    }
  }
  return {
    state: { ...state, quotes, custom, lastChecked: checkedAt ?? state.lastChecked },
    replacedCustom,
  };
}
export function reconcileState(
  saved: SavedState,
  latest: LatestData,
): { state: SavedState; replacedCustom: string[] } {
  const available = new Set(latest.currencies.map((c) => c.code));
  const selected = saved.selected.filter((c) => available.has(c)).slice(0, MAX_CURRENCIES);
  if (selected.length < 2) return { state: createDefaultState(latest), replacedCustom: [] };
  const source = selected.includes(saved.source) ? saved.source : selected[0];
  const amount =
    source === saved.source
      ? saved.amount
      : new Decimal(convertAmount(saved.amount, saved.source, source, saved) ?? '100')
          .toSignificantDigits(15)
          .toString();
  const chart = {
    ...saved.chart,
    base: selected.includes(saved.chart.base) ? saved.chart.base : selected[0],
    quote: selected.includes(saved.chart.quote) ? saved.chart.quote : selected[1],
  };
  if (chart.base === chart.quote) chart.quote = selected.find((c) => c !== chart.base)!;
  const quotes = Object.fromEntries(
    selected.filter((c) => saved.quotes[c]).map((c) => [c, saved.quotes[c]]),
  );
  const custom = Object.fromEntries(
    selected.filter((c) => saved.custom[c]).map((c) => [c, saved.custom[c]]),
  );
  return mergeQuotes({ ...saved, selected, source, amount, chart, quotes, custom }, latest.rates);
}
export function effectiveRate(state: SavedState, code: string): string | null {
  if (code === 'EUR') return '1';
  const custom = state.custom[code];
  const provider = state.quotes[code];
  if (custom && (!provider || provider.date <= custom.editedAt.slice(0, 10))) return custom.rate;
  return provider?.rate ?? null;
}
export function convertAmount(
  amount: string,
  from: string,
  to: string,
  state: SavedState,
): string | null {
  if (!isValidAmount(amount)) return null;
  const source = effectiveRate(state, from);
  const target = effectiveRate(state, to);
  if (!source || !target) return null;
  return new Decimal(amount).times(target).div(source).toString();
}
export function formatAmount(value: string, code: string): string {
  const digits =
    new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return new Decimal(value).toFixed(digits);
}
export function setCustomRate(state: SavedState, code: string, rate: string): SavedState {
  if (!state.selected.includes(code) || code === 'EUR')
    throw new Error('Choose a selected currency other than EUR.');
  return {
    ...state,
    custom: {
      ...state.custom,
      [code]: { rate: decimalRate(rate), editedAt: new Date().toISOString() },
    },
  };
}
export function addCurrency(state: SavedState, code: string, latest: LatestData): SavedState {
  if (
    state.selected.includes(code) ||
    state.selected.length >= MAX_CURRENCIES ||
    !latest.currencies.some((c) => c.code === code)
  )
    return state;
  return {
    ...state,
    selected: [...state.selected, code],
    quotes: latest.rates[code] ? { ...state.quotes, [code]: latest.rates[code] } : state.quotes,
    lastChecked: null,
  };
}
export function removeCurrency(state: SavedState, code: string): SavedState {
  if (state.selected.length <= 2 || !state.selected.includes(code)) return state;
  const selected = state.selected.filter((c) => c !== code);
  const source = state.source === code ? selected[0] : state.source;
  const amount =
    state.source === code
      ? new Decimal(convertAmount(state.amount, state.source, source, state) ?? '100')
          .toSignificantDigits(15)
          .toString()
      : state.amount;
  const quotes = { ...state.quotes };
  delete quotes[code];
  const custom = { ...state.custom };
  delete custom[code];
  const base = state.chart.base === code ? selected[0] : state.chart.base;
  const quote =
    state.chart.quote === code || state.chart.quote === base
      ? selected.find((c) => c !== base)!
      : state.chart.quote;
  return {
    ...state,
    selected,
    source,
    amount,
    quotes,
    custom,
    chart: { ...state.chart, base, quote },
  };
}
