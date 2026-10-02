import { describe, expect, it } from 'vitest';
import { createDefaultState } from '../src/core';
import { COOKIE_NAME, decodeState, encodeState, MAX_COOKIE_BYTES } from '../src/storage';
import { fixture } from './fixtures';

describe('cookie persistence', () => {
  it('round trips the full session', () => {
    const state = createDefaultState(fixture);
    state.custom.GBP = { rate: '0.777', editedAt: '2026-09-30T18:00:00.000Z' };
    state.lastChecked = '2026-09-30T19:00:00.000Z';
    state.markup = { enabled: true, percent: '12.50' };
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
    state.markup = { enabled: true, percent: '1000.00000' };
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
    const legacy = JSON.parse(decodeURIComponent(encodeState(state))).slice(0, 6);
    legacy[0] = 1;
    legacy[5] = ['GBP', 'USD', '1Y'];
    const restored = decodeState(encodeURIComponent(JSON.stringify(legacy)));
    expect(restored).toEqual({
      ...state,
      version: 3,
      chart: { base: 'GBP', quotes: ['USD'], range: '1Y', mode: 'rate' },
    });
    expect(restored.markup).toEqual({ enabled: false, percent: '12.5' });
    expect(JSON.parse(decodeURIComponent(encodeState(restored)))[0]).toBe(3);
  });
  it('migrates v2 comparison cookies with all existing state intact and markup disabled', () => {
    const state = createDefaultState(fixture);
    state.amount = '-42.5';
    state.source = 'USD';
    state.custom.GBP = { rate: '0.75', editedAt: '2026-09-30T18:00:00.000Z' };
    state.lastChecked = '2026-09-30T19:00:00.000Z';
    state.chart = { base: 'USD', quotes: ['GBP', 'EUR'], range: '1Y', mode: 'change' };
    const legacy = JSON.parse(decodeURIComponent(encodeState(state))).slice(0, 6);
    legacy[0] = 2;
    const restored = decodeState(encodeURIComponent(JSON.stringify(legacy)));
    expect(restored).toEqual(state);
    expect(restored.markup).toEqual({ enabled: false, percent: '12.5' });
    const updated = JSON.parse(decodeURIComponent(encodeState(restored)));
    expect(updated[0]).toBe(3);
    expect(updated[6]).toEqual([false, '12.5']);
  });
  it('remembers a disabled markup percentage without enabling it on restore', () => {
    const state = createDefaultState(fixture);
    state.markup = { enabled: false, percent: '5.25' };
    expect(decodeState(encodeState(state)).markup).toEqual(state.markup);
  });
  it('rejects malformed v3 markup tuples and invalid percentages even while disabled', () => {
    const original = JSON.parse(decodeURIComponent(encodeState(createDefaultState(fixture))));
    for (const markup of [
      null,
      {},
      [],
      [true],
      [true, '12.5', 'extra'],
      ['true', '12.5'],
      [1, '12.5'],
      [true, 12.5],
      [false, null],
      [false, ''],
      [false, '-1'],
      [false, '1e2'],
      [false, '1000.00001'],
      [true, '0.000000001'],
    ]) {
      expect(() =>
        decodeState(encodeURIComponent(JSON.stringify([...original.slice(0, 6), markup]))),
      ).toThrow();
    }
    expect(() => decodeState(encodeURIComponent(JSON.stringify(original.slice(0, 6))))).toThrow();
    const invalid = createDefaultState(fixture);
    invalid.markup.percent = '';
    expect(() => encodeState(invalid)).toThrow('Invalid saved markup');
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
        decodeState(
          encodeURIComponent(JSON.stringify([...original.slice(0, 5), chart, original[6]])),
        ),
      ).toThrow();
    }
  });
});
