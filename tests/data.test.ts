import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchJson,
  mergeHistory,
  mergeQuotes,
  parseCatalogue,
  updateRates,
  yearStart,
} from '../scripts/update-rates';
import type { HistoryData, LatestData } from '../src/types';

const fetchedAt = '2026-09-30T18:00:00.000Z';
const now = new Date(fetchedAt);
const catalogue = [
  { iso_code: 'EUR', name: 'Euro', symbol: '€' },
  { iso_code: 'GBP', name: 'Pound Sterling', symbol: '£' },
  { iso_code: 'USD', name: 'US Dollar', symbol: '$' },
];
const row = (quote: string, rate: number, date = '2026-09-30') => ({
  base: 'EUR',
  quote,
  rate,
  date,
});
const current = [row('EUR', 1), row('GBP', 0.87), row('USD', 1.17)];
const history = [
  row('EUR', 1, '2026-09-29'),
  row('GBP', 0.86, '2026-09-29'),
  row('USD', 1.16, '2026-09-29'),
  ...current,
];
const dirs: string[] = [];

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'exchange-data-test-'));
  dirs.push(root);
  return join(root, 'data');
}

function provider(
  latest: unknown = current,
  series: unknown = history,
  currencies: unknown = catalogue,
): typeof fetch {
  return vi.fn(async (input) => {
    const url = new URL(String(input));
    const value = url.pathname.endsWith('/currencies')
      ? currencies
      : url.searchParams.has('from')
        ? series
        : latest;
    return new Response(JSON.stringify(value), { status: 200 });
  });
}

