/**
 * What the browser specs share: picking a scene, the outline and inspector,
 * a fresh desk, and waiting out an AI task. An AI task's steps show in a
 * modal `<dialog>`, which makes the rest of the page inert while it is open,
 * so a spec waits for it with `waitForAiTask` before typing into a panel.
 */
import { expect, test, type Page } from '@playwright/test';

/** The workspace opens on a choice of room; the demo office is seen by its corner camera. */
export async function chooseScene(page: Page, name = 'Use the demo office') {
  await page
    .getByRole('group', { name: 'Choose a scene' })
    .getByRole('button', { name, exact: true })
    .click();
}
/** A row of the scene outline. */
export const outline = (page: Page, name: string) =>
  page
    .getByRole('complementary', { name: 'Scene outline' })
    .getByRole('button', { name, exact: true });
/** Add a thing from the outline's menu: one the camera follows, or a fixture placed by hand. */
async function addThing(page: Page, how: string) {
  await outline(page, 'Add a thing').click();
  await page.getByRole('menuitem', { name: how, exact: true }).click();
}
/** Open the inspector's Add an object panel. */
export const addObject = (page: Page) => addThing(page, 'Follow it with the camera');
/** Open the inspector's new fixture panel. */
export const addFixture = (page: Page) => addThing(page, 'Place a fixture by hand');
/** Start a new zone from the outline. */
export const addZone = (page: Page) => outline(page, 'Add a zone').click();
/** A step of the outline's setup card. */
export const setupStep = (page: Page, name: string) =>
  page
    .getByRole('region', { name: 'Setting up this scene' })
    .getByRole('button', { name, exact: true });
/** Work in the whole room or its close view, from the outline's tabs. */
export const sceneTab = (page: Page, name: string) =>
  page
    .getByRole('complementary', { name: 'Scene outline' })
    .getByRole('tab', { name, exact: true })
    .click();
/** Select the room itself, from the breadcrumb's first step. */
export const openRoom = (page: Page) =>
  page.getByRole('navigation', { name: 'You are here' }).getByRole('button').first().click();
/** Unfold Home Assistant at the foot of the outline. */
export const homeAssistant = (page: Page) =>
  page.getByRole('complementary', { name: 'Scene outline' }).locator('.ol-ha > summary').click();
export const readiness = (page: Page) =>
  page.getByRole('button', { name: 'Readiness and spending' }).click();

/**
 * The browser tests share one data directory across a run, so start the iso
 * tests from a desk with no object, model, rules, custom scene or pin.
 */
export async function freshDesk(page: Page) {
  for (const [path, data] of [
    ['desk/reset', {}],
    ['scene/save', { scene: null }],
    ['desk/surface', { pin: null }],
  ] as const)
    expect(
      (await page.request.post(`/api/${path}`, { data: { mode: 'demo', ...data } })).ok(),
    ).toBe(true);
}

/**
 * Let tracking call SAM and Spark (_Let tracking call AI_), as the unit tests'
 * `testApp` does: finding objects by name is refused without it, in demo mode too.
 */
export async function trackingAi(page: Page, on = true) {
  expect((await page.request.post('/api/settings/tracking-ai', { data: { on } })).ok()).toBe(true);
}

/** The AI steps dialog of a task, by its title. */
export const aiTaskDialog = (page: Page, title: string | RegExp) =>
  page.getByRole('dialog', { name: title });

/** Why the AI task failed, from its dialog, or null when it hasn't (or isn't open). */
export async function aiTaskFailed(page: Page, title: string | RegExp): Promise<string | null> {
  const dialog = aiTaskDialog(page, title);
  if (!(await dialog.count()) || !(await dialog.evaluate((d) => d.classList.contains('failed'))))
    return null;
  const alert = dialog.getByRole('alert');
  return (await alert.count()) ? (await alert.innerText()).trim() : 'failed, with no reason shown';
}

/**
 * Wait for an AI task to finish and its dialog to close: a clean finish
 * closes itself after a moment, and one that stays (to review its steps) is
 * closed with Done. A failure throws with its reason, so a spec doesn't go
 * on to type into a page the dialog has made inert.
 */
export async function waitForAiTask(
  page: Page,
  title: string | RegExp,
  { timeout = 20_000 }: { timeout?: number } = {},
) {
  // One boxed step: the trace and the report show the wait, not its polling.
  await test.step(
    `wait for the AI task "${title}"`,
    async () => {
      const dialog = aiTaskDialog(page, title);
      // It opens as the request starts; one that has already come and gone is fine too.
      await dialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
      await expect
        .poll(
          async () =>
            !(await dialog.count()) || (await dialog.getAttribute('aria-busy')) !== 'true'
              ? 'ended'
              : 'running',
          { timeout, message: `the AI task "${title}" to end` },
        )
        .toBe('ended');
      const failed = await aiTaskFailed(page, title);
      if (failed) throw new Error(`The AI task "${title}" failed: ${failed}`);
      // The footer's Done (or Close), not the × in its header. A clean finish may
      // close itself meanwhile, so a click that misses is fine once it has gone.
      const done = dialog.getByRole('button', { name: /^(Done|Close)$/ }).last();
      if (await dialog.count())
        await done.click({ timeout: 3_000 }).catch(async (e: unknown) => {
          if (await dialog.count()) throw e;
        });
      await expect(dialog, `the AI task "${title}" closes`).toHaveCount(0);
    },
    { box: true },
  );
}
