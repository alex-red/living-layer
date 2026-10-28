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
  await expect(page.getByRole('heading', { name: 'Desk lab' })).toBeVisible();
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await expect(
    page.locator('.object-grid').getByRole('button', { name: /cream mug/ }),
  ).toBeVisible();
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
  await expect(
    page.locator('.object-grid').getByRole('button', { name: /cream mug/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/desk-fixture-mobile.png', fullPage: true });
});

test('remembers a mug, draws a zone, verifies one virtual action, and retains evidence on reload', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await page
    .locator('.object-grid')
    .getByRole('button', { name: /cream mug/ })
    .click();
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Mug identity manually confirmed');
  const before = await page.request.get('/api/desk/fixture');
  const objectId = (await before.json()).object.id;
  await page.getByRole('button', { name: 'Draw / edit zone' }).click();
  const overlay = page.getByLabel('Draw placement zone');
  await overlay.scrollIntoViewIfNeeded();
  const bounds = (await overlay.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.8, {
    steps: 6,
  });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save zone', exact: true }).click();
  await expect(page.getByLabel('Saved placement zone')).toBeVisible();
  await page.getByRole('button', { name: 'Verify placement · virtual lamp', exact: true }).click();
  await expect(page.locator('.placement-result')).toContainText('inside · lamp confirmed');
  await expect(page.locator('.placement-result')).toContainText('No Home Assistant request');
  await expect(page.locator('.readiness h3')).toHaveText('0 / 4');
  await page.screenshot({ path: '.data/screenshots/placement-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Verify placement · virtual lamp', exact: true }).click();
  await expect(page.locator('.placement-result')).toContainText('blocked · lamp none');
  await page.getByRole('button', { name: 'Draw / edit zone' }).click();
  for (const [field, value] of [
    ['x', '0'],
    ['y', '0'],
    ['width', '10'],
    ['height', '10'],
  ]) {
    await page.getByLabel(`Zone ${field} %`, { exact: true }).fill(value!);
  }
  await page.getByRole('button', { name: 'Save zone', exact: true }).click();
  await page.getByRole('button', { name: 'Verify placement · virtual lamp', exact: true }).click();
  await expect(page.locator('.placement-result')).toContainText('outside · lamp none');
  await page.reload();
  await expect(page.locator('.placement-result')).toContainText('outside · lamp none');
  await expect(
    page.getByRole('button', { name: 'Verify placement · virtual lamp', exact: true }),
  ).toBeDisabled();
  expect((await (await page.request.get('/api/desk/fixture')).json()).object.id).toBe(objectId);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/placement-mobile.png', fullPage: true });
});

test('draws the remembered mug in the isometric desk and follows it to a new frame', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Mug identity manually confirmed');
  await page.getByRole('button', { name: 'Iso', exact: true }).click();
  const mug = page.locator('[data-object="tracked"] ellipse');
  await expect(mug).toBeVisible();
  const before = Number(await mug.getAttribute('cx'));
  for (const preset of ['Office', 'Fridge', 'Desk'])
    await page.getByRole('button', { name: preset, exact: true }).click();
  await expect(page.locator('[data-prop="lamp"]')).toBeVisible();
  await page.getByRole('button', { name: 'Right', exact: true }).click();
  await page.getByRole('button', { name: 'Track the mug', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Tracked');
  // The fixture moves the mug 100 px right, which is towards +x on the desk.
  await expect.poll(async () => Number(await mug.getAttribute('cx'))).toBeGreaterThan(before);
  await expect(page.locator('.iso-trail')).toBeVisible();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await page.getByRole('button', { name: 'Sample a draft', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Item parts' }).getByRole('option')).toHaveCount(
    3,
  );
  await page.getByRole('button', { name: 'Colour #3c554a' }).click();
  await page.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save model', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Room', exact: true }).click();
  await expect(page.locator('[data-object="tracked"] [data-part="handle"]')).toBeVisible();
  await expect(page.locator('[data-object="tracked"] [data-part="body"] .top')).toHaveAttribute(
    'fill',
    '#3c554a',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/iso-mobile.png', fullPage: true });
});

test('drafts a custom room offline, saves it, and lights a rule’s lamp', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await page.getByRole('button', { name: 'Iso', exact: true }).click();
  await page.getByRole('button', { name: 'Edit scene', exact: true }).click();
  await page.getByRole('button', { name: 'Draft with Spark', exact: true }).click();
  await expect(page.locator('.scene-editor .iso-note')).toContainText('Spark:');
  await page.locator('.scene-canvas [data-prop="lamp"]').dispatchEvent('pointerdown');
  await page.getByLabel('Lamp light').selectOption('light.fixture_shelf');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Room', exact: true }).click();
  await page.getByRole('button', { name: 'Pin surface', exact: true }).click();
  const pin = page.locator('.pin-overlay');
  const box = (await pin.boundingBox())!;
  for (const [u, v] of [
    [0.02, 0.02],
    [0.98, 0.02],
    [0.98, 0.98],
    [0.02, 0.98],
  ])
    await page.mouse.click(box.x + u! * box.width, box.y + v! * box.height);
  await expect(page.locator('.feedback')).toContainText('Surface pinned');
  await page.getByRole('button', { name: 'Objects & rules', exact: true }).click();
  await page.getByRole('button', { name: 'Add a zone', exact: true }).click();
  await page.getByLabel('Rule light').selectOption('light.fixture_shelf');
  await page.getByLabel('Rule name').fill('Whole desk');
  const hit = (await page.locator('.iso-hit').boundingBox())!;
  await page.mouse.move(hit.x + hit.width / 2, hit.y + 12);
  await page.mouse.down();
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height - 12, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save rule', exact: true }).click();
  await page.getByRole('button', { name: 'Check rules', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Whole desk: inside, light confirmed');
  await expect(page.locator('[data-prop="lamp"] .iso-lamp.lit')).toBeVisible();
});
