import type { Shot } from '../lib/director.js';
import { draftedRoom } from './draft.js';

/**
 * 1:05: the desk is pinned already; a zone on it, watching the mug, switches
 * the lamp. The drafted demo room has no lamp model and its mug buttons don't
 * move the mug there, so the shot ends on Check zones: the zone fills and the
 * virtual lamp is confirmed. The real lamp turning on is the Live take's.
 */
export const zone: Shot = {
  name: 'zone',
  at: '1:05',
  about: 'a zone drawn on the pinned desk, watching the mug, switching the lamp',
  lines: [
    'The desk is pinned from the camera’s geometry.',
    'A zone on it: when the mug is here, the lamp turns on. When it leaves, it turns off.',
    'The mug is in it: the light is on.',
  ],
  async setup(d) {
    await draftedRoom(d);
    await d.page.getByRole('tab', { name: 'Office desk', exact: true }).click();
  },
  async run(d) {
    const first = d.sayOver(0);
    await d.focus(d.iso(), { pad: 0 });
    await d.click(d.outline(/^Desk top/));
    d.lower('PINNED', 'the desk top, from the calibrated corner camera');
    await d.until(first + 0.4);

    const second = d.sayOver(1);
    await d.focus(null);
    await d.click(d.outline('Add a zone'));
    await d.type(d.page.getByLabel('Zone name'), 'Mug on the desk');
    await d.click(d.inspector().getByRole('button', { name: 'Cream mug', exact: true }));
    const hit = (await d.page.locator('.iso-hit').boundingBox())!;
    const mug = (await d.page.locator('[data-object="tracked"]').first().boundingBox())!;
    await d.focus(d.iso(), { pad: 0 });
    // A screen drag runs along the desk's diagonals: drag down through the mug, as
    // the browser spec does, for a zone wide both ways round it.
    const x = mug.x + mug.width / 2;
    const y = mug.y + mug.height;
    await d.drag({ x, y: y - hit.height * 0.22 }, { x, y: y + hit.height * 0.18 }, 1.1);
    await d.wait(0.6);
    await d.focus(d.inspector(), {
      pad: 8,
      part: (b) => ({ ...b, height: Math.min(b.height, 560) }),
    });
    await d.wait(2.2);
    await d.click(d.button('Save zone'));
    await d.until(second);

    const third = d.sayOver(2);
    await d.focus(d.iso(), { pad: 0 });
    await d.click(d.button('Check zones'));
    await d.cue(d.page.locator('.feedback').filter({ hasText: /inside, light confirmed/ }), 10);
    d.lower('LIGHT ON', 'light.demo_desk · the demo’s virtual desk lamp', 3);
    await d.wait(1.2);
    await d.focus(d.page.locator('.feedback'), { pad: 40 });
    await d.wait(1.6);
    await d.focus(null);
    await d.until(Math.max(third, d.now()) + 1.2);
  },
};
