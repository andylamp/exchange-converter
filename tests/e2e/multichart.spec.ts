import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixture, history } from '../fixtures';

const dates = ['2026-09-28', '2026-09-29', '2026-09-30'];
const observations: Record<string, [string, string][]> = {
  GBP: dates.map((date, index) => [date, ['1', '1', '0.8'][index]]),
  USD: dates.map((date, index) => [date, ['1', '1.4', '1.2'][index]]),
  JPY: dates.map((date, index) => [date, ['100', '140', '160'][index]]),
};

async function prepare(
  page: Page,
  options: {
    cookie?: string;
    unavailable?: string[];
    history?: Record<string, [string, string][]>;
  } = {},
) {
  const points = { ...observations, ...options.history };
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
  await page.route('**/data/latest.json', (route) => route.fulfill({ json: fixture }));
  await page.route('**/data/history/*.json', (route) => {
    const code = route.request().url().split('/').pop()!.replace('.json', '');
    if (options.unavailable?.includes(code)) return route.fulfill({ status: 503 });
    return route.fulfill({ json: history(code, points[code] ?? []) });
  });
  await page.route('https://api.frankfurter.dev/**', (route) => {
    const url = new URL(route.request().url());
    const codes = (url.searchParams.get('quotes') ?? '').split(',').filter(Boolean);
    if (url.searchParams.has('from')) {
      if (codes.some((code) => options.unavailable?.includes(code)))
        return route.fulfill({ status: 503 });
      return route.fulfill({
        json: codes.flatMap((code) =>
          (points[code] ?? []).map(([date, rate]) => ({
            date,
            base: 'EUR',
            quote: code,
            rate: Number(rate),
          })),
        ),
      });
    }
    return route.fulfill({
      json: codes.map((code) => ({
        date: '2026-09-30',
        base: 'EUR',
        quote: code,
        rate: Number(fixture.rates[code]?.rate ?? '1'),
      })),
    });
  });
  if (options.cookie) {
    await page.context().addCookies([
      {
        name: 'exchange_converter_v1',
        value: options.cookie,
        domain: '127.0.0.1',
        path: '/exchange-converter/',
        sameSite: 'Lax',
      },
    ]);
  }
  await page.goto('./');
  await expect(page.getByLabel('GBP amount')).toBeVisible();
}

const reference = (page: Page) => page.getByLabel('Reference currency', { exact: true });
const targets = (page: Page) => page.getByRole('group', { name: 'Compare against', exact: true });
const checkbox = (page: Page, code: string) =>
  targets(page).getByRole('checkbox', { name: code, exact: true });
const plot = (page: Page) => page.getByTestId('comparison-chart');
const line = (page: Page, code: string) => plot(page).locator(`path[data-series="${code}"]`);

async function openTable(page: Page) {
  await page.getByText('View historical data', { exact: true }).click();
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  return table;
}

async function cell(table: Locator, day: number, column: string) {
  const headers = (await table.getByRole('columnheader').allTextContents()).map((header) =>
    header.replace(/\s+/g, ' ').trim(),
  );
  const index = headers.indexOf(column);
  expect(index, `Missing column ${column}`).toBeGreaterThan(0);
  return table
    .getByRole('row', { name: new RegExp(`^${day} Sep`) })
    .locator('td')
    .nth(index - 1);
}

async function numericCell(table: Locator, day: number, column: string) {
  const text = await (await cell(table, day, column)).innerText();
  return Number(text.replace(/−/g, '-').replace(/[,%+\s]/g, ''));
}

