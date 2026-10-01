import { describe, expect, it } from 'vitest';
import { filterRange, pairSeries } from '../src/history';
import { history } from './fixtures';

describe('historical cross rates', () => {
  it('joins observations only on matching dates', () => {
    const base = history('GBP', [
      ['2026-09-28', '0.8'],
      ['2026-09-30', '0.9'],
    ]);
    const quote = history('USD', [
      ['2026-09-28', '1.2'],
      ['2026-09-29', '1.3'],
    ]);
    expect(pairSeries(base, quote)).toEqual([{ date: '2026-09-28', rate: '1.5' }]);
    expect(pairSeries(history('EUR', []), quote)).toHaveLength(2);
    expect(pairSeries(base, history('EUR', []))[0].rate).toBe('1.25');
  });
  it('clamps calendar ranges correctly at a month boundary', () => {
    const points = [
      { date: '2026-02-27', rate: '1' },
      { date: '2026-02-28', rate: '1' },
      { date: '2026-03-31', rate: '1' },
      { date: '2026-04-01', rate: '1' },
    ];
    expect(filterRange(points, '1M', new Date('2026-03-31T12:00:00Z')).map((p) => p.date)).toEqual([
      '2026-02-28',
      '2026-03-31',
    ]);
  });
});
