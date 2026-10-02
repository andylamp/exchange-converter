import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fixture, history } from '../fixtures';

const dates = ['2026-09-28', '2026-09-29', '2026-09-30'];
const historicalRates: Record<string, string[]> = {
  GBP: ['1', '0.9', '0.8'],
  USD: ['1', '1.1', '1.2'],
  JPY: ['140', '150', '160'],
};
const baseAmount = (page: Page, code: string) => page.getByLabel(`${code} amount`, { exact: true });
const markedAmount = (page: Page, code: string) =>
  page.getByLabel(`${code} amount with markup`, { exact: true });
const toggle = (page: Page) => page.getByRole('checkbox', { name: 'Add markup', exact: true });
const percentage = (page: Page) => page.getByLabel('Markup percentage', { exact: true });

async function prepare(page: Page, cookie?: string) {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
  await page.route('**/data/latest.json', (route) => route.fulfill({ json: fixture }));
  await page.route('**/data/history/*.json', (route) => {
    const code = route.request().url().split('/').pop()!.replace('.json', '');
    const points: [string, string][] = dates.map((date, index) => [
      date,
      historicalRates[code]?.[index] ?? '1',
    ]);
    return route.fulfill({ json: history(code, points) });
  });
  await page.route('https://api.frankfurter.dev/**', (route) => {
    const url = new URL(route.request().url());
    const codes = (url.searchParams.get('quotes') ?? '').split(',').filter(Boolean);
    const requestedDates = url.searchParams.has('from') ? dates : [dates[2]];
    return route.fulfill({
      json: requestedDates.flatMap((date) =>
        codes.map((code) => ({
          date,
          base: 'EUR',
          quote: code,
          rate: Number(
            url.searchParams.has('from')
              ? (historicalRates[code]?.[dates.indexOf(date)] ?? '1')
              : (fixture.rates[code]?.rate ?? '1'),
          ),
        })),
      ),
    });
  });
  if (cookie) {
    await page.context().addCookies([
      {
        name: 'exchange_converter_v1',
        value: cookie,
        domain: '127.0.0.1',
        path: '/exchange-converter/',
        sameSite: 'Lax',
      },
    ]);
  }
  await page.goto('./');
  await expect(baseAmount(page, 'GBP')).toBeVisible();
}

async function expectMarked(page: Page, code: string, value: string) {
  await expect(markedAmount(page, code)).toBeVisible();
  await expect
    .poll(async () =>
      (await markedAmount(page, code).innerText()).replaceAll(',', '').replace(code, '').trim(),
    )
    .toBe(value);
}

async function savedPayload(page: Page): Promise<unknown[] | null> {
  const cookie = (await page.context().cookies()).find(
    (entry) => entry.name === 'exchange_converter_v1',
  );
  return cookie ? JSON.parse(decodeURIComponent(cookie.value)) : null;
}

