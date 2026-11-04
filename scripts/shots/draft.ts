import type { Locator } from '@playwright/test';
import type { Director, Shot } from '../lib/director.js';

/** Start drafting the room from the demo camera's frame, by hand on camera. */
async function startDraft(d: Director, onCamera: boolean) {
  const go = (target: Locator) => (onCamera ? d.click(target) : target.click());
  await go(
    d.page
      .getByRole('group', { name: 'Choose a scene' })
      .getByRole('button', { name: 'Draft from the demo photo' }),
  );
  await go(d.button('Layout'));
  await go(d.button('Demo frame'));
}

/** The review's Save button: "Save scene and track 1", 2… */
const save = (d: Director) => d.button(/^Save scene and track \d/);
const saved = (d: Director) =>
  d.page.locator('.feedback').filter({ hasText: /Scene saved from the photo/ });

/** Off camera: a fresh demo drafted from its frame and saved, tracking the mug. */
export async function draftedRoom(d: Director) {
  await d.freshDemo();
  await startDraft(d, false);
  await d.task('Drafting the room');
  await save(d).click();
  await saved(d).waitFor();
  // The finished draft's summary card stays in a corner until dismissed.
  const dismiss = d.button('Dismiss');
  if (await dismiss.count()) await dismiss.first().click();
}

/** 0:35: a frame of the corner camera becomes the room, its things outlined, placed and modelled. */
export const draft: Shot = {
  name: 'draft',
  at: '0:35',
  about: 'the demo frame drafted, reviewed, saved, tracking the mug',
  lines: [
    'One frame from the corner camera. Spark lists what’s in the room. SAM outlines all of it in one call.',
    'Code measures the rest: the camera, the desk, where each thing stands, its model.',
    'Tick the mug, save, and it’s tracked.',
  ],
  async setup(d) {
    await d.freshDemo();
  },
  async run(d) {
    await d.wait(0.4);
    const first = d.sayOver(0);
    await startDraft(d, true);
    const steps = d.page.getByRole('dialog', { name: 'Drafting the room' });
    await d.task('Drafting the room', { close: false });
    await d.focus(steps.getByRole('list'), { pad: 16 });
    d.lower('MUSE SPARK 1.3', 'lists what is in the room');
    await d.wait(2);
    d.lower('SAM 3.1', 'outlines every thing in one call', 3);
    await d.until(first + 0.3);

    const second = d.sayOver(1);
    await d.focus(null);
    await d.task('Drafting the room');
    await d.focus(d.page.locator('.photo-review'), { pad: 8 });
    await d.until(second + 0.2);

    const third = d.sayOver(2);
    await d.focus(d.page.locator('.photo-things'), { pad: 12 });
    const tick = d.page
      .locator('.photo-things tbody tr')
      .filter({ hasText: 'cream mug' })
      .getByRole('checkbox');
    const b = (await tick.boundingBox())!;
    await d.glide(b.x + b.width / 2, b.y + b.height / 2);
    await d.wait(0.6);
    await d.click(save(d));
    await d.focus(null);
    await saved(d).waitFor();
    await d.until(Math.max(third, d.now()) + 1.8);
  },
};
