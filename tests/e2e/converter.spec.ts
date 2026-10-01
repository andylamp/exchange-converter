import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { fixture } from '../fixtures';

let providerDate = '2026-09-30';
async function prepare(page: Page, options: { offlineProvider?: boolean } = {}) {
  await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
  await page.route('**/data/latest.json', (route) => route.fulfill({ json: fixture }));
  await page.route('**/data/history/*.json', (route) => {
    const code = route.request().url().split('/').pop()!.replace('.json', '');
    return route.fulfill({
      json: {
        schemaVersion: 1,
        base: 'EUR',
        quote: code,
        generatedAt: fixture.generatedAt,
        points: ['2026-09-01', '2026-09-15', '2026-09-30'].map((date) => [
          date,
          fixture.rates[code]?.rate ?? '1',
        ]),
      },
    });
  });
  await page.route('https://api.frankfurter.dev/**', async (route) => {
    if (options.offlineProvider) return route.abort('failed');
    const url = new URL(route.request().url());
    const codes = url.searchParams.get('quotes')!.split(',');
    const dates = url.searchParams.has('from')
      ? ['2026-09-01', '2026-09-15', providerDate]
      : [providerDate];
    return route.fulfill({
      json: dates.flatMap((date) =>
        codes.map((code) => ({
          date,
          base: 'EUR',
          quote: code,
          rate: Number(fixture.rates[code]?.rate ?? 1),
        })),
      ),
    });
  });
  await page.goto('./');
  await expect(page.getByLabel('GBP amount')).toHaveValue('100');
  await expect(page.getByRole('button', { name: 'Refresh rates', exact: true })).toBeEnabled();
}
test.beforeEach(() => {
  providerDate = '2026-09-30';
});

test('converts every field, preserves incomplete input, and restores the session', async ({
  page,
}) => {
  await prepare(page);
  await expect(page.getByLabel('USD amount')).toHaveValue('150.00');
  const usd = page.getByLabel('USD amount');
  await usd.fill('12.34');
  await expect(usd).toBeFocused();
  await expect(page.getByLabel('GBP amount')).toHaveValue('8.23');
  await usd.fill('-');
  await expect(usd).toHaveValue('-');
  await expect(page.getByLabel('GBP amount')).toHaveValue('8.23');
  await usd.fill('-12.34');
  await page.getByRole('heading', { name: /Your currencies/ }).click();
  await page.reload();
  await expect(page.getByLabel('USD amount')).toHaveValue('-12.34');
  await expect(page.getByLabel('GBP amount')).toHaveValue('-8.23');
  const cookies = await page.context().cookies();
  const cookie = cookies.find((c) => c.name === 'exchange_converter_v1');
  expect(cookie?.path).toBe('/exchange-converter/');
  expect(cookie?.sameSite).toBe('Lax');
  expect((cookie?.name.length ?? 0) + (cookie?.value.length ?? 0) + 1).toBeLessThanOrEqual(3500);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('supports currency selection and a zero-decimal currency', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: /Add currency/ }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill('JPY');
  await page.getByRole('dialog').getByRole('button', { name: /JPY/ }).click();
  await expect(page.getByLabel('JPY amount')).toHaveValue('20000');
  await page.getByLabel('JPY amount').fill('160');
  await expect(page.getByLabel('EUR amount')).toHaveValue('1.00');
  await page.getByRole('button', { name: 'Remove JPY', exact: true }).click();
  await expect(page.getByLabel('JPY amount')).toHaveCount(0);
  await expect(page.getByLabel('GBP amount')).toHaveValue('0.8');
});

test('custom rates survive same-day refresh and expire with newer observations', async ({
  page,
}) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Edit GBP exchange rate', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('0.6');
  await dialog.getByRole('button', { name: /Save/ }).click();
  await expect(page.getByLabel('USD amount')).toHaveValue('200.00');
  await page.getByRole('button', { name: 'Refresh rates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh rates', exact: true })).toBeEnabled();
  await expect(page.getByLabel('USD amount')).toHaveValue('200.00');
  await page.reload();
  await expect(page.getByLabel('USD amount')).toHaveValue('200.00');
  await page.clock.setFixedTime(new Date('2026-10-02T12:00:00Z'));
  providerDate = '2026-10-02';
  await page.getByRole('button', { name: 'Refresh rates', exact: true }).click();
  await expect(page.getByLabel('USD amount')).toHaveValue('150.00');
  await expect(
    page.getByRole('status').filter({ hasText: /replaced your custom rates/ }),
  ).toBeVisible();
});

test('uses bundled rates and history through a provider outage', async ({ page }) => {
  await prepare(page, { offlineProvider: true });
  await expect(page.getByText(/provider is unavailable/)).toBeVisible();
  await page.getByLabel('GBP amount').fill('20');
  await expect(page.getByLabel('USD amount')).toHaveValue('30.00');
  await expect(page.locator('svg[role="img"]')).toBeVisible();
});

test('clears saved state without immediately recreating its cookie', async ({ page }) => {
  await prepare(page);
  await page.getByLabel('GBP amount').fill('25');
  await page.getByRole('button', { name: 'Clear saved state', exact: true }).click();
  await expect(page.getByLabel('GBP amount')).toHaveValue('100');
  expect((await page.context().cookies()).some((c) => c.name === 'exchange_converter_v1')).toBe(
    false,
  );
  await page.reload();
  await expect(page.getByLabel('GBP amount')).toHaveValue('100');
  expect((await page.context().cookies()).some((c) => c.name === 'exchange_converter_v1')).toBe(
    false,
  );
});

test('remains usable when cookies are blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'cookie', {
      get: () => '',
      set: () => undefined,
      configurable: true,
    });
  });
  await prepare(page);
  await page.getByLabel('GBP amount').fill('25');
  await expect(page.getByLabel('USD amount')).toHaveValue('37.50');
  await expect(page.getByText(/could not save these preferences/)).toBeVisible();
});

test('is accessible and fits mobile layouts in both color schemes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page);
  await expect(page.locator('svg[role="img"]')).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.getByRole('button', { name: /Add currency/ }).click();
  await expect(page.getByRole('dialog').getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Add currency/ })).toBeFocused();
});