async function addYen(page: Page) {
  await page.getByRole('button', { name: /Add currency/ }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill('JPY');
  await page.getByRole('dialog').getByRole('button', { name: /JPY/ }).click();
  await expect(page.getByLabel('JPY amount')).toBeVisible();
}

test('shows two comparisons, a visible reference, and accurate rate/change values', async ({
  page,
}) => {
  await prepare(page);
  await expect(page.getByText('Reference currency', { exact: true })).toBeVisible();
  await expect(reference(page)).toHaveValue('GBP');
  await expect(checkbox(page, 'USD')).toBeChecked();
  await expect(checkbox(page, 'EUR')).toBeChecked();
  await expect(plot(page).locator('path[data-series]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '% change', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const table = await openTable(page);
  expect(await numericCell(table, 28, 'USD change')).toBe(0);
  expect(await numericCell(table, 28, 'EUR change')).toBe(0);
  expect(await numericCell(table, 30, 'USD change')).toBe(50);
  expect(await numericCell(table, 30, 'EUR change')).toBe(25);
  expect(await numericCell(table, 30, 'USD per 1 GBP')).toBe(1.5);
  expect(await numericCell(table, 30, 'EUR per 1 GBP')).toBe(1.25);

  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rates', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(table.getByRole('columnheader', { name: 'USD change', exact: true })).toHaveCount(0);
  expect(await numericCell(table, 30, 'USD per 1 GBP')).toBe(1.5);
  await expect(plot(page).locator('path[data-series]')).toHaveCount(2);
});

test('toggles comparison lines while keeping at least one selected currency', async ({ page }) => {
  await prepare(page);
  await expect(line(page, 'USD')).toBeVisible();
  await checkbox(page, 'USD').uncheck();
  await expect(checkbox(page, 'USD')).not.toBeChecked();
  await expect(checkbox(page, 'EUR')).toBeChecked();
  await expect(checkbox(page, 'EUR')).toBeDisabled();
  await expect(line(page, 'USD')).toHaveCount(0);
  await expect(line(page, 'EUR')).toBeVisible();
  await checkbox(page, 'USD').check();
  await expect(checkbox(page, 'EUR')).toBeEnabled();
  await checkbox(page, 'EUR').uncheck();
  await expect(checkbox(page, 'USD')).toBeDisabled();
  await expect(line(page, 'USD')).toBeVisible();
  await expect(line(page, 'EUR')).toHaveCount(0);
});

test('changes the visible reference and swaps the old reference into the comparisons', async ({
  page,
}) => {
  await prepare(page);
  await reference(page).selectOption('USD');
  await expect(reference(page)).toHaveValue('USD');
  await expect(checkbox(page, 'USD')).toHaveCount(0);
  await expect(checkbox(page, 'GBP')).toBeChecked();
  await expect(checkbox(page, 'EUR')).toBeChecked();
  await expect(line(page, 'GBP')).toBeVisible();
  await expect(line(page, 'EUR')).toBeVisible();
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  const table = await openTable(page);
  expect(await numericCell(table, 30, 'GBP per 1 USD')).toBeCloseTo(2 / 3, 5);
  expect(await numericCell(table, 30, 'EUR per 1 USD')).toBeCloseTo(5 / 6, 5);
  await expect(page.getByLabel('GBP amount')).toHaveValue('100');
  await expect(page.getByLabel('USD amount')).toHaveValue('150.00');
});

test('restores reference, target selection, chart mode, and range from the browser cookie', async ({
  page,
}) => {
  await prepare(page);
  await reference(page).selectOption('EUR');
  await checkbox(page, 'GBP').uncheck();
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  await page.getByRole('button', { name: '1Y', exact: true }).click();
  await expect
    .poll(async () => {
      const saved = (await page.context().cookies()).find(
        (entry) => entry.name === 'exchange_converter_v1',
      );
      return saved ? JSON.parse(decodeURIComponent(saved.value))[5] : null;
    })
    .toEqual(['EUR', ['USD'], '1Y', 'rate']);
  await page.reload();
  await expect(reference(page)).toHaveValue('EUR');
  await expect(checkbox(page, 'USD')).toBeChecked();
  await expect(checkbox(page, 'GBP')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Rates', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '1Y', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(plot(page).locator('path[data-series]')).toHaveCount(1);
  await expect(line(page, 'USD')).toBeVisible();
});

test('migrates an existing single-pair cookie without losing the entered amount or pair', async ({
  page,
}) => {
  const selected = ['GBP', 'EUR', 'USD'];
  const cookie = encodeURIComponent(
    JSON.stringify([
      1,
      selected.map((code) => [
        code,
        [fixture.rates[code].rate, fixture.rates[code].date, Date.parse(fixture.generatedAt)],
        null,
      ]),
      'USD',
      '123.45',
      Date.parse('2026-09-30T00:00:00Z'),
      ['EUR', 'GBP', '1M'],
    ]),
  );
  await prepare(page, { cookie });
  await expect(page.getByLabel('USD amount')).toHaveValue('123.45');
  await expect(reference(page)).toHaveValue('EUR');
  await expect(checkbox(page, 'GBP')).toBeChecked();
  await expect(checkbox(page, 'USD')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Rates', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '1M', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(line(page, 'GBP')).toBeVisible();
  await page.getByRole('button', { name: '3M', exact: true }).click();
  await expect
    .poll(async () => {
      const saved = (await page.context().cookies()).find(
        (entry) => entry.name === 'exchange_converter_v1',
      );
      return saved ? JSON.parse(decodeURIComponent(saved.value))[0] : null;
    })
    .toBe(2);
  await page.reload();
  await expect(page.getByLabel('USD amount')).toHaveValue('123.45');
  await expect(reference(page)).toHaveValue('EUR');
  await expect(checkbox(page, 'GBP')).toBeChecked();
});

test('keeps successful lines and conversion amounts when another history source fails', async ({
  page,
}) => {
  await prepare(page, { unavailable: ['USD'] });
  await expect(line(page, 'EUR')).toBeVisible();
  await expect(line(page, 'USD')).toHaveCount(0);
  await expect(page.getByText(/History unavailable for USD/)).toBeVisible();
  await expect(checkbox(page, 'USD')).toBeChecked();
  await expect(page.getByLabel('USD amount')).toHaveValue('150.00');
  await page.getByLabel('GBP amount').fill('20');
  await expect(page.getByLabel('USD amount')).toHaveValue('30.00');
});

test('adds available comparison choices and repairs filters when conversion cards are removed', async ({
  page,
}) => {
  await prepare(page);
  await addYen(page);
  await expect(checkbox(page, 'JPY')).not.toBeChecked();
  await expect(line(page, 'JPY')).toHaveCount(0);
  await checkbox(page, 'JPY').check();
  await expect(plot(page).locator('path[data-series]')).toHaveCount(3);
  await page.getByRole('button', { name: 'Remove USD', exact: true }).click();
  await expect(checkbox(page, 'USD')).toHaveCount(0);
  await expect(line(page, 'USD')).toHaveCount(0);
  await expect(plot(page).locator('path[data-series]')).toHaveCount(2);
  await reference(page).selectOption('JPY');
  await expect(checkbox(page, 'GBP')).toBeChecked();
  await expect(checkbox(page, 'EUR')).toBeChecked();
  await page.getByRole('button', { name: 'Remove JPY', exact: true }).click();
  await expect(reference(page)).toHaveValue('GBP');
  await expect(checkbox(page, 'JPY')).toHaveCount(0);
  await expect(checkbox(page, 'EUR')).toBeChecked();
  await expect(checkbox(page, 'EUR')).toBeDisabled();
  await expect(plot(page).locator('path[data-series]')).toHaveCount(1);
  await expect(line(page, 'EUR')).toBeVisible();
});

test('normalizes percentage changes from one shared date and leaves earlier changes blank', async ({
  page,
}) => {
  await prepare(page, { history: { USD: observations.USD.slice(1) } });
  await expect(plot(page).locator('path[data-series]')).toHaveCount(2);
  const table = await openTable(page);
  expect(await numericCell(table, 29, 'USD change')).toBe(0);
  expect(await numericCell(table, 29, 'EUR change')).toBe(0);
  expect(await numericCell(table, 30, 'USD change')).toBeCloseTo(7.142857, 1);
  expect(await numericCell(table, 30, 'EUR change')).toBe(25);
  await expect(await cell(table, 28, 'EUR change')).toHaveText('—');
  await expect(await cell(table, 28, 'USD per 1 GBP')).toHaveText('—');
  expect(await numericCell(table, 28, 'EUR per 1 GBP')).toBe(1);
});

test('keeps raw observations accessible when compared currencies have no shared baseline', async ({
  page,
}) => {
  await prepare(page, {
    history: {
      USD: [observations.USD[0]],
      JPY: [observations.JPY[2]],
    },
  });
  await addYen(page);
  await checkbox(page, 'JPY').check();
  await checkbox(page, 'EUR').uncheck();
  await expect(page.getByText(/These currencies have no shared observation date/)).toBeVisible();
  await expect(plot(page)).toHaveCount(0);
  const table = await openTable(page);
  expect(await numericCell(table, 28, 'USD per 1 GBP')).toBe(1);
  expect(await numericCell(table, 30, 'JPY per 1 GBP')).toBe(200);
  await expect(await cell(table, 28, 'USD change')).toHaveText('—');
  await expect(await cell(table, 30, 'JPY change')).toHaveText('—');
  await page.getByRole('button', { name: 'Show rates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rates', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(plot(page).locator('path[data-series]')).toHaveCount(2);
  await expect(line(page, 'USD')).toBeAttached();
  await expect(line(page, 'JPY')).toBeAttached();
});
