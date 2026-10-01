import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { ChartPoint, ChartRange, Currency, SavedState } from '../types';
import { loadHistory } from '../api';
import { filterRange, pairSeries } from '../history';
import { Icon } from './Icons';

const chartNumber = (value: number) =>
  new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 6 }).format(value);
const axisNumber = (value: number) =>
  Math.abs(value) < 0.0001 || Math.abs(value) >= 1e7
    ? value.toExponential(1)
    : new Intl.NumberFormat('en-GB', { maximumSignificantDigits: 5 }).format(value);
const fullDate = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

function Plot({ points, base, quote }: { points: ChartPoint[]; base: string; quote: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(900);
  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setPlotWidth(Math.max(300, entries[0].contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const left = plotWidth < 500 ? 57 : 70,
    top = 25,
    width = plotWidth - left - 20,
    height = 190;
  const numbers = points.map((point) => Number(point.rate));
  const low = Math.min(...numbers),
    high = Math.max(...numbers);
  const spread = high - low || high * 0.02 || 0.02;
  const min = low - spread * 0.18,
    max = high + spread * 0.18;
  const start = Date.parse(points[0].date),
    end = Date.parse(points.at(-1)!.date);
  const x = (index: number) =>
    left +
    (end === start
      ? width / 2
      : ((Date.parse(points[index].date) - start) / (end - start)) * width);
  const y = (value: number) => top + height - ((value - min) / (max - min)) * height;
  const segments: number[][] = [];
  points.forEach((point, index) => {
    if (
      index === 0 ||
      Date.parse(point.date) - Date.parse(points[index - 1].date) > 4 * 24 * 60 * 60 * 1000
    )
      segments.push([]);
    segments.at(-1)!.push(index);
  });
  const paths = segments.map((segment) =>
    segment
      .map(
        (index, offset) =>
          `${offset ? 'L' : 'M'}${x(index).toFixed(2)},${y(Number(points[index].rate)).toFixed(2)}`,
      )
      .join(' '),
  );
  const line = paths.join(' ');
  const area = paths
    .map(
      (path, index) =>
        `${path} L${x(segments[index].at(-1)!)},${top + height} L${x(segments[index][0])},${top + height} Z`,
    )
    .join(' ');
  const activeIndex = hover === null ? points.length - 1 : Math.min(hover, points.length - 1);
  const active = points[activeIndex];
  const ticks = [0, 1, 2, 3].map((index) => min + ((max - min) * index) / 3);
  const tooltipWidth = 172;
  const tooltipX = Math.max(
    left,
    Math.min(x(activeIndex) - tooltipWidth / 2, left + width - tooltipWidth),
  );
  return (
    <div class="plot-wrap" ref={plotRef}>
      <svg
        class="history-plot"
        viewBox={`0 0 ${plotWidth} 265`}
        role="img"
        tabIndex={0}
        aria-labelledby={`${id}-title ${id}-desc`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const position = (((event.clientX - rect.left) / rect.width) * plotWidth - left) / width;
          const target = start + Math.max(0, Math.min(1, position)) * (end - start);
          let nearest = 0;
          points.forEach((point, index) => {
            if (
              Math.abs(Date.parse(point.date) - target) <
              Math.abs(Date.parse(points[nearest].date) - target)
            )
              nearest = index;
          });
          setHover(nearest);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setHover(
              Math.max(
                0,
                Math.min(points.length - 1, activeIndex + (event.key === 'ArrowLeft' ? -1 : 1)),
              ),
            );
          }
        }}
      >
        <title id={`${id}-title`}>
          {base} to {quote} historical exchange rate
        </title>
        <desc id={`${id}-desc`}>
          {points.length} observations from {fullDate(points[0].date)} to{' '}
          {fullDate(points.at(-1)!.date)}. Gaps longer than four days appear as breaks in the line.
          Use left and right arrow keys to inspect observations, or open the data table below.
        </desc>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity=".16" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((value) => (
          <g key={value}>
            <line x1={left} x2={left + width} y1={y(value)} y2={y(value)} class="chart-grid" />
            <text x={left - 10} y={y(value) + 4} text-anchor="end" class="chart-label">
              {axisNumber(value)}
            </text>
          </g>
        ))}
        <path d={area} fill={`url(#${id}-fill)`} />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          stroke-width="2.8"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        {segments
          .filter((segment) => segment.length === 1)
          .map((segment) => (
            <circle
              key={segment[0]}
              cx={x(segment[0])}
              cy={y(numbers[segment[0]])}
              r="3"
              fill="var(--accent)"
            />
          ))}
        {[0, Math.floor((points.length - 1) / 2), points.length - 1]
          .filter((item, index, all) => all.indexOf(item) === index)
          .map((index) => (
            <text
              key={index}
              x={x(index)}
              y="248"
              text-anchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
              class="chart-label"
            >
              {new Date(`${points[index].date}T12:00:00Z`).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                timeZone: 'UTC',
              })}
            </text>
          ))}
        {hover !== null && (
          <line
            x1={x(activeIndex)}
            x2={x(activeIndex)}
            y1={top}
            y2={top + height}
            stroke="var(--accent)"
            stroke-dasharray="3 5"
            opacity=".5"
          />
        )}
        <circle
          cx={x(activeIndex)}
          cy={y(Number(active.rate))}
          r="5"
          fill="var(--accent)"
          stroke="var(--surface)"
          stroke-width="3"
        />
        {hover !== null && (
          <g class="plot-tooltip" role="tooltip">
            <rect x={tooltipX} y="6" width={tooltipWidth} height="44" rx="6" fill="var(--text)" />
            <text x={tooltipX + 10} y="23" fill="var(--surface)" font-size="10">
              {fullDate(active.date)}
            </text>
            <text x={tooltipX + 10} y="39" fill="var(--surface)" font-size="11">
              1 {base} = {chartNumber(Number(active.rate))} {quote}
            </text>
          </g>
        )}
      </svg>
      <p class="chart-observation" aria-live="polite">
        <span>{fullDate(active.date)}</span>
        <strong>
          1 {base} = {chartNumber(Number(active.rate))} {quote}
        </strong>
      </p>
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
  const [allPoints, setAllPoints] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { base, quote, range } = state.chart;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setAllPoints([]);
    Promise.all([loadHistory(base, controller.signal), loadHistory(quote, controller.signal)])
      .then(([from, to]) => {
        if (!controller.signal.aborted) setAllPoints(pairSeries(from, to));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Historical rates could not be loaded. Your current conversion still works.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, quote, retry, state.lastChecked]);
  const points = useMemo(() => filterRange(allPoints, range), [allPoints, range]);
  const first = points[0],
    last = points.at(-1);
  const change = first && last ? (Number(last.rate) / Number(first.rate) - 1) * 100 : 0;
  const latest = last ? chartNumber(Number(last.rate)) : '—';
  const selectedCurrencies = state.selected
    .map((code) => currencies.find((currency) => currency.code === code))
    .filter((currency): currency is Currency => Boolean(currency));
  function updatePair(which: 'base' | 'quote', code: string) {
    const other = which === 'base' ? 'quote' : 'base';
    onChange({
      ...state.chart,
      [which]: code,
      [other]: state.chart[other] === code ? state.chart[which] : state.chart[other],
    });
  }
  return (
    <section class="history-section" aria-labelledby="history-heading">
      <div class="section-heading">
        <div>
          <span class="eyebrow">THE BIGGER PICTURE</span>
          <h2 id="history-heading">Every rate has a history.</h2>
        </div>
        <p class="section-caption">A little perspective for your next move.</p>
      </div>
      <div class="history-card">
        <div class="chart-toolbar">
          <div class="pair-selectors">
            <label class="select-wrap">
              <span class="sr-only">Chart base currency</span>
              <select
                value={base}
                onChange={(event) => updatePair('base', event.currentTarget.value)}
              >
                {selectedCurrencies.map((currency) => (
                  <option value={currency.code} key={currency.code}>
                    {currency.code}
                  </option>
                ))}
              </select>
              <Icon name="chevron" />
            </label>
            <span class="pair-divider">to</span>
            <label class="select-wrap">
              <span class="sr-only">Chart quote currency</span>
              <select
                value={quote}
                onChange={(event) => updatePair('quote', event.currentTarget.value)}
              >
                {selectedCurrencies.map((currency) => (
                  <option value={currency.code} key={currency.code}>
                    {currency.code}
                  </option>
                ))}
              </select>
              <Icon name="chevron" />
            </label>
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
        <div class="chart-summary">
          <div>
            <span class="chart-amount">{latest}</span>
            <span class="chart-unit">
              {quote} / {base}
            </span>
          </div>
          {!loading && last && (
            <span class={`change-badge ${change < 0 ? 'negative' : ''}`}>
              {change >= 0 ? '+' : ''}
              {change.toFixed(2)}% <span>over period</span>
            </span>
          )}
        </div>
        {loading ? (
          <div class="chart-placeholder" role="status">
            <span class="loading-line" />
            <p>Finding the bigger picture…</p>
          </div>
        ) : error ? (
          <div class="chart-placeholder">
            <p role="status">{error}</p>
            <button class="text-button" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : points.length === 0 ? (
          <div class="chart-placeholder">
            <Icon name="chart" width="32" height="32" />
            <p>No matching observations in this period.</p>
            <span class="small muted">Try another date range or currency pair.</span>
          </div>
        ) : (
          <Plot points={points} base={base} quote={quote} />
        )}
        <div class="chart-footnote">
          <span>
            <span class="legend-dot" />
            Daily provider rates · {points.length} observations
          </span>
          <span>{last ? `Through ${fullDate(last.date)}` : 'Custom rates excluded'}</span>
        </div>
        {(state.custom[base] || state.custom[quote]) && (
          <p class="custom-chart-note">
            Your conversion uses a custom rate. This chart shows provider history.
          </p>
        )}
        {points.length > 0 && (
          <details class="history-table">
            <summary>
              View historical data <Icon name="chevron" />
            </summary>
            <div class="table-scroll" tabIndex={0} aria-label="Historical rate table">
              <table>
                <caption>
                  Daily provider rates: 1 {base} in {quote}. Only dates with observations for both
                  currencies are shown. Gaps longer than four days break the chart line.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">
                      {quote} per {base}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...points].reverse().map((point) => (
                    <tr key={point.date}>
                      <th scope="row">{fullDate(point.date)}</th>
                      <td>{chartNumber(Number(point.rate))}</td>
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
