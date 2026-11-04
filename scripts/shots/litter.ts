import type { Shot } from '../lib/director.js';

/**
 * After the home's cat line: the litter box room in Iso, Juniper by the litter
 * robot, and the robot's card counting today's visits against a usual day.
 */
export const litter: Shot = {
  name: 'litter',
  at: '1:54',
  about: 'the litter box room: Juniper, the litter robot and its visits against a usual day',
  lines: ['It even counts the cat’s litter box visits. Seven today? Worth keeping an eye on.'],
  async setup(d) {
    await d.freshDemo();
    await d.button('Litter box room').click();
    await d.button('Iso').click();
    await d.wait(1.2);
  },
  async run(d) {
    const first = d.sayOver(0);
    await d.focus(d.iso(), { pad: 0 });
    await d.wait(0.6);
    await d.click(d.outline('Litter robot'));
    d.lower('LITTER BOX', 'Juniper’s visits, counted from the room', 2.6);
    await d.wait(1.4);
    await d.focus(d.inspector(), {
      pad: 8,
      part: (b) => ({ ...b, y: b.y + b.height * 0.62, height: b.height * 0.36 }),
    });
    await d.until(Math.max(first, d.now()) + 0.6);
  },
};