async function addYen(page: Page) {
  await page.getByRole('button', { name: /Add currency/ }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill('JPY');
  await page.getByRole('dialog').getByRole('button', { name: /JPY/ }).click();
  await expect(baseAmount(page, 'JPY')).toBeVisible();
}

test('starts disabled and adds correctly rounded read-only totals without changing base inputs', async ({
  page,
}) => {
  await prepare(page);
  await expect(toggle(page)).not.toBeChecked();
  await expect(percentage(page)).toBeDisabled();
  await expect(percentage(page)).toHaveValue('12.5');
  await expect(markedAmount(page, 'GBP')).toHaveCount(0);
  await toggle(page).check();
  await expect(percentage(page)).toBeEnabled();
  await expectMarked(page, 'GBP', '112.50');
  await expectMarked(page, 'USD', '168.75');
  await expectMarked(page, 'EUR', '140.63');
  await expect(baseAmount(page, 'GBP')).toHaveValue('100');
  await expect(baseAmount(page, 'USD')).toHaveValue('150.00');
  await expect(baseAmount(page, 'EUR')).toHaveValue('125.00');
  for (const code of ['GBP', 'USD', 'EUR']) {
    await expect(markedAmount(page, code)).toHaveJSProperty('tagName', 'OUTPUT');
    await expect(baseAmount(page, code)).toBeEditable();
  }
});

test('uses unrounded conversions and never compounds the markup when its controls change', async ({
  page,
}) => {
  await prepare(page);
  await toggle(page).check();
  await baseAmount(page, 'USD').fill('100');
  await expect(baseAmount(page, 'GBP')).toHaveValue('66.67');
  await expectMarked(page, 'GBP', '75.00');
  await expectMarked(page, 'USD', '112.50');
  await toggle(page).uncheck();
  await expect(markedAmount(page, 'GBP')).toHaveCount(0);
  await expect(baseAmount(page, 'USD')).toHaveValue('100');
  await expect(baseAmount(page, 'GBP')).toHaveValue('66.67');
  await toggle(page).check();
  await expectMarked(page, 'GBP', '75.00');
  await percentage(page).fill('20');
  await expectMarked(page, 'GBP', '80.00');
  await expectMarked(page, 'EUR', '100.00');
  await expectMarked(page, 'USD', '120.00');
  await toggle(page).uncheck();
  await toggle(page).check();
  await expectMarked(page, 'GBP', '80.00');
  await expect(baseAmount(page, 'USD')).toHaveValue('100');
});

test('accepts zero and the maximum percentage while invalid drafts retain the last valid totals', async ({
  page,
}) => {
  await prepare(page);
  await toggle(page).check();
  await percentage(page).fill('0');
  await expectMarked(page, 'GBP', '100.00');
  await expectMarked(page, 'USD', '150.00');
  await percentage(page).fill('1000');
  await expectMarked(page, 'GBP', '1100.00');
  await expectMarked(page, 'USD', '1650.00');
  await percentage(page).fill('12.5');
  for (const invalid of ['-1', '1000.1', 'Infinity', 'NaN', '1e2', '']) {
    await percentage(page).fill(invalid);
    await expect(percentage(page)).toHaveValue(invalid);
    await expect(percentage(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText('Enter a percentage from 0 to 1,000. Using the last valid percentage.', {
        exact: true,
      }),
    ).toBeVisible();
    await expectMarked(page, 'USD', '168.75');
    await expect(baseAmount(page, 'GBP')).toHaveValue('100');
  }
  await page.getByRole('heading', { name: /Your currencies/ }).click();
  await expect(percentage(page)).toHaveValue('12.5');
  await expect(percentage(page)).toHaveAttribute('aria-invalid', 'false');
});

test('restores both enabled and disabled markup preferences without losing the entered amount', async ({
  page,
}) => {
  await prepare(page);
  await baseAmount(page, 'EUR').fill('40');
  await toggle(page).check();
  await percentage(page).fill('7.5');
  await expect.poll(async () => (await savedPayload(page))?.[6]).toEqual([true, '7.5']);
  await page.reload();
  await expect(toggle(page)).toBeChecked();
  await expect(percentage(page)).toHaveValue('7.5');
  await expect(baseAmount(page, 'EUR')).toHaveValue('40');
  await expectMarked(page, 'USD', '51.60');
  await toggle(page).uncheck();
  await expect.poll(async () => (await savedPayload(page))?.[6]).toEqual([false, '7.5']);
  await page.reload();
  await expect(toggle(page)).not.toBeChecked();
  await expect(percentage(page)).toBeDisabled();
  await expect(percentage(page)).toHaveValue('7.5');
  await expect(markedAmount(page, 'USD')).toHaveCount(0);
  await toggle(page).check();
  await expectMarked(page, 'USD', '51.60');
  expect((await savedPayload(page))?.[0]).toBe(3);
});

test('applies custom rates before markup and keeps totals synchronized with currency cards', async ({
  page,
}) => {
  await prepare(page);
  await toggle(page).check();
  await addYen(page);
  await expectMarked(page, 'JPY', '22500');
  await page.getByRole('button', { name: 'Edit GBP exchange rate', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('0.6');
  await dialog.getByRole('button', { name: 'Save rate', exact: true }).click();
  await expect(baseAmount(page, 'USD')).toHaveValue('200.00');
  await expectMarked(page, 'USD', '225.00');
  await expect(baseAmount(page, 'JPY')).toHaveValue('26667');
  await expectMarked(page, 'JPY', '30000');
  await page.getByRole('button', { name: 'Remove JPY', exact: true }).click();
  await expect(markedAmount(page, 'JPY')).toHaveCount(0);
  await expectMarked(page, 'USD', '225.00');
  await addYen(page);
  await expectMarked(page, 'JPY', '30000');
  await baseAmount(page, 'JPY').fill('1.5');
  await expectMarked(page, 'JPY', '2');
});

test('preserves provider history, chart lines, and raw table values when markup changes', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Rates', exact: true }).click();
  const plot = page.getByTestId('comparison-chart');
  await expect(plot).toBeVisible();
  await page.getByText('View historical data', { exact: true }).click();
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  const initialTable = await table.innerText();
  const usdLine = plot.locator('path[data-series="USD"]');
  const initialPath = await usdLine.getAttribute('d');
  expect(initialPath).toBeTruthy();
  await toggle(page).check();
  await percentage(page).fill('50');
  await expectMarked(page, 'USD', '225.00');
  await expect(table).toHaveText(initialTable, { useInnerText: true });
  await expect(usdLine).toHaveAttribute('d', initialPath!);
  await expect(plot.locator('path[data-series]')).toHaveCount(2);
});

for (const version of [1, 2]) {
  test(`migrates a version ${version} cookie with markup disabled while preserving custom rates and chart choices`, async ({
    page,
  }) => {
    const cookie = encodeURIComponent(
      JSON.stringify([
        version,
        ['GBP', 'EUR', 'USD'].map((code) => [
          code,
          [fixture.rates[code].rate, fixture.rates[code].date, Date.parse(fixture.generatedAt)],
          code === 'GBP' ? ['0.6', Date.parse('2026-10-01T10:00:00Z')] : null,
        ]),
        'USD',
        '120',
        Date.parse('2026-10-01T10:00:00Z'),
        version === 1 ? ['EUR', 'GBP', '1Y'] : ['EUR', ['GBP', 'USD'], '1Y', 'rate'],
      ]),
    );
    await prepare(page, cookie);
    await expect(toggle(page)).not.toBeChecked();
    await expect(percentage(page)).toHaveValue('12.5');
    await expect(percentage(page)).toBeDisabled();
    await expect(baseAmount(page, 'USD')).toHaveValue('120');
    await expect(baseAmount(page, 'GBP')).toHaveValue('60.00');
    await expect(page.getByLabel('Reference currency', { exact: true })).toHaveValue('EUR');
    await expect(page.getByRole('button', { name: '1Y', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Rates', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page
        .getByRole('group', { name: 'Compare against', exact: true })
        .getByRole('checkbox', { name: 'GBP', exact: true }),
    ).toBeChecked();
    await toggle(page).check();
    await expectMarked(page, 'GBP', '67.50');
    await expectMarked(page, 'USD', '135.00');
    await expect.poll(async () => (await savedPayload(page))?.[0]).toBe(3);
    await page.reload();
    await expectMarked(page, 'GBP', '67.50');
    await expect(baseAmount(page, 'USD')).toHaveValue('120');
  });
}

test('clears markup with the rest of the saved session', async ({ page }) => {
  await prepare(page);
  await toggle(page).check();
  await percentage(page).fill('35');
  await expect.poll(async () => (await savedPayload(page))?.[6]).toEqual([true, '35']);
  await page.getByRole('button', { name: 'Clear saved state', exact: true }).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(percentage(page)).toHaveValue('12.5');
  await expect(markedAmount(page, 'GBP')).toHaveCount(0);
  expect(await savedPayload(page)).toBeNull();
});

test('supports keyboard controls and accessible mobile layouts with markup enabled', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await expect(toggle(page)).toBeChecked();
  await percentage(page).fill('24.75');
  await expectMarked(page, 'GBP', '124.75');
  await addYen(page);
  await expectMarked(page, 'JPY', '24950');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});
