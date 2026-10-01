import { describe, expect, it } from 'vitest';
import { decimalRate, validateLatest, validateProviderRows } from '../src/data-validation';
import { createDefaultState, isValidAmount } from '../src/core';
import { decodeState, encodeState } from '../src/storage';
import { fixture } from './fixtures';
describe('untrusted numeric data', () => {
  it('rejects extreme rates before they can cause enormous fixed-decimal strings', () => {
    for (const rate of ['1e1000000000', '1e-1000000000', '0', '-1', 'Infinity', 'NaN'])
      expect(() => decimalRate(rate)).toThrow();
    expect(decimalRate('1e-30')).toBe('1e-30');
    expect(decimalRate('1e30')).toBe('1e+30');
    expect(isValidAmount('1e999')).toBe(false);
    expect(isValidAmount('1e-999')).toBe(false);
  });
  it('rejects dangerous saved quotes and future retrieval timestamps', () => {
    const encoded = JSON.parse(decodeURIComponent(encodeState(createDefaultState(fixture))));
    encoded[1][0][1][0] = '1e1000000000';
    expect(() => decodeState(encodeURIComponent(JSON.stringify(encoded)))).toThrow();
    encoded[1][0][1][0] = '0.8';
    encoded[1][0][1][2] = Date.now() + 86400000;
    expect(() => decodeState(encodeURIComponent(JSON.stringify(encoded)))).toThrow();
  });
  it('rejects malformed provider and bundled datasets', () => {
    expect(() => validateLatest({ ...fixture, schemaVersion: 2 })).toThrow();
    expect(() =>
      validateLatest({ ...fixture, currencies: [...fixture.currencies, fixture.currencies[0]] }),
    ).toThrow();
    expect(() =>
      validateProviderRows(
        [{ date: '2026-09-30', base: 'USD', quote: 'GBP', rate: 1 }],
        fixture.generatedAt,
      ),
    ).toThrow();
  });
});
