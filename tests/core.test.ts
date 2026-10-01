import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addCurrency,
  changeChartBase,
  convertAmount,
  createDefaultState,
  effectiveRate,
  formatAmount,
  isValidAmount,
  mergeQuotes,
  reconcileState,
  removeCurrency,
  setCustomRate,
} from '../src/core';
import { fixture } from './fixtures';

afterEach(() => vi.useRealTimers());
describe('currency calculations', () => {
  it('uses the last edited currency without feeding rounded values back', () => {
    const state = createDefaultState(fixture);
    expect(convertAmount('100', 'GBP', 'USD', state)).toBe('150');
    expect(convertAmount('150', 'USD', 'EUR', state)).toBe('125');
    expect(convertAmount('0', 'GBP', 'EUR', state)).toBe('0');
    expect(convertAmount('-0.01', 'GBP', 'USD', state)).toBe('-0.015');
    expect(formatAmount('1.6', 'JPY')).toBe('2');
    expect(formatAmount('1.005', 'USD')).toBe('1.01');
  });
  it('does not interpret incomplete input as zero', () => {
    for (const value of ['', '-', '.', '-.', '1,234', 'NaN', 'Infinity', '1abc'])
      expect(isValidAmount(value)).toBe(false);
    for (const value of ['0', '.5', '-.5', '10.', '0.00001'])
      expect(isValidAmount(value)).toBe(true);
  });
  it('keeps a coherent amount and chart when the active currency is removed', () => {
    const state = removeCurrency(createDefaultState(fixture), 'GBP');
    expect(state.source).toBe('EUR');
    expect(state.amount).toBe('125');
    expect(state.chart).toEqual({ base: 'EUR', quotes: ['USD'], range: '3M', mode: 'change' });
    expect(removeCurrency(state, 'USD')).toBe(state);
  });
  it('keeps very small derived source amounts valid after removing their old currency', () => {
    const original = { ...createDefaultState(fixture), amount: '0.00000001' };
    const state = removeCurrency(original, 'GBP');
    expect(isValidAmount(state.amount)).toBe(true);
    expect(convertAmount(state.amount, state.source, 'USD', state)).toBe('1.5e-8');
  });
  it('uses bundled data when adding currencies and marks a refresh due', () => {
    const state = addCurrency(createDefaultState(fixture), 'JPY', fixture);
    expect(state.selected).toContain('JPY');
    expect(convertAmount('1', 'GBP', 'JPY', state)).toBe('200');
    expect(state.lastChecked).toBeNull();
    expect(addCurrency(state, 'XXX', fixture)).toBe(state);
  });
  it('caps the selected currencies at twelve without duplicating entries', () => {
    const codes = [
      'EUR',
      'GBP',
      'USD',
      'JPY',
      'CHF',
      'AUD',
      'CAD',
      'INR',
      'NOK',
      'SEK',
      'DKK',
      'NZD',
      'CNY',
    ];
    const latest = {
      ...fixture,
      currencies: codes.map((code) => ({ code, name: code, symbol: code })),
      rates: Object.fromEntries(
        codes.map((code) => [code, fixture.rates[code] ?? fixture.rates.USD]),
      ),
    };
    let state = createDefaultState(latest);
    for (const code of codes) state = addCurrency(state, code, latest);
    expect(state.selected).toHaveLength(12);
    expect(new Set(state.selected).size).toBe(12);
    expect(state.selected).not.toContain('CNY');
  });
});
describe('rate reconciliation', () => {
  it('observation dates outrank retrieval times and equal dates admit corrections', () => {
    const state = createDefaultState(fixture);
    const stale = { GBP: { rate: '9', date: '2026-09-29', fetchedAt: '2026-10-01T12:00:00.000Z' } };
    expect(mergeQuotes(state, stale).state.quotes.GBP.rate).toBe('0.8');
    const correction = {
      GBP: { ...state.quotes.GBP, rate: '0.81', fetchedAt: '2026-09-30T18:00:00.000Z' },
    };
    expect(mergeQuotes(state, correction).state.quotes.GBP.rate).toBe('0.81');
    expect(
      mergeQuotes(mergeQuotes(state, correction).state, state.quotes).state.quotes.GBP.rate,
    ).toBe('0.81');
  });
  it('retains same-day custom rates then expires them for a newer observation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
    const state = setCustomRate(createDefaultState(fixture), 'GBP', '0.7');
    expect(effectiveRate(mergeQuotes(state, fixture.rates).state, 'GBP')).toBe('0.7');
    expect(state.quotes.GBP.rate).toBe('0.8');
    const result = mergeQuotes(state, {
      GBP: { rate: '0.9', date: '2026-10-01', fetchedAt: '2026-10-01T10:00:00.000Z' },
    });
    expect(result.replacedCustom).toEqual(['GBP']);
    expect(effectiveRate(result.state, 'GBP')).toBe('0.9');
    expect(result.state.custom.GBP).toBeUndefined();
  });
  it('partial refreshes retain other quotes and cannot edit the EUR anchor', () => {
    const state = createDefaultState(fixture);
    expect(mergeQuotes(state, {}).state.quotes).toEqual(state.quotes);
    expect(() => setCustomRate(state, 'EUR', '2')).toThrow();
    expect(() => setCustomRate(state, 'GBP', '0')).toThrow();
    expect(() => setCustomRate(state, 'GBP', '-2')).toThrow();
  });
  it('reconciles catalogue changes and newer cookie snapshots safely', () => {
    const state = createDefaultState(fixture);
    state.quotes.GBP = { rate: '0.82', date: '2026-10-01', fetchedAt: '2026-10-01T10:00:00.000Z' };
    expect(reconcileState(state, fixture).state.quotes.GBP.rate).toBe('0.82');
  });
});

