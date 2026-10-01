import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryData, LatestData } from '../src/types';
import { filterRange, pairSeries } from '../src/history';

const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-10-01T10:00:00.000Z';
const snapshot = (
  quote = 'USD',
  points: [string, string][] = [['2026-09-30', '1.1']],
): HistoryData => ({
  schemaVersion: 1,
  base: 'EUR',
  quote,
  generatedAt: '2026-09-30T18:00:00.000Z',
  points,
});
const row = (rate: number, quote = 'USD', date = '2026-10-01') => ({
  base: 'EUR',
  quote,
  rate,
  date,
});
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser rate requests', () => {
  it('loads validated bundled defaults without sending cookies', async () => {
    const latest: LatestData = {
      schemaVersion: 1,
      base: 'EUR',
      generatedAt: NOW,
      currencies: [
        { code: 'EUR', name: 'Euro', symbol: '€' },
        { code: 'GBP', name: 'Pound', symbol: '£' },
        { code: 'USD', name: 'Dollar', symbol: '$' },
      ],
      rates: {
        GBP: { rate: '0.85', date: '2026-09-30', fetchedAt: NOW },
        USD: { rate: '1.1', date: '2026-09-30', fetchedAt: NOW },
      },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(latest));
    vi.stubGlobal('fetch', fetcher);
    const { loadBundledLatest } = await import('../src/api');
    expect(await loadBundledLatest()).toEqual(latest);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('data/latest.json'),
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-cache',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('sends only deduplicated currency codes and the current UTC date, and filters unsolicited quotes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json([row(0.85, 'GBP'), row(1.1), row(180, 'JPY')]));
    vi.stubGlobal('fetch', fetcher);
    const { fetchLatest } = await import('../src/api');
    const result = await fetchLatest(['EUR', 'GBP', 'USD', 'GBP', 'USD&amount=12345', '../GBP']);
    const [request, init] = fetcher.mock.calls[0];
    const url = new URL(String(request));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      base: 'EUR',
      quotes: 'GBP,USD',
      date: '2026-10-01',
    });
    expect(init?.credentials).toBe('omit');
    expect(init?.body).toBeUndefined();
    expect(Object.keys(result)).toEqual(['GBP', 'USD']);
    expect(result.USD.fetchedAt).toBe(NOW);
    expect(await fetchLatest(['EUR'])).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed and future current rates without returning partial data', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([row(1.1), row(0.85, 'GBP', '2026-10-02')]))
      .mockResolvedValueOnce(json([row(-1)]));
    vi.stubGlobal('fetch', fetcher);
    const { fetchLatest } = await import('../src/api');
    await expect(fetchLatest(['GBP', 'USD'])).rejects.toThrow();
    await expect(fetchLatest(['USD'])).rejects.toThrow();
  });
});

