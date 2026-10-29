import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

/** The lab opens on a choice of room; the demo office holds the illustrated desk. */
async function chooseScene(page: Page, name = 'Use the demo office') {
  await page
    .getByRole('group', { name: 'Choose a scene' })
    .getByRole('button', { name, exact: true })
    .click();
}
/** A row of the scene outline. */
const outline = (page: Page, name: string) =>
  page
    .getByRole('complementary', { name: 'Scene outline' })
    .getByRole('button', { name, exact: true });
/** Open the inspector's Add an object panel. */
const addObject = (page: Page) => outline(page, 'Add object').click();
const readiness = (page: Page) =>
  page.getByRole('button', { name: 'Readiness and spending' }).click();

test('demo desk completes discovery, mask, absent target, lamp and export without external requests', async ({
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
  // Scene first: the lab opens on the choice of room, and nothing runs until one is chosen.
  await expect(page.getByRole('group', { name: 'Choose a scene' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discover objects', exact: true })).toHaveCount(0);
  await chooseScene(page);
  await expect(page.locator('.crumbs')).toContainText('Office');
  await addObject(page);
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await expect(
    page.locator('.object-grid').getByRole('button', { name: /cream mug/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await expect(page.getByLabel('1 segmentation masks')).toBeVisible();
  await expect(page.locator('.mask-overlay path')).toHaveCount(1);
  await page.screenshot({ path: '.data/screenshots/desk-demo-desktop.png', fullPage: true });
  await page.getByText('Check for false matches').click();
  await page.getByRole('button', { name: 'Test absent target' }).click();
  await expect(page.getByLabel('0 segmentation masks')).toBeVisible();
  await expect(page.locator('.mask-overlay path')).toHaveCount(0);
  await readiness(page);
  await page.getByRole('button', { name: 'Simulate lamp action', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Demo lamp probe saved');
  await expect(page.locator('.readiness h3')).toHaveText('0 / 4');
  await page.keyboard.press('Escape');
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
  await chooseScene(page);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  // Live, the office desk still needs a close photo before anything is pinned.
  await expect(page.getByRole('note', { name: 'Set up the office desk' })).toBeVisible();
  await addObject(page);
  await expect(page.getByRole('button', { name: 'Discover objects', exact: true })).toBeDisabled();
  await readiness(page);
  await expect(page.getByRole('button', { name: 'Turn on desk lamp' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByLabel('Desk photo to upload').setInputFiles({
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await chooseScene(page);
  // On a phone the outline is a sheet: open it from the top bar, pick a row, and it closes.
  await page.getByRole('button', { name: 'Scene outline' }).click();
  await addObject(page);
  await expect(page.getByRole('button', { name: 'Scene outline' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await expect(
    page.locator('.object-grid').getByRole('button', { name: /cream mug/ }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/desk-demo-mobile.png', fullPage: true });
});

test('remembers a mug, draws a zone, verifies one virtual action, and retains evidence on reload', async ({
  page,
}) => {
  await page.goto('/');
  await chooseScene(page);
  await addObject(page);
  await page.getByRole('button', { name: 'Discover objects', exact: true }).click();
  await page
    .locator('.object-grid')
    .getByRole('button', { name: /cream mug/ })
    .click();
  // A suggestion opens in the inspector, ready to outline.
  await page.getByRole('button', { name: 'Find its outline', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Mug identity manually confirmed');
  const before = await page.request.get('/api/desk/demo');
  const objectId = (await before.json()).object.id;
  await outline(page, 'Main zone').click();
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
  await expect(page.locator('.insp-status')).toContainText('The virtual lamp turned on');
  await page.screenshot({ path: '.data/screenshots/placement-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Verify placement · virtual lamp', exact: true }).click();
  // The lamp fires only on entering: a second check while still inside takes no action.
  await expect(page.locator('.placement-result')).toContainText('inside · lamp none');
  await expect(page.locator('.placement-result')).toContainText('Still inside');
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
  // The scene is remembered by this browser and the selection by the URL, so the
  // lab skips the picker and reopens the zone.
  await expect(page.locator('.crumbs')).toContainText('Office');
  await expect(page.getByRole('group', { name: 'Choose a scene' })).toHaveCount(0);
  await expect(page.locator('.placement-result')).toContainText('outside · lamp none');
  await expect(
    page.getByRole('button', { name: 'Verify placement · virtual lamp', exact: true }),
  ).toBeDisabled();
  expect((await (await page.request.get('/api/desk/demo')).json()).object.id).toBe(objectId);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/placement-mobile.png', fullPage: true });
});

/**
 * The browser tests share one data directory across runs, so start the iso
 * tests from a desk with no object, model, rules, custom scene or pin.
 */
async function freshDesk(page: Page) {
  for (const [path, data] of [
    ['desk/reset', {}],
    ['scene/save', { scene: null }],
    ['desk/surface', { pin: null }],
  ] as const)
    expect(
      (await page.request.post(`/api/${path}`, { data: { mode: 'demo', ...data } })).ok(),
    ).toBe(true);
}

test('draws the remembered mug in the isometric desk and follows it to a new frame', async ({
  page,
}) => {
  await freshDesk(page);
  await page.goto('/');
  await chooseScene(page);
  await addObject(page);
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Mug identity manually confirmed');
  await page.getByRole('button', { name: 'Iso', exact: true }).click();
  // The first ellipse is the top of the mug, plain marker or model body.
  const mug = page.locator('[data-object="tracked"] ellipse').first();
  // The office desk is the office's desk, so its pin places the mug in the office too.
  await outline(page, 'Office').click();
  await expect(mug).toBeVisible();
  await outline(page, 'Office desk').click();
  await expect(page.locator('[data-prop="lamp"]')).toBeVisible();
  await expect(mug).toBeVisible();
  const before = Number(await mug.getAttribute('cx'));
  await page.getByRole('button', { name: 'Right', exact: true }).click();
  await page.getByRole('button', { name: /^Open My desk mug/ }).click();
  await page.getByRole('button', { name: 'Track the mug', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Tracked');
  // The demo moves the mug 100 px right, which is towards +x on the desk.
  await expect.poll(async () => Number(await mug.getAttribute('cx'))).toBeGreaterThan(before);
  await expect(page.locator('.iso-trail')).toBeVisible();
  await page.getByRole('button', { name: /^Edit model/ }).click();
  await page.getByRole('button', { name: 'Sample a draft', exact: true }).click();
  // The fitter measures a turned body and a handle from the illustrated mug.
  await expect(page.getByRole('listbox', { name: 'Item parts' }).getByRole('option')).toHaveCount(
    2,
  );
  await expect(page.locator('.item-fit')).toContainText('MATCH');
  await page.getByRole('button', { name: 'Photo vs model', exact: true }).click();
  await expect(page.getByAltText("The model's silhouette from the photo's camera")).toBeVisible();
  await page.getByRole('button', { name: 'Model', exact: true }).last().click();
  await page.getByRole('button', { name: 'Colour #3c554a' }).click();
  await page.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save model', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Room', exact: true }).click();
  // The model is one pixel-art sprite; the group lists the parts it was built from.
  const model = page.locator('[data-object="tracked"] .iso-item');
  await expect(model.locator('image')).toBeVisible();
  await expect(model).toHaveAttribute('data-parts', 'body handle');
  await expect(model).toHaveAttribute('data-colors', /^#3c554a /);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/iso-mobile.png', fullPage: true });
});

test('finds the office desk’s corners from the photo, lets one be dragged, and saves the pin', async ({
  page,
}) => {
  await freshDesk(page);
  await page.goto('/');
  await chooseScene(page);
  await outline(page, 'Office desk').click();
  // The demo desk comes pinned; finding it again measures the corners from SAM's outline.
  await page.getByRole('button', { name: 'Find it again', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Found the desktop');
  const corners = page.getByRole('slider', { name: /corner$/ });
  await expect(corners).toHaveCount(4);
  const front = page.getByRole('slider', { name: 'front right corner' });
  const before = await front.getAttribute('aria-valuetext');
  // The corner sits on the photo's bottom-right edge; press just inside it.
  const photo = (await page.locator('.pin-overlay').boundingBox())!;
  const [cx, cy] = [photo.x + photo.width - 4, photo.y + photo.height - 4];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 30, cy - 30, { steps: 4 });
  await page.mouse.up();
  await expect(front).not.toHaveAttribute('aria-valuetext', before!);
  await page.getByRole('button', { name: 'Save pin', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Surface pinned');
  const desk = await (await page.request.get('/api/desk/demo')).json();
  expect(desk.surface.surfaceId).toBe('desk:top');
  expect(desk.surface.scene).toBe('desk');
});

test('drafts a custom room offline, saves it, and lights a rule’s lamp', async ({ page }) => {
  await freshDesk(page);
  await page.goto('/');
  await chooseScene(page);
  await addObject(page);
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await page.getByRole('button', { name: 'Iso', exact: true }).click();
  await outline(page, 'Office').click();
  await page.getByRole('button', { name: 'Edit layout', exact: true }).click();
  await page.getByRole('button', { name: 'Draft with Spark', exact: true }).click();
  await expect(page.locator('.scene-editor .iso-note')).toContainText('Spark:');
  await page.locator('.scene-canvas [data-prop="lamp"]').dispatchEvent('pointerdown');
  await page.getByLabel('Lamp light').selectOption('light.demo_shelf');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  // The saved scene is the room now; it has no close view, so its surfaces sit right under it.
  await expect(outline(page, 'Drafted room')).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'Room', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Scene outline' })
    .locator('.ol-row')
    .filter({ hasText: 'not pinned' })
    .first()
    .click();
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
  await outline(page, 'Add rule').click();
  await page.getByLabel('Rule light').selectOption('light.demo_shelf');
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

test('drafts a scene from the illustrated desk, reviews the pin and objects, and saves it in one go', async ({
  page,
}) => {
  await freshDesk(page);
  await page.goto('/');
  // The second way in: draft the room from a photo, here the demo photo.
  await chooseScene(page, 'Draft from the demo photo');
  await page.getByRole('button', { name: 'Draft from the illustrated desk', exact: true }).click();
  const rows = page.locator('.photo-things tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('pinned surface');
  await expect(page.locator('.photo-review .iso-note')).toContainText('Scene match');
  // With nothing remembered yet, the mug is offered as the main object.
  const mug = rows.filter({ hasText: 'cream mug' });
  await expect(mug.getByRole('checkbox')).toBeChecked();
  await expect(mug).toContainText('main');
  await rows.filter({ hasText: 'sage bottle' }).getByRole('checkbox').check();
  // A dragged corner lays the scene out again.
  // Corner 3 sits on the photo's bottom-right edge; press just inside it.
  const photo = (await page.locator('.photo-review-photo svg').boundingBox())!;
  const [cx, cy] = [photo.x + photo.width - 4, photo.y + photo.height - 4];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 30, cy - 30, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('slider', { name: 'Pin corner 3' })).not.toHaveAttribute(
    'aria-valuetext',
    '960, 640',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/photo-review-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Save scene and track 2', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText(
    'Scene saved from the photo, pinned, tracking 2 objects',
  );
  await expect(
    page.getByRole('complementary', { name: 'Scene outline' }).getByText('from your photo'),
  ).toBeVisible();
  await expect(page.locator('[data-object="tracked"] .iso-item image')).toBeVisible();
});

test('saves the session as you go, undoes a desk edit, and resets to the demo', async ({
  page,
}) => {
  await freshDesk(page);
  await page.goto('/');
  await chooseScene(page);
  await page.getByRole('button', { name: 'Iso', exact: true }).click();
  await addObject(page);
  await page.getByRole('button', { name: 'Segment object', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm mug mask #7', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Mug identity manually confirmed');
  // Undo puts the desk back as it was: no mug remembered.
  await page.locator('body').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.locator('.feedback')).toContainText('Undone');
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.locator('.feedback')).toContainText('Redone');
  // The view and the scene come back after a reload.
  await page.reload();
  await expect(page.locator('.crumbs')).toContainText('Office');
  await expect(page.getByRole('button', { name: 'Iso', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'More' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export save', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^livinglayer-save-.*\.json$/);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Reset everything to demo', exact: true }).click();
  await expect(page.locator('.feedback')).toContainText('Reset to the demo');
  await expect(page.getByRole('group', { name: 'Choose a scene' })).toBeVisible();
});

test('a fixture is drafted from the demo mouse, placed on the office desk and selected', async ({
  page,
}) => {
  await page.goto('/');
  await chooseScene(page);
  await outline(page, 'Add fixture').click();
  await expect(
    page.getByRole('heading', { name: 'Start from a photo of the thing' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Computer mouse/ }).click();
  await expect(page.getByRole('heading', { name: 'Computer mouse' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Just a thing', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByLabel('Room').selectOption({ label: 'Office desk' });
  await page.getByRole('button', { name: 'Place it' }).click();
  const hit = page.getByLabel('Place the computer mouse');
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(outline(page, 'Computer mouse')).toBeVisible();
  await expect(page.locator('[data-fixture]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Move' })).toBeVisible();
});
