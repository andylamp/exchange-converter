import Decimal from 'decimal.js';
import { decimalRate } from './data-validation';
import type { ChartPreferences, LatestData, Quote, SavedState } from './types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const MarkupDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const MAX_CURRENCIES = 12;
export function isValidAmount(text: string): boolean {
  if (text.length > 32 || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,3})?$/i.test(text))
    return false;
  const value = new Decimal(text).abs();
  return value.isFinite() && value.lte('1e30') && (value.isZero() || value.gte('1e-30'));
}
export function isValidMarkupPercent(text: string): boolean {
  if (typeof text !== 'string' || text.length > 10 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))
    return false;
  return new MarkupDecimal(text).lte(1000);
}
export function markupAmount(amount: string, percent: string): string | null {
  if (
    !isValidMarkupPercent(percent) ||
    typeof amount !== 'string' ||
    amount.length > 128 ||
    !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,3})?$/i.test(amount)
  )
    return null;
  const value = new MarkupDecimal(amount);
  const magnitude = value.abs();
  // Valid conversions can reach 1e90. Allow derived amounts without accepting enormous exponents.
  if (!value.isFinite() || magnitude.gt('1e100') || (!value.isZero() && magnitude.lt('1e-100')))
    return null;
  return value.times(new MarkupDecimal(percent).div(100).plus(1)).toString();
}
export function createDefaultState(latest: LatestData): SavedState {
  return {
    version: 3,
    selected: ['GBP', 'EUR', 'USD'],
    source: 'GBP',
    amount: '100',
    quotes: Object.fromEntries(
      ['GBP', 'EUR', 'USD'].filter((c) => latest.rates[c]).map((c) => [c, latest.rates[c]]),
    ),
    custom: {},
    lastChecked: null,
    chart: { base: 'GBP', quotes: ['USD', 'EUR'], range: '3M', mode: 'change' },
    markup: { enabled: false, percent: '12.5' },
  };
}
export function normalizeChart(chart: ChartPreferences, selected: string[]): ChartPreferences {
  const base = selected.includes(chart.base) ? chart.base : selected[0];
  const quotes = [...new Set(chart.quotes)].filter(
    (code) => code !== base && selected.includes(code),
  );
  if (!quotes.length) {
    const fallback = selected.find((code) => code !== base);
    if (fallback) quotes.push(fallback);
  }
  return { ...chart, base, quotes };
}
export function changeChartBase(
  chart: ChartPreferences,
  base: string,
  selected: string[],
): ChartPreferences {
  if (!selected.includes(base) || base === chart.base) return chart;
  return normalizeChart(
    { ...chart, base, quotes: chart.quotes.map((code) => (code === base ? chart.base : code)) },
    selected,
  );
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
  const chart = normalizeChart(saved.chart, selected);
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
  return {
    ...state,
    selected,
    source,
    amount,
    quotes,
    custom,
    chart: normalizeChart(state.chart, selected),
  };
}
