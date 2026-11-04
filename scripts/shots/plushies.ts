import type { Shot } from '../lib/director.js';
import { liveOffice } from './remembers.js';

/**
 * Scene 2 (0:14), Live: a motion zone drawn round the pink plushie, its step
 * turning the colour bulb pink. The zone is the one the room already has
 * ("Pink plushie"), drawn again for the camera and cancelled after the cut,
 * so the lab is left as it was. With `--cue` it then asks for a poke aloud
 * and waits for the real zone to read moving; without, it ends on the step.
 */
export const plushies: Shot = {
  name: 'plushies',
  at: '0:14',
  about: 'Live: a motion zone round the pink plushie switches the colour bulb',
  lines: [
    'That’s my office, through one ordinary camera in the corner.',
    'Draw a box around a plushie. Tell it what to do.',
    'Poke it, and it’s a light switch. No sensor, no battery, no pairing. And it never leaves this laptop.',
  ],
  async setup(d) {
    await liveOffice(d);
    await d.page.getByRole('tab', { name: 'Office desk', exact: true }).click();
    await d.button('Photo').click();
    await d.page.locator('.frame-live').first().waitFor({ timeout: 20_000 });
    await d.wait(1.5);
  },
  async run(d) {
    const picture = d.page.locator('.scene').first();
    const inspector = d.inspector();

    const first = d.sayOver(0);
    await d.wait(0.4);
    await d.focus(picture, { pad: 0 });
    await d.until(first + 0.2);

    const second = d.sayOver(1);
    await d.click(d.outline('Add a zone'));
    // A new zone opens in the split view: back to the camera's own, big, playing the
    // stream's restart fast.
    await d.button('Photo').click();
    d.fast(8);
    await d.cue(d.page.locator('.frame-live').first(), 20);
    await d.wait(0.3);
    d.fast(1);
    await d.type(inspector.getByLabel('Zone name'), 'Pink plushie', 0.05);
    await d.click(d.button('Motion'));
    const pic = (await picture.boundingBox())!;
    // The plushies, then the pink one: where its zone already is (x .31, y .417, .041 × .083).
    await d.focus(picture, {
      pad: 0,
      part: (b) => ({
        x: b.x + b.width * 0.22,
        y: b.y + b.height * 0.3,
        width: b.width * 0.28,
        height: b.height * 0.28,
      }),
    });
    await d.wait(0.9);
    await d.drag(
      { x: pic.x + pic.width * 0.3, y: pic.y + pic.height * 0.405 },
      { x: pic.x + pic.width * 0.36, y: pic.y + pic.height * 0.51 },
      1,
    );
    d.lower('MOTION ZONE', 'runs on this machine · no model call');
    await d.wait(0.8);
    await d.focus(inspector, {
      pad: 8,
      part: (b) => ({ ...b, y: b.y + b.height * 0.42, height: b.height * 0.4 }),
    });
    const device = inspector.getByLabel('Device').first();
    await d.click(device);
    await device.selectOption({ label: 'Light bulb color hue 2' });
    const look = inspector.getByLabel('Light look').first();
    await d.click(look);
    await look.selectOption({ label: 'in a colour' });
    await inspector.getByLabel('Light colour').first().fill('#ff69b4');
    await d.until(Math.max(second, d.now()) + 0.6);

    const third = d.sayOver(2);
    await d.focus(null);
    if (d.prompt('Poke the pink plushie.')) {
      // The real zone, saved before: it fires and the bulb turns pink.
      await d.cue(d.outline(/^Pink plushie/).filter({ hasText: /moving/ }), 60);
      await d.focus(picture, { pad: 0 });
      await d.wait(2.5);
    }
    await d.until(third + 1);
  },
  async after(d) {
    // The zone drawn for the camera is never saved.
    const cancel = d.button('Cancel');
    if (await cancel.count()) await cancel.last().click();
  },
};
