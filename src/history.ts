import Decimal from 'decimal.js';
import type { ChartPoint, ChartRange, HistoryData } from './types';

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
