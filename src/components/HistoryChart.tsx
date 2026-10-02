import { Fragment } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type {
  ChartMode,
  ChartRange,
  ComparisonPoint,
  ComparisonSeries,
  Currency,
  PreparedComparison,
  SavedState,
} from '../types';
import { loadHistory } from '../api';
import { changeChartBase } from '../core';
import { filterRange, pairSeries, prepareComparison } from '../history';
import { Icon } from './Icons';

const chartNumber = (value: number) =>
  new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 6 }).format(value);
const percentNumber = (value: string) =>
  `${Number(value) > 0 ? '+' : ''}${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(Number(value))}%`;
const axisNumber = (value: number) =>
  value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e7)
    ? value.toExponential(1)
    : new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 4 }).format(value);
const fullDate = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const DASHES = [
  '',
  '8 4',
  '2 4',
  '10 3 2 3',
  '12 5',
  '4 3',
  '14 3 3 3',
  '1 5',
  '7 3 1 3',
  '3 3 9 3',
  '12 3 2 3 2 3',
];
const seriesColor = (index: number) => `var(--series-${index + 1})`;

function SeriesMark({ index }: { index: number }) {
  return (
    <svg class="series-mark" viewBox="0 0 32 12" aria-hidden="true">
      <path
        d="M1 6h30"
        stroke={seriesColor(index)}
        stroke-width="2.5"
        stroke-dasharray={DASHES[index]}
        stroke-linecap="round"
      />
    </svg>
  );
}

