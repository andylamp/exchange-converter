import Decimal from 'decimal.js';
import type {
  ChartMode,
  ChartPoint,
  ChartRange,
  ComparisonSeries,
  HistoryData,
  PreparedComparison,
} from './types';

const ComparisonDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function pairSeries(base: HistoryData, quote: HistoryData): ChartPoint[] {
  if (base.quote === quote.quote) return base.points.map(([date]) => ({ date, rate: '1' }));
  if (base.quote === 'EUR') return quote.points.map(([date, rate]) => ({ date, rate }));
  if (quote.quote === 'EUR')
    return base.points.map(([date, rate]) => ({ date, rate: new Decimal(1).div(rate).toString() }));
  const denominators = new Map(base.points);
  return quote.points.flatMap(([date, rate]) => {
    const denominator = denominators.get(date);
    return denominator ? [{ date, rate: new Decimal(rate).div(denominator).toString() }] : [];
  });
}
export function filterRange(
  points: ChartPoint[],
  range: ChartRange,
  now = new Date(),
): ChartPoint[] {
  const start = new Date(now);
  // Calendar ranges clamp to the last available day in shorter months.
  const months = range === '1M' ? 1 : range === '3M' ? 3 : 12;
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - months);
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, last));
  const earliest = start.toISOString().slice(0, 10);
  const latest = now.toISOString().slice(0, 10);
  return points.filter((point) => point.date >= earliest && point.date <= latest);
}

export function prepareComparison(
  series: ComparisonSeries[],
  range: ChartRange,
  mode: ChartMode,
  now = new Date(),
): PreparedComparison {
  const filtered = series.map(({ code, points }) => ({
    code,
    points: filterRange(points, range, now),
  }));
  const excluded = filtered.filter(({ points }) => points.length === 0).map(({ code }) => code);
  if (mode === 'rate') {
    return {
      series: filtered.map(({ code, points }) => ({
        code,
        points: points.map((point) => ({ ...point, value: point.rate })),
      })),
      baselineDate: null,
      excluded,
    };
  }

  const available = filtered.filter(({ points }) => points.length > 0);
  const sharedDates = new Set(available[0]?.points.map(({ date }) => date) ?? []);
  for (const { points } of available.slice(1)) {
    const dates = new Set(points.map(({ date }) => date));
    for (const date of sharedDates) if (!dates.has(date)) sharedDates.delete(date);
  }
  const baselineDate = [...sharedDates].sort()[0] ?? null;
  if (baselineDate === null) {
    return {
      series: filtered.map(({ code }) => ({ code, points: [] })),
      baselineDate: null,
      excluded,
    };
  }

  return {
    series: filtered.map(({ code, points }) => {
      const baseline = points.find(({ date }) => date === baselineDate);
      return {
        code,
        points: baseline
          ? points
              .filter(({ date }) => date >= baselineDate)
              .map((point) => ({
                ...point,
                value: new ComparisonDecimal(point.rate)
                  .div(baseline.rate)
                  .minus(1)
                  .times(100)
                  .toString(),
              }))
          : [],
      };
    }),
    baselineDate,
    excluded,
  };
}
