import type { Shot } from '../lib/director.js';
import { draftedRoom } from './draft.js';

/**
 * 1:05: the desk is pinned already; a zone on it, watching the mug, switches
 * the lamp. The lamp turning on is the Live take's (the real lamp): in the
 * drafted demo room "Check zones" reads the mug as outside a zone drawn over it.
 */
export const zone: Shot = {
  name: 'zone',
  at: '1:05',
  about: 'a zone drawn on the pinned desk, watching the mug, switching the lamp',
  lines: [
    'The desk is pinned from the camera’s geometry.',
    'A zone on it: when the mug is here, the lamp turns on. When it leaves, it turns off.',
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
    await d.focus(d.iso(), { pad: 0 });
    await d.drag(
      { x: hit.x + hit.width * 0.35, y: hit.y + hit.height * 0.25 },
      { x: hit.x + hit.width * 0.75, y: hit.y + hit.height * 0.7 },
      1.1,
    );
    await d.wait(0.6);
    await d.focus(d.inspector(), {
      pad: 8,
      part: (b) => ({ ...b, height: Math.min(b.height, 560) }),
    });
    await d.wait(2.2);
    await d.click(d.button('Save zone'));
    await d.focus(null);
    await d.until(Math.max(second, d.now()) + 1.4);
  },
};
