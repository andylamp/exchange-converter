import { describe, expect, it } from 'vitest';
import { createDefaultState } from '../src/core';
import { COOKIE_NAME, decodeState, encodeState, MAX_COOKIE_BYTES } from '../src/storage';
import { fixture } from './fixtures';

describe('cookie persistence', () => {
  it('round trips the full session', () => {
    const state = createDefaultState(fixture);
    state.custom.GBP = { rate: '0.777', editedAt: '2026-09-30T18:00:00.000Z' };
    state.lastChecked = '2026-09-30T19:00:00.000Z';
    expect(decodeState(encodeState(state))).toEqual(state);
  });
  it('fits 12 currencies with full custom/provider state under the encoded limit', () => {
    const state = createDefaultState(fixture);
    state.selected = [
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
    ];
    state.chart.quotes = state.selected.filter((code) => code !== state.chart.base);
    state.amount = '12345678901234567890123456789.12';
    for (const code of state.selected) {
      state.quotes[code] = {
        rate: code === 'EUR' ? '1' : '1.23456789012345',
        date: '2026-09-30',
        fetchedAt: '2026-09-30T17:00:00.000Z',
      };
      if (code !== 'EUR')
        state.custom[code] = { rate: '1.23456789012345', editedAt: '2026-09-30T18:00:00.000Z' };
    }
    const value = encodeState(state);
    expect(new TextEncoder().encode(`${COOKIE_NAME}=${value}`).length).toBeLessThanOrEqual(
      MAX_COOKIE_BYTES,
    );
    expect(decodeState(value)).toEqual(state);
  });
  it('rejects malformed, oversized, unknown-version, and duplicate-currency cookies', () => {
    for (const value of [
      'bad%',
      '[]',
      'x'.repeat(4000),
      encodeURIComponent('[9,[],"GBP","1",null,[]]'),
    ])
      expect(() => decodeState(value)).toThrow();
    const encoded = JSON.parse(decodeURIComponent(encodeState(createDefaultState(fixture))));
    encoded[1][1][0] = 'GBP';
    expect(() => decodeState(encodeURIComponent(JSON.stringify(encoded)))).toThrow();
  });
  it('migrates legacy single-pair cookies without losing saved conversion state', () => {
    const state = createDefaultState(fixture);
    state.amount = '42.5';
    state.custom.GBP = { rate: '0.75', editedAt: '2026-09-30T18:00:00.000Z' };
    state.lastChecked = '2026-09-30T19:00:00.000Z';
    const legacy = JSON.parse(decodeURIComponent(encodeState(state)));
    legacy[0] = 1;
    legacy[5] = ['GBP', 'USD', '1Y'];
    const restored = decodeState(encodeURIComponent(JSON.stringify(legacy)));
    expect(restored).toEqual({
      ...state,
      version: 2,
      chart: { base: 'GBP', quotes: ['USD'], range: '1Y', mode: 'rate' },
    });
    expect(JSON.parse(decodeURIComponent(encodeState(restored)))[0]).toBe(2);
  });
  it('rejects invalid multi-currency selections and unknown view modes', () => {
    const original = JSON.parse(decodeURIComponent(encodeState(createDefaultState(fixture))));
    for (const chart of [
      ['GBP', [], '3M', 'rate'],
      ['GBP', ['GBP'], '3M', 'rate'],
      ['GBP', ['USD', 'USD'], '3M', 'rate'],
      ['GBP', ['JPY'], '3M', 'rate'],
      ['GBP', ['USD'], '3M', 'unknown'],
    ]) {
      expect(() =>
        decodeState(encodeURIComponent(JSON.stringify([...original.slice(0, 5), chart]))),
      ).toThrow();
    }
  });
});
