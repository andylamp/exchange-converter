export interface Currency {
  code: string;
  name: string;
  symbol: string;
}
export interface Quote {
  rate: string;
  date: string;
  fetchedAt: string;
}
export interface CustomRate {
  rate: string;
  editedAt: string;
}
export interface LatestData {
  schemaVersion: 1;
  base: 'EUR';
  generatedAt: string;
  currencies: Currency[];
  rates: Record<string, Quote>;
}
export type ChartRange = '1M' | '3M' | '1Y';
export type ChartMode = 'rate' | 'change';
export interface ChartPreferences {
  base: string;
  quotes: string[];
  range: ChartRange;
  mode: ChartMode;
}
export interface SavedState {
  version: 3;
  selected: string[];
  source: string;
  amount: string;
  quotes: Record<string, Quote>;
  custom: Record<string, CustomRate>;
  lastChecked: string | null;
  chart: ChartPreferences;
  markup: { enabled: boolean; percent: string };
}
export interface HistoryData {
  schemaVersion: 1;
  base: 'EUR';
  quote: string;
  generatedAt: string;
  points: [string, string][];
}
export interface ChartPoint {
  date: string;
  rate: string;
}
export interface ComparisonSeries {
  code: string;
  points: ChartPoint[];
}
export interface ComparisonPoint extends ChartPoint {
  value: string;
}
export interface PreparedComparison {
  series: { code: string; points: ComparisonPoint[] }[];
  baselineDate: string | null;
  excluded: string[];
}
