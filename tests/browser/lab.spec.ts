import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('fixture desk completes discovery, mask, absent target, lamp and export without external requests', async ({
  page,
}) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    if (!route.request().url().startsWith('http://127.0.0.1:4311')) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little context.' })).toBeVisible();
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await expect(page.getByRole('button', { name: /cream mug/ })).toBeVisible();
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await expect(page.getByLabel('1 segmentation masks')).toBeVisible();
  await expect(page.locator('.mask-overlay path')).toHaveCount(1);
  await page.screenshot({ path: '.data/screenshots/desk-fixture-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Test absent target' }).click();
  await expect(page.getByLabel('0 segmentation masks')).toBeVisible();
  await expect(page.locator('.mask-overlay path')).toHaveCount(0);
  await page.getByRole('button', { name: 'Simulate lamp action', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Fixture lamp probe saved');
  await expect(page.locator('.readiness h3')).toHaveText('0 / 4');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export evidence' }).click();
  expect((await download).suggestedFilename()).toBe('livinglayer-evidence.json');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('live probes stay disabled without setup; uploads prepare locally and camera denial has a fallback', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Discover objects', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Turn on desk lamp' })).toBeDisabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'desk.png',
    mimeType: 'image/png',
    buffer: await sharp({ create: { width: 640, height: 480, channels: 3, background: '#d7d3c5' } })
      .png()
      .toBuffer(),
  });
  await expect(page.getByAltText('Your prepared desk photo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discover objects', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Camera', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Upload a desk photo instead');
});

test('mobile workbench fits its viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await expect(page.getByRole('button', { name: /cream mug/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/desk-fixture-mobile.png', fullPage: true });
});