describe('comparison preferences', () => {
  it('starts with GBP against USD and EUR and labels change mode explicitly', () => {
    expect(createDefaultState(fixture).chart).toEqual({
      base: 'GBP',
      quotes: ['USD', 'EUR'],
      range: '3M',
      mode: 'change',
    });
  });
  it('swaps the old reference into targets when a comparison becomes the reference', () => {
    const state = createDefaultState(fixture);
    const changed = changeChartBase(state.chart, 'EUR', state.selected);
    expect(changed).toEqual({ base: 'EUR', quotes: ['USD', 'GBP'], range: '3M', mode: 'change' });
    expect(changeChartBase(changed, 'GBP', state.selected)).toEqual(state.chart);
  });
  it('keeps chosen targets when the new reference was not compared', () => {
    const state = addCurrency(createDefaultState(fixture), 'JPY', fixture);
    expect(changeChartBase(state.chart, 'JPY', state.selected).quotes).toEqual(['USD', 'EUR']);
    expect(changeChartBase(state.chart, 'XXX', state.selected)).toBe(state.chart);
  });
  it('prunes removed currencies, repairs the reference, and preserves at least one target', () => {
    const state = addCurrency(createDefaultState(fixture), 'JPY', fixture);
    expect(removeCurrency(state, 'USD').chart.quotes).toEqual(['EUR']);
    const filtered = { ...state, chart: { ...state.chart, quotes: ['JPY'] } };
    expect(removeCurrency(filtered, 'JPY').chart.quotes).toEqual(['EUR']);
    const noReference = removeCurrency(state, 'GBP');
    expect(noReference.chart.base).toBe('EUR');
    expect(noReference.chart.quotes).toEqual(['USD']);
  });
  it('repairs comparison preferences after catalogue changes', () => {
    const state = addCurrency(createDefaultState(fixture), 'JPY', fixture);
    state.chart = { base: 'JPY', quotes: ['USD', 'GBP'], range: '1Y', mode: 'rate' };
    const available = {
      ...fixture,
      currencies: fixture.currencies.filter((c) => c.code !== 'JPY'),
    };
    const reconciled = reconcileState(state, available).state;
    expect(reconciled.chart).toEqual({ base: 'GBP', quotes: ['USD'], range: '1Y', mode: 'rate' });
  });
});
