import type { LatestData, HistoryData } from '../src/types';
export const fixture: LatestData = {
  schemaVersion: 1,
  base: 'EUR',
  generatedAt: '2026-09-30T17:00:00.000Z',
  currencies: [
    { code: 'EUR', name: 'Euro', symbol: '€' },
    { code: 'GBP', name: 'British Pound', symbol: '£' },
    { code: 'USD', name: 'US Dollar', symbol: '$' },
    { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  ],
  rates: Object.fromEntries(
    Object.entries({ EUR: '1', GBP: '0.8', USD: '1.2', JPY: '160' }).map(([code, rate]) => [
      code,
      { rate, date: '2026-09-30', fetchedAt: '2026-09-30T17:00:00.000Z' },
    ]),
  ),
};
export function history(quote: string, points: [string, string][]): HistoryData {
  return { schemaVersion: 1, base: 'EUR', quote, generatedAt: fixture.generatedAt, points };
}
