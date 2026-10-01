import { describe, expect, it } from 'vitest';
import { filterRange, pairSeries, prepareComparison } from '../src/history';
import type { ComparisonSeries } from '../src/types';
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

const NOW = new Date('2026-10-01T12:00:00Z');
const series = (code: string, observations: [string, string][]): ComparisonSeries => ({
  code,
  points: observations.map(([date, rate]) => ({ date, rate })),
});

describe('multiple historical comparisons', () => {
  it('normalizes USD, EUR, and JPY against one shared date while retaining raw rates', () => {
    const input = [
      series('USD', [
        ['2026-08-31', '0.9'],
        ['2026-09-01', '1'],
        ['2026-09-30', '1.1'],
      ]),
      series('EUR', [
        ['2026-09-01', '0.8'],
        ['2026-09-30', '0.72'],
      ]),
      series('JPY', [
        ['2026-08-31', '90'],
        ['2026-09-01', '100'],
        ['2026-09-30', '120'],
      ]),
    ];
    const original = structuredClone(input);
    const result = prepareComparison(input, '3M', 'change', NOW);
    expect(result.baselineDate).toBe('2026-09-01');
    expect(result.excluded).toEqual([]);
    expect(result.series.map(({ points }) => points[0])).toEqual([
      { date: '2026-09-01', rate: '1', value: '0' },
      { date: '2026-09-01', rate: '0.8', value: '0' },
      { date: '2026-09-01', rate: '100', value: '0' },
    ]);
    expect(result.series.map(({ points }) => points.at(-1)?.value)).toEqual(['10', '-10', '20']);
    expect(result.series.map(({ points }) => points.at(-1)?.rate)).toEqual(['1.1', '0.72', '120']);
    expect(input).toEqual(original);
  });

  it('preserves original rates in raw mode without requiring overlapping dates', () => {
    const result = prepareComparison(
      [
        series('USD', [['2026-09-01', '1.1']]),
        series('JPY', [['2026-09-02', '150']]),
        series('EUR', []),
      ],
      '1M',
      'rate',
      NOW,
    );
    expect(result).toEqual({
      series: [
        { code: 'USD', points: [{ date: '2026-09-01', rate: '1.1', value: '1.1' }] },
        { code: 'JPY', points: [{ date: '2026-09-02', rate: '150', value: '150' }] },
        { code: 'EUR', points: [] },
      ],
      baselineDate: null,
      excluded: ['EUR'],
    });
  });

  it('excludes unavailable series from baseline selection and anchors one available series at its first date', () => {
    const result = prepareComparison(
      [
        series('USD', []),
        series('EUR', [['2026-08-31', '0.9']]),
        series('JPY', [
          ['2026-09-03', '100'],
          ['2026-09-30', '125'],
        ]),
      ],
      '1M',
      'change',
      NOW,
    );
    expect(result.baselineDate).toBe('2026-09-03');
    expect(result.excluded).toEqual(['USD', 'EUR']);
    expect(result.series.map(({ points }) => points.map(({ value }) => value))).toEqual([
      [],
      [],
      ['0', '25'],
    ]);
  });

  it('does not misleadingly normalize nonoverlapping series from different baseline dates', () => {
    const result = prepareComparison(
      [
        series('USD', [
          ['2026-09-01', '1'],
          ['2026-09-03', '1.1'],
        ]),
        series('EUR', [
          ['2026-09-02', '0.8'],
          ['2026-09-04', '0.9'],
        ]),
        series('JPY', []),
      ],
      '1M',
      'change',
      NOW,
    );
    expect(result).toEqual({
      series: [
        { code: 'USD', points: [] },
        { code: 'EUR', points: [] },
        { code: 'JPY', points: [] },
      ],
      baselineDate: null,
      excluded: ['JPY'],
    });
  });

  it('requires a date common to every available series, not only overlapping pairs', () => {
    const result = prepareComparison(
      [
        series('USD', [
          ['2026-09-01', '1'],
          ['2026-09-02', '1.1'],
        ]),
        series('EUR', [
          ['2026-09-02', '0.8'],
          ['2026-09-03', '0.9'],
        ]),
        series('JPY', [
          ['2026-09-01', '100'],
          ['2026-09-03', '110'],
        ]),
      ],
      '1M',
      'change',
      NOW,
    );
    expect(result.baselineDate).toBeNull();
    expect(result.excluded).toEqual([]);
    expect(result.series.every(({ points }) => points.length === 0)).toBe(true);
  });

  it('recomputes the baseline when the selected date range changes', () => {
    const input = [
      series('USD', [
        ['2026-08-01', '1'],
        ['2026-09-02', '1.1'],
        ['2026-09-30', '1.21'],
      ]),
      series('EUR', [
        ['2026-08-01', '0.5'],
        ['2026-09-02', '0.8'],
        ['2026-09-30', '0.88'],
      ]),
    ];
    const long = prepareComparison(input, '3M', 'change', NOW);
    const short = prepareComparison(input, '1M', 'change', NOW);
    expect(long.baselineDate).toBe('2026-08-01');
    expect(long.series.map(({ points }) => points.at(-1)?.value)).toEqual(['21', '76']);
    expect(short.baselineDate).toBe('2026-09-02');
    expect(short.series.map(({ points }) => points.at(-1)?.value)).toEqual(['10', '10']);
  });

  it('retains each series genuine observations after the baseline without filling its gaps', () => {
    const result = prepareComparison(
      [
        series('USD', [
          ['2026-09-01', '1'],
          ['2026-09-03', '1.1'],
        ]),
        series('EUR', [
          ['2026-09-01', '0.8'],
          ['2026-09-02', '0.88'],
          ['2026-09-04', '0.72'],
        ]),
      ],
      '1M',
      'change',
      NOW,
    );
    expect(result.series.map(({ points }) => points.map(({ date }) => date))).toEqual([
      ['2026-09-01', '2026-09-03'],
      ['2026-09-01', '2026-09-02', '2026-09-04'],
    ]);
    expect(result.series[1].points.map(({ value }) => value)).toEqual(['0', '10', '-10']);
  });

  it('handles no series and empty ranges without inventing a baseline', () => {
    expect(prepareComparison([], '1Y', 'change', NOW)).toEqual({
      series: [],
      baselineDate: null,
      excluded: [],
    });
    const result = prepareComparison(
      [series('USD', [['2025-09-30', '1']]), series('EUR', [['2026-10-02', '0.8']])],
      '1Y',
      'change',
      NOW,
    );
    expect(result).toEqual({
      series: [
        { code: 'USD', points: [] },
        { code: 'EUR', points: [] },
      ],
      baselineDate: null,
      excluded: ['USD', 'EUR'],
    });
  });
});
