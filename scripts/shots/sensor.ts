import type { Shot } from '../lib/director.js';
import { drawMugZone, fixedDesk } from './triggers.js';

/**
 * A zone made a room sensor: Presence in Home Assistant, shown the zone empty once,
 * then on with the mug standing still in it; what it would publish, and every
 * entity the demo shows in Home Assistant. Demo mode publishes nothing: the panel
 * shows the messages it would send.
 */
export const sensor: Shot = {
  name: 'sensor',
  at: '0:50',
  about: 'a zone made a Presence sensor for Home Assistant, learned empty, then occupied',
  lines: [
    'Or make a zone a room sensor.',
    'Show it the zone empty once. After that, anything there counts, even sitting perfectly still.',
    'And every one of them shows up in Home Assistant.',
  ],
  async setup(d) {
    await fixedDesk(d);
    // A zone round the mug, then the mug out of it, and the server watching.
    await d.outline('Add a zone').click();
    await d.page.getByLabel('Zone name').fill('Desk');
    await drawMugZone(d, 0.2);
    await d.button('Save zone').click();
    await d.outline('Cream mug').click();
    await d.button('Watch on the server').click();
    await d.wait(2);
    // Out of the zone once the watcher is on, so the frame it learns from is empty.
    await d.button('Right').click();
    await d.wait(2.5);
    await d
      .inspector()
      .getByRole('button', { name: /Close|Cream mug/ })
      .first()
      .click()
      .catch(() => {});
    await d.wait(1);
  },
  async run(d) {
    const inspector = d.inspector();

    const first = d.sayOver(0);
    await d.click(d.outline('Show in Home Assistant'));
    await d.focus(inspector, { pad: 8, part: (b) => ({ ...b, height: Math.min(b.height, 760) }) });
    await d.click(inspector.getByRole('button', { name: /^Presence/ }));
    await d.page.getByLabel('Name').fill('');
    await d.type(inspector.getByLabel('Name'), 'Office presence', 0.03);
    await d.click(inspector.getByRole('button', { name: 'Show in Home Assistant' }));
    await d.until(first);

    const second = d.sayOver(1);
    await d.focus(inspector, { pad: 8, part: (b) => ({ ...b, height: Math.min(b.height, 340) }) });
    await d.click(d.button(/learn it/i));
    d.lower('LEARNED EMPTY', 'compared on this machine · no model call', 2.4);
    await d.wait(2.2);
    await d.focus(null);
    await d.click(d.button('Centre'));
    await d.cue(inspector.getByText('Now: on.'), 15);
    await d.focus(inspector, { pad: 8, part: (b) => ({ ...b, height: Math.min(b.height, 340) }) });
    d.lower('OCCUPIED', 'binary_sensor.ll_office_presence · on', 2.6);
    await d.until(second);

    const third = d.sayOver(2);
    await d.click(inspector.getByText('What it would publish'));
    await d.focus(inspector, { pad: 8, part: (b) => ({ ...b, height: Math.min(b.height, 620) }) });
    await d.wait(1.6);
    await d.focus(d.page.getByRole('complementary', { name: 'Scene outline' }), {
      pad: 8,
      part: (b) => ({ ...b, y: b.y + b.height * 0.45, height: b.height * 0.5 }),
    });
    await d.until(Math.max(third, d.now()) + 1);
  },
};