async function readLatest(dataDir: string): Promise<LatestData> {
  return JSON.parse(await readFile(join(dataDir, 'latest.json'), 'utf8')) as LatestData;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('currency data policy', () => {
  it('admits active fiat X codes and Zimbabwe Gold, excluding obsolete, metal, and accounting codes', () => {
    const codes = [
      'XAF',
      'XCD',
      'XCG',
      'XOF',
      'XPF',
      'ZWG',
      'XAU',
      'XDR',
      'ANG',
      'MRO',
      'CMD',
      'CNH',
      'ZZZ',
    ];
    const result = parseCatalogue([
      ...catalogue,
      ...codes.map((code) => ({ iso_code: code, name: code, symbol: code })),
    ]);
    expect(result.map(({ code }) => code)).toEqual([
      'EUR',
      'GBP',
      'USD',
      'XAF',
      'XCD',
      'XCG',
      'XOF',
      'XPF',
      'ZWG',
    ]);
  });

  it('retains newer observations and stable timestamps, but accepts same-day corrections', () => {
    const previous = {
      GBP: { rate: '0.87', date: '2026-09-30', fetchedAt },
      USD: { rate: '1.17', date: '2026-09-30', fetchedAt },
    };
    expect(
      mergeQuotes(previous, {
        GBP: { rate: '0.8', date: '2026-09-29', fetchedAt: '2026-10-01T00:00:00Z' },
      }),
    ).toEqual(previous);
    const corrected = mergeQuotes(previous, {
      GBP: { rate: '0.87', date: '2026-09-30', fetchedAt: '2026-10-01T00:00:00Z' },
      USD: { rate: '1.18', date: '2026-09-30', fetchedAt: '2026-10-01T00:00:00Z' },
    });
    expect(corrected.GBP).toBe(previous.GBP);
    expect(corrected.USD.rate).toBe('1.18');
  });

  it('merges corrected history, retains omitted points, and prunes a rolling calendar year', () => {
    const previous: HistoryData = {
      schemaVersion: 1,
      base: 'EUR',
      quote: 'GBP',
      generatedAt: fetchedAt,
      points: [
        ['2025-09-29', '0.9'],
        ['2026-09-28', '0.85'],
        ['2026-09-29', '0.86'],
      ],
    };
    const result = mergeHistory(
      'GBP',
      previous,
      [['2026-09-29', '0.861']],
      '2025-09-30',
      '2026-09-30',
      fetchedAt,
    );
    expect(result.points).toEqual([
      ['2026-09-28', '0.85'],
      ['2026-09-29', '0.861'],
    ]);
    expect(yearStart('2024-02-29')).toBe('2023-02-28');
  });
});

describe('scheduled rate updater', () => {
  it('retries a throttled request, but stops after three server failures', async () => {
    vi.useFakeTimers();
    const recovering = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const recovered = fetchJson('https://provider.example/rates', recovering);
    await vi.runAllTimersAsync();
    expect(await recovered).toEqual({ ok: true });
    expect(recovering).toHaveBeenCalledTimes(2);
    const failing = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('', { status: 503 }));
    const rejected = expect(fetchJson('https://provider.example/rates', failing)).rejects.toThrow(
      'HTTP 503',
    );
    await vi.runAllTimersAsync();
    await rejected;
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent provider request error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 422 }));
    await expect(fetchJson('https://provider.example/rates', fetcher)).rejects.toThrow('HTTP 422');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('writes real provider values, then leaves files unchanged after identical or partial responses', async () => {
    const dataDir = await directory();
    const initial = await updateRates({ dataDir, now, fetcher: provider(), log: () => {} });
    expect(initial).toEqual({ changed: true, currencies: 3, points: 6 });
    const before = await readFile(join(dataDir, 'latest.json'), 'utf8');
    const second = await updateRates({
      dataDir,
      now: new Date('2026-10-01T01:00:00Z'),
      fetcher: provider([current[0], current[2]]),
      log: () => {},
    });
    expect(second.changed).toBe(false);
    expect(await readFile(join(dataDir, 'latest.json'), 'utf8')).toBe(before);
    expect((await readLatest(dataDir)).rates.GBP.rate).toBe('0.87');
  });

  it('accepts new rates and corrections without losing omitted history', async () => {
    const dataDir = await directory();
    await updateRates({ dataDir, now, fetcher: provider(), log: () => {} });
    await updateRates({
      dataDir,
      now: new Date('2026-10-01T01:00:00Z'),
      fetcher: provider(
        [row('EUR', 1), row('GBP', 0.88), row('USD', 1.17)],
        [row('GBP', 0.865, '2026-09-29')],
      ),
      log: () => {},
    });
    expect((await readLatest(dataDir)).rates.GBP.rate).toBe('0.88');
    const stored = JSON.parse(
      await readFile(join(dataDir, 'history/GBP.json'), 'utf8'),
    ) as HistoryData;
    expect(stored.points).toEqual([
      ['2026-09-29', '0.865'],
      ['2026-09-30', '0.87'],
    ]);
  });

  it.each([
    ['malformed history', [row('GBP', -1)]],
    ['empty history', []],
    ['conflicting history', [row('GBP', 0.8), row('GBP', 0.9)]],
  ])('retains the complete previous dataset on %s', async (_name, invalid) => {
    const dataDir = await directory();
    await updateRates({ dataDir, now, fetcher: provider(), log: () => {} });
    const before = await readFile(join(dataDir, 'latest.json'), 'utf8');
    await expect(
      updateRates({
        dataDir,
        now,
        fetcher: provider([row('EUR', 1), row('GBP', 0.9)], invalid),
        log: () => {},
      }),
    ).rejects.toThrow();
    expect(await readFile(join(dataDir, 'latest.json'), 'utf8')).toBe(before);
    expect(await readdir(join(dataDir, '..'))).toEqual(['data']);
  });

  it('rejects future-dated source data and does not create a dataset in check mode', async () => {
    const dataDir = await directory();
    await expect(
      updateRates({
        dataDir,
        now,
        fetcher: provider([row('EUR', 1), row('GBP', 0.9, '2099-01-01')]),
        log: () => {},
      }),
    ).rejects.toThrow();
    const result = await updateRates({
      dataDir,
      now,
      check: true,
      fetcher: provider(),
      log: () => {},
    });
    expect(result.changed).toBe(true);
    expect(await readdir(join(dataDir, '..'))).toEqual([]);
  });

  it('requests an explicit UTC observation date and bounded history range', async () => {
    const dataDir = await directory();
    const fetcher = provider();
    await updateRates({ dataDir, now, check: true, fetcher, log: () => {} });
    const urls = vi.mocked(fetcher).mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.find((url) => url.searchParams.has('date'))?.searchParams.get('date')).toBe(
      '2026-09-30',
    );
    const range = urls.find((url) => url.searchParams.has('from'));
    expect(range?.searchParams.get('from')).toBe('2025-09-30');
    expect(range?.searchParams.get('to')).toBe('2026-09-30');
    expect(range?.searchParams.get('quotes')).toBe('EUR,GBP,USD');
  });
});