function Plot({
  series,
  codes,
  base,
  mode,
}: {
  series: PreparedComparison['series'];
  codes: string[];
  base: string;
  mode: ChartMode;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(900);
  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setPlotWidth(Math.max(280, entries[0].contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const dates = useMemo(
    () => [...new Set(series.flatMap((item) => item.points.map((point) => point.date)))].sort(),
    [series],
  );
  const byCode = useMemo(
    () =>
      new Map(
        series.map((item) => [item.code, new Map(item.points.map((point) => [point.date, point]))]),
      ),
    [series],
  );
  const numbers = series.flatMap((item) => item.points.map((point) => Number(point.value)));
  const low = Math.min(...numbers),
    high = Math.max(...numbers);
  const spread = high - low || Math.abs(high) * 0.02 || 0.02;
  const min = mode === 'rate' ? Math.max(0, low - spread * 0.18) : low - spread * 0.18,
    max = high + spread * 0.18;
  const left = plotWidth < 500 ? 58 : 72,
    top = 20,
    width = plotWidth - left - 20,
    height = 205;
  const start = Date.parse(dates[0]),
    end = Date.parse(dates.at(-1)!);
  const x = (date: string) =>
    left + (start === end ? width / 2 : ((Date.parse(date) - start) / (end - start)) * width);
  const y = (value: number) => top + height - ((value - min) / (max - min)) * height;
  const activeIndex = hover === null ? dates.length - 1 : Math.min(hover, dates.length - 1);
  const activeDate = dates[activeIndex];
  const ticks = [0, 1, 2, 3, 4].map((index) => min + ((max - min) * index) / 4);
  const tooltipLeft = Math.max(8, Math.min(x(activeDate) + 14, plotWidth - 250));
  return (
    <div class="plot-wrap comparison-plot" ref={plotRef}>
      <svg
        class="history-plot"
        data-testid="comparison-chart"
        viewBox={`0 0 ${plotWidth} 273`}
        role="img"
        tabIndex={0}
        aria-labelledby={`${id}-title ${id}-desc`}
        onFocus={() => setHover(dates.length - 1)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const position = (((event.clientX - rect.left) / rect.width) * plotWidth - left) / width;
          const target = start + Math.max(0, Math.min(1, position)) * (end - start);
          let nearest = 0;
          dates.forEach((date, index) => {
            if (Math.abs(Date.parse(date) - target) < Math.abs(Date.parse(dates[nearest]) - target))
              nearest = index;
          });
          setHover(nearest);
        }}
        onKeyDown={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) {
            event.preventDefault();
            if (event.key === 'Escape') setHover(null);
            else if (event.key === 'Home') setHover(0);
            else if (event.key === 'End') setHover(dates.length - 1);
            else
              setHover(
                Math.max(
                  0,
                  Math.min(dates.length - 1, activeIndex + (event.key === 'ArrowLeft' ? -1 : 1)),
                ),
              );
          }
        }}
      >
        <title id={`${id}-title`}>
          {mode === 'change' ? 'Percentage change in' : 'Historical'} exchange rates relative to{' '}
          {base}
        </title>
        <desc id={`${id}-desc`}>
          {codes.join(', ')} compared with {base}, from {fullDate(dates[0])} to{' '}
          {fullDate(dates.at(-1)!)}. Each currency has a different color and line pattern. Gaps
          longer than four days break the lines. Use left and right arrow keys to inspect dates, or
          open the data table below. Missing observations are not carried forward.
        </desc>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={left} x2={left + width} y1={y(value)} y2={y(value)} class="chart-grid" />
            <text x={left - 10} y={y(value) + 4} text-anchor="end" class="chart-label">
              {axisNumber(value)}
              {mode === 'change' ? '%' : ''}
            </text>
          </g>
        ))}
        {mode === 'change' && min <= 0 && max >= 0 && (
          <line
            x1={left}
            x2={left + width}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--muted)"
            stroke-opacity=".45"
            stroke-width="1"
          />
        )}
        {series.map((item) => {
          const index = codes.indexOf(item.code);
          const segments: ComparisonPoint[][] = [];
          item.points.forEach((point, pointIndex) => {
            if (
              pointIndex === 0 ||
              Date.parse(point.date) - Date.parse(item.points[pointIndex - 1].date) >
                4 * 24 * 60 * 60 * 1000
            )
              segments.push([]);
            segments.at(-1)!.push(point);
          });
          const line = segments
            .map((segment) =>
              segment
                .map(
                  (point, offset) =>
                    `${offset ? 'L' : 'M'}${x(point.date).toFixed(2)},${y(Number(point.value)).toFixed(2)}`,
                )
                .join(' '),
            )
            .join(' ');
          const active = byCode.get(item.code)?.get(activeDate);
          return (
            <g key={item.code}>
              {item.points.length > 0 && (
                <path
                  data-series={item.code}
                  d={line}
                  fill="none"
                  stroke={seriesColor(index)}
                  stroke-width="2.4"
                  stroke-dasharray={DASHES[index]}
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              )}
              {segments
                .filter((segment) => segment.length === 1)
                .map((segment) => (
                  <circle
                    key={segment[0].date}
                    cx={x(segment[0].date)}
                    cy={y(Number(segment[0].value))}
                    r="3"
                    fill={seriesColor(index)}
                  />
                ))}
              {active && (
                <circle
                  cx={x(activeDate)}
                  cy={y(Number(active.value))}
                  r="4.5"
                  fill={seriesColor(index)}
                  stroke="var(--surface)"
                  stroke-width="2"
                />
              )}
            </g>
          );
        })}
        {[0, Math.floor((dates.length - 1) / 2), dates.length - 1]
          .filter((index, position, all) => all.indexOf(index) === position)
          .map((index) => (
            <text
              key={index}
              x={x(dates[index])}
              y="256"
              text-anchor={index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle'}
              class="chart-label"
            >
              {new Date(`${dates[index]}T12:00:00Z`).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                timeZone: 'UTC',
              })}
            </text>
          ))}
        {hover !== null && (
          <line
            x1={x(activeDate)}
            x2={x(activeDate)}
            y1={top}
            y2={top + height}
            stroke="var(--muted)"
            stroke-dasharray="3 5"
            stroke-opacity=".5"
          />
        )}
      </svg>
      {hover !== null && (
        <div class="comparison-tooltip" role="tooltip" style={{ left: `${tooltipLeft}px` }}>
          <strong>{fullDate(activeDate)}</strong>
          <span class="tooltip-unit">Units per 1 {base}</span>
          {codes.map((code, index) => {
            const point = byCode.get(code)?.get(activeDate);
            return (
              <div key={code}>
                <SeriesMark index={index} />
                <span>{code}</span>
                <span>
                  {point ? chartNumber(Number(point.rate)) : '—'}
                  {point && mode === 'change' && <small> ({percentNumber(point.value)})</small>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div class="comparison-readout sr-only" aria-live="polite">
        {hover !== null && (
          <>
            <p>
              {fullDate(activeDate)} · Units per 1 {base}
            </p>
            <ul>
              {codes.map((code, index) => {
                const point = byCode.get(code)?.get(activeDate);
                return (
                  <li key={code}>
                    <SeriesMark index={index} />
                    <strong>{code}</strong>
                    <span>
                      {point ? chartNumber(Number(point.rate)) : '—'}
                      {point && mode === 'change' && (
                        <span class="muted"> ({percentNumber(point.value)})</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export function HistoryChart({
  state,
  currencies,
  onChange,
}: {
  state: SavedState;
  currencies: Currency[];
  onChange: (chart: SavedState['chart']) => void;
}) {
  const [allSeries, setAllSeries] = useState<ComparisonSeries[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [loadedKey, setLoadedKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { base, quotes, range, mode } = state.chart;
  const quotesKey = quotes.join(',');
  const requestKey = `${base}|${quotesKey}`;
  const isLoading = loading || loadedKey !== requestKey;
  const visibleSeries = useMemo(
    () => (loadedKey === requestKey ? allSeries : []),
    [allSeries, loadedKey, requestKey],
  );
  useEffect(() => {
    const controller = new AbortController();
    const targets = quotesKey.split(',');
    const codes = [...new Set([base, ...targets])];
    setLoading(true);
    setError('');
    setFailed([]);
    setAllSeries([]);
    Promise.allSettled(codes.map((code) => loadHistory(code, controller.signal)))
      .then((results) => {
        if (controller.signal.aborted) return;
        const baseResult = results[codes.indexOf(base)];
        if (baseResult.status === 'rejected') {
          setError(
            `Historical rates for reference currency ${base} could not be loaded. Your current conversion still works.`,
          );
          return;
        }
        const unavailable: string[] = [];
        const next = targets.map((code) => {
          const result = results[codes.indexOf(code)];
          if (result.status === 'rejected') {
            unavailable.push(code);
            return { code, points: [] };
          }
          return { code, points: pairSeries(baseResult.value, result.value) };
        });
        setFailed(unavailable);
        setAllSeries(next);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Historical rates could not be loaded. Your current conversion still works.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadedKey(`${base}|${quotesKey}`);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [base, quotesKey, retry, state.lastChecked]);
  const prepared = useMemo(
    () => prepareComparison(visibleSeries, range, mode),
    [visibleSeries, range, mode],
  );
  const rangedSeries = useMemo(
    () => visibleSeries.map((item) => ({ ...item, points: filterRange(item.points, range) })),
    [visibleSeries, range],
  );
  const rawByCode = useMemo(
    () =>
      new Map(
        rangedSeries.map((item) => [
          item.code,
          new Map(item.points.map((point) => [point.date, point])),
        ]),
      ),
    [rangedSeries],
  );
  const preparedByCode = useMemo(
    () =>
      new Map(
        prepared.series.map((item) => [
          item.code,
          new Map(item.points.map((point) => [point.date, point])),
        ]),
      ),
    [prepared],
  );
  const tableDates = useMemo(
    () =>
      [...new Set(rangedSeries.flatMap((item) => item.points.map((point) => point.date)))].sort(),
    [rangedSeries],
  );
  const hasPlot = prepared.series.some((item) => item.points.length > 0);
  const noCommonDate =
    !isLoading && mode === 'change' && tableDates.length > 0 && !prepared.baselineDate;
  const emptyCodes = prepared.excluded.filter((code) => !failed.includes(code));
  const selectedCurrencies = state.selected
    .map((code) => currencies.find((currency) => currency.code === code))
    .filter((currency): currency is Currency => Boolean(currency));
  const unavailable = !isLoading && failed.length > 0;
  const observationCount = rangedSeries.reduce((total, item) => total + item.points.length, 0);
  return (
    <section class="history-section" aria-labelledby="history-heading">
      <div class="section-heading">
        <h2 id="history-heading">Exchange rates over time</h2>
      </div>
      <div class="history-card comparison-card">
        <div class="chart-toolbar comparison-toolbar">
          <label class="reference-control">
            <span>Reference currency</span>
            <span class="select-wrap">
              <select
                aria-label="Reference currency"
                value={base}
                onChange={(event) =>
                  onChange(changeChartBase(state.chart, event.currentTarget.value, state.selected))
                }
              >
                {selectedCurrencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron" />
            </span>
            <small>Rates are quoted per 1 {base}.</small>
          </label>
          <div class="comparison-view-controls">
            <div class="range-control mode-control" role="group" aria-label="Chart view">
              {(
                [
                  { value: 'rate', label: 'Rates' },
                  { value: 'change', label: '% change' },
                ] as const
              ).map((item) => (
                <button
                  key={item.value}
                  aria-pressed={mode === item.value}
                  onClick={() => onChange({ ...state.chart, mode: item.value })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div class="range-control" role="group" aria-label="History range">
              {(['1M', '3M', '1Y'] as ChartRange[]).map((value) => (
                <button
                  key={value}
                  aria-pressed={range === value}
                  onClick={() => onChange({ ...state.chart, range: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>
        <fieldset class="comparison-options">
          <legend>Compare against</legend>
          <div>
            {selectedCurrencies
              .filter((currency) => currency.code !== base)
              .map((currency) => {
                const checked = quotes.includes(currency.code);
                return (
                  <label
                    key={currency.code}
                    class={`comparison-option ${checked ? 'is-selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={currency.code}
                      checked={checked}
                      disabled={checked && quotes.length === 1}
                      onChange={() =>
                        onChange({
                          ...state.chart,
                          quotes: checked
                            ? quotes.filter((code) => code !== currency.code)
                            : [...quotes, currency.code],
                        })
                      }
                    />
                    <span>{currency.code}</span>
                    <span class="comparison-currency-name">{currency.name}</span>
                  </label>
                );
              })}
          </div>
          <p>Add currencies above to include them here. Keep at least one selected.</p>
        </fieldset>
        <p class="comparison-baseline">
          {mode === 'change'
            ? prepared.baselineDate
              ? `Change since ${fullDate(prepared.baselineDate)}`
              : 'Percentage change from a shared observation date'
            : `Units per 1 ${base}`}
        </p>
        {mode === 'change' && prepared.baselineDate && (
          <p class="comparison-explanation">
            A positive change means 1 {base} buys more of that currency than on the starting date.
          </p>
        )}
        {unavailable && (
          <p class="comparison-status" role="status">
            History unavailable for {failed.join(', ')}.{' '}
            {hasPlot || tableDates.length > 0
              ? 'Showing available currencies.'
              : 'Try again or choose another currency.'}{' '}
            <button class="text-button" onClick={() => setRetry((value) => value + 1)}>
              Retry history
            </button>
          </p>
        )}
        {!isLoading && emptyCodes.length > 0 && (
          <p class="comparison-status" role="status">
            No observations in this period for {emptyCodes.join(', ')}.
          </p>
        )}
        {!isLoading && !error && (
          <ul class="comparison-legend" aria-label="Compared currencies">
            {quotes.map((code, index) => {
              const last = rangedSeries.find((item) => item.code === code)?.points.at(-1);
              const normalized = last ? preparedByCode.get(code)?.get(last.date) : undefined;
              return (
                <li key={code}>
                  <SeriesMark index={index} />
                  <div>
                    <strong>{code}</strong>
                    {last ? (
                      <>
                        <span>
                          1 {base} = {chartNumber(Number(last.rate))} {code}
                        </span>
                        <small>
                          {fullDate(last.date)}
                          {mode === 'change' && normalized
                            ? ` · ${percentNumber(normalized.value)}`
                            : ''}
                        </small>
                      </>
                    ) : (
                      <span>
                        {failed.includes(code)
                          ? 'History unavailable'
                          : 'No observations in this period'}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {isLoading ? (
          <div class="chart-placeholder" role="status">
            <span class="loading-line" />
            <p>Loading historical rates…</p>
          </div>
        ) : error ? (
          <div class="chart-placeholder">
            <p role="status">{error}</p>
            <button class="text-button" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : noCommonDate ? (
          <div class="chart-placeholder">
            <Icon name="chart" width="32" height="32" />
            <p role="status">
              These currencies have no shared observation date in this period. Switch to Rates to
              view their available history.
            </p>
            <button
              class="button secondary"
              onClick={() => onChange({ ...state.chart, mode: 'rate' })}
            >
              Show rates
            </button>
          </div>
        ) : !hasPlot ? (
          <div class="chart-placeholder">
            <Icon name="chart" width="32" height="32" />
            <p>No matching observations in this period.</p>
            <span class="small muted">Try another date range or comparison currency.</span>
          </div>
        ) : (
          <Plot series={prepared.series} codes={quotes} base={base} mode={mode} />
        )}
        <div class="chart-footnote">
          <span>
            <span class="legend-dot" />
            Daily provider rates · {observationCount} observations
          </span>
          <span>
            {tableDates.length > 0
              ? `Through ${fullDate(tableDates.at(-1)!)}`
              : 'Custom rates excluded'}
          </span>
        </div>
        {state.markup.enabled && (
          <p class="custom-chart-note">Historical rates do not include your markup.</p>
        )}
        {(state.custom[base] || quotes.some((code) => state.custom[code])) && (
          <p class="custom-chart-note">
            Your conversion uses a custom rate. This chart shows provider history.
          </p>
        )}
        {tableDates.length > 0 && (
          <details class="history-table">
            <summary>
              View historical data <Icon name="chevron" />
            </summary>
            <div class="table-scroll" tabIndex={0} aria-label="Historical rate table">
              <table class="comparison-table">
                <caption>
                  Daily provider rates in units per 1 {base}.
                  {mode === 'change' && prepared.baselineDate
                    ? ` Percentage changes are relative to ${fullDate(prepared.baselineDate)}.`
                    : ''}{' '}
                  A dash means an observation or percentage change is unavailable. Missing
                  observations are not carried forward. Gaps longer than four days break the chart
                  lines.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    {quotes.map((code) => (
                      <Fragment key={code}>
                        <th scope="col">
                          {code} per 1 {base}
                        </th>
                        {mode === 'change' && <th scope="col">{code} change</th>}
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...tableDates].reverse().map((date) => (
                    <tr key={date}>
                      <th scope="row">{fullDate(date)}</th>
                      {quotes.map((code) => {
                        const raw = rawByCode.get(code)?.get(date);
                        const point = preparedByCode.get(code)?.get(date);
                        return (
                          <Fragment key={code}>
                            <td>{raw ? chartNumber(Number(raw.rate)) : '—'}</td>
                            {mode === 'change' && (
                              <td>{point ? percentNumber(point.value) : '—'}</td>
                            )}
                          </Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
