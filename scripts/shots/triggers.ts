import type { Director, Shot } from '../lib/director.js';
import { draftedRoom } from './draft.js';

const API = process.env.LAB_API ?? 'http://127.0.0.1:43431';

/**
 * Off camera: the drafted demo office, its camera marked fixed (so motion and
 * presence can be judged), on the office desk.
 */
export async function fixedDesk(d: Director) {
  await draftedRoom(d);
  const res = await fetch(`${API}/api/desk/camera`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'demo', fixed: true }),
  });
  if (!res.ok) throw new Error(`Marking the demo camera fixed: ${res.status}`);
  await d.page.getByRole('tab', { name: 'Office desk', exact: true }).click();
}

/**
 * Draw a zone round where the mug stands on the iso desk: tight, so the mug fills
 * enough of it for presence to tell it from empty.
 */
export async function drawMugZone(d: Director, seconds = 0.9) {
  const hit = (await d.page.locator('.iso-hit').boundingBox())!;
  const mug = (await d.page.locator('[data-object="tracked"]').first().boundingBox())!;
  const x = mug.x + mug.width / 2;
  const y = mug.y + mug.height;
  await d.drag(
    { x, y: y - hit.height * 0.07 },
    { x: x + hit.width * 0.01, y: y + hit.height * 0.03 },
    seconds,
  );
}

/**
 * After the real-room clips: what a zone can watch (one thing, any thing, motion)
 * and what it can do (switch, desktop, wait, if), then the mug moved in and the
 * demo's desk lamp switching on.
 */
export const triggers: Shot = {
  name: 'triggers',
  at: '0:33',
  about: 'what a zone can watch and do, then the mug in and the desk lamp on',
  lines: [
    'Anything the camera can see can be a trigger. A thing, any thing, or just movement.',
    'Draw where. Then pick what happens: a light, a screen, a page, a pause.',
    'Move the mug in, and the desk lamp answers.',
  ],
  async setup(d) {
    await fixedDesk(d);
    // The mug starts away from where the zone will be.
    await d.button('Right').click();
    await d.wait(1.5);
  },
  async run(d) {
    const inspector = d.inspector();

    const first = d.sayOver(0);
    await d.click(d.outline('Add a zone'));
    await d.type(d.page.getByLabel('Zone name'), 'Mug on the desk', 0.04);
    await d.focus(inspector, { pad: 8, part: (b) => ({ ...b, height: Math.min(b.height, 420) }) });
    await d.click(inspector.getByRole('button', { name: 'Cream mug', exact: true }));
    d.lower('ONE THING', 'the mug, and only the mug', 1.6);
    await d.wait(1.3);
    await d.click(inspector.getByRole('button', { name: 'Anything', exact: true }));
    d.lower('ANY THING', 'whatever the camera follows', 1.6);
    await d.wait(1.3);
    await d.click(d.button('Motion'));
    d.lower('MOTION', 'pixels moving · no model call', 1.6);
    await d.wait(1.3);
    await d.click(d.button('Things inside'));
    await d.click(inspector.getByRole('button', { name: 'Cream mug', exact: true }));
    await d.until(first);

    const second = d.sayOver(1);
    await d.focus(d.iso(), { pad: 0 });
    await d.button('Centre').click();
    await d.wait(0.6);
    await drawMugZone(d);
    await d.button('Right').click();
    await d.wait(0.4);
    await d.focus(inspector, {
      pad: 8,
      part: (b) => ({ ...b, y: b.y + b.height * 0.3, height: b.height * 0.5 }),
    });
    await d.click(inspector.getByRole('button', { name: '+ Add step' }).first());
    await d.wait(1.8);
    // The same button closes the menu, adding nothing.
    await d.click(inspector.getByRole('button', { name: '+ Add step' }).first());
    await d.wait(0.4);
    await d.click(d.button('Save zone'));
    await d.until(second);

    const third = d.sayOver(2);
    await d.focus(null);
    await d.click(d.button('Centre'));
    await d.wait(0.5);
    await d.click(d.button('Check zones'));
    await d.cue(d.page.locator('.feedback').filter({ hasText: /inside, light confirmed/ }), 15);
    d.lower('LIGHT ON', 'light.demo_desk · the demo’s virtual desk lamp', 2.4);
    await d.focus(d.page.locator('aside.ws-outline'), {
      pad: 8,
      part: (b) => ({ ...b, height: Math.min(b.height, 380) }),
    });
    await d.until(Math.max(third, d.now()) + 1);
  },
};