describe('validated history and memory fallback', () => {
  it('caches valid provider history for 24 hours and refetches at expiry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes('api.frankfurter') ? json([row(1.2)]) : json(snapshot()),
      );
    vi.stubGlobal('fetch', fetcher);
    const { loadHistory } = await import('../src/api');
    const initial = await loadHistory('USD');
    expect(initial.points).toEqual([
      ['2026-09-30', '1.1'],
      ['2026-10-01', '1.2'],
    ]);
    vi.setSystemTime(new Date(Date.parse(NOW) + DAY - 1));
    expect(await loadHistory('USD')).toEqual(initial);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date(Date.parse(NOW) + DAY));
    await loadHistory('USD');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('preserves newer memory history through both unavailable and older bundled data', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(json([row(1.25, 'USD', '2026-09-30')]))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const { loadHistory } = await import('../src/api');
    await loadHistory('USD');
    vi.setSystemTime(new Date(Date.parse(NOW) + DAY));
    const unavailable = await loadHistory('USD');
    expect(unavailable.points).toEqual([['2026-09-30', '1.25']]);
    expect(unavailable.generatedAt).toBe(NOW);
    expect(await loadHistory('USD')).toEqual(unavailable);
    expect(fetcher).toHaveBeenCalledTimes(4);
    vi.setSystemTime(new Date(Date.parse(NOW) + DAY + 60_000));
    expect((await loadHistory('USD')).points).toEqual([['2026-09-30', '1.25']]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('recovers from mismatched bundled provenance through a valid provider response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(snapshot('GBP', [['2026-09-30', '0.85']])))
      .mockResolvedValueOnce(json([row(1.2)]));
    vi.stubGlobal('fetch', fetcher);
    const { loadHistory } = await import('../src/api');
    expect((await loadHistory('USD')).points).toEqual([['2026-10-01', '1.2']]);
  });

  it.each([
    ['wrong currency', [row(0.85, 'GBP')]],
    ['wrong anchor', [{ ...row(1.2), base: 'GBP' }]],
    ['future date', [row(1.2, 'USD', '2026-10-02')]],
    ['conflicting duplicate', [row(1.2), row(1.3)]],
    ['invalid amount', [row(-1)]],
    ['untrusted record shape', { points: [['2026-10-01', '9']] }],
  ])(
    'does not poison fallback history with a provider response containing %s',
    async (_name, invalid) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(snapshot()))
        .mockResolvedValueOnce(json(invalid))
        .mockResolvedValueOnce(json(snapshot()))
        .mockResolvedValueOnce(json([row(1.2)]));
      vi.stubGlobal('fetch', fetcher);
      const { loadHistory } = await import('../src/api');
      const fallback = await loadHistory('USD');
      expect(fallback.points).toEqual(snapshot().points);
      expect(fallback.generatedAt).toBe(snapshot().generatedAt);
      vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
      expect((await loadHistory('USD')).points).toEqual([
        ['2026-09-30', '1.1'],
        ['2026-10-01', '1.2'],
      ]);
    },
  );

  it('throws when both sources are invalid, without caching invalid data', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(snapshot('USD', [['2026-10-02', '9']])))
      .mockResolvedValueOnce(json([row(9, 'GBP')]))
      .mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(json([row(1.2)]));
    vi.stubGlobal('fetch', fetcher);
    const { loadHistory } = await import('../src/api');
    await expect(loadHistory('USD')).rejects.toThrow();
    expect((await loadHistory('USD')).points.at(-1)).toEqual(['2026-10-01', '1.2']);
  });

  it('rejects invalid codes and cancelled requests before fetching, while EUR needs no data request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const { loadHistory } = await import('../src/api');
    await expect(loadHistory('../USD')).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(loadHistory('USD', controller.signal)).rejects.toThrow();
    expect((await loadHistory('EUR')).points).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clamps a leap-day year range without dropping February 28 observations', async () => {
    vi.setSystemTime(new Date('2024-02-29T10:00:00Z'));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(json([row(1.1, 'USD', '2023-02-28')]));
    vi.stubGlobal('fetch', fetcher);
    const { loadHistory } = await import('../src/api');
    expect((await loadHistory('USD')).points).toEqual([['2023-02-28', '1.1']]);
    const query = new URL(String(fetcher.mock.calls[1][0])).searchParams;
    expect(query.get('from')).toBe('2023-02-28');
    expect(query.get('to')).toBe('2024-02-29');
  });
});

describe('historical pairs', () => {
  it('uses only matching observation dates without filling missing data', () => {
    const base = snapshot('GBP', [
      ['2026-09-28', '0.8'],
      ['2026-09-30', '0.88'],
    ]);
    const quote = snapshot('USD', [
      ['2026-09-29', '1.2'],
      ['2026-09-30', '1.1'],
    ]);
    expect(pairSeries(base, quote)).toEqual([{ date: '2026-09-30', rate: '1.25' }]);
    expect(pairSeries(snapshot('EUR', []), quote)).toEqual(
      quote.points.map(([date, rate]) => ({ date, rate })),
    );
    expect(pairSeries(base, snapshot('EUR', []))[0]).toEqual({ date: '2026-09-28', rate: '1.25' });
  });

  it('clamps month boundaries and excludes dates after the chosen day', () => {
    const points = ['2026-02-27', '2026-02-28', '2026-03-31', '2026-04-01'].map((date) => ({
      date,
      rate: '1',
    }));
    expect(
      filterRange(points, '1M', new Date('2026-03-31T10:00:00Z')).map(({ date }) => date),
    ).toEqual(['2026-02-28', '2026-03-31']);
  });
});
