import type { Box } from '../lib/demo-shot.js';
import type { Shot } from '../lib/director.js';
import { draftedRoom } from './draft.js';

/** The middle of the iso pane, where the desk is in its close view. */
export const deskPart = (b: Box): Box => ({
  x: b.x + b.width * 0.2,
  y: b.y + b.height * 0.2,
  width: b.width * 0.6,
  height: b.height * 0.55,
});

/** 0:15: the room, then the desk; every thing on it has a card; the mug is followed. */
export const tour: Shot = {
  name: 'tour',
  at: '0:15',
  about: 'the iso room, the desk, the mug’s card',
  lines: [
    'Smart homes know switches, not things.',
    'Living Layer gives the things in a room a memory.',
    'Close in on the desk, and every thing on it has a card of its own.',
    'There’s no sensor on the mug: one camera in the corner, and Meta’s models.',
  ],
  async setup(d) {
    await draftedRoom(d);
    await d.page.getByRole('tab', { name: 'Whole room', exact: true }).click();
    await d.button('Iso').click();
  },
  async run(d) {
    d.title('Living Layer', 'every thing in your home, with a memory');
    await d.wait(0.6);
    await d.say(0);
    await d.focus(d.iso(), { pad: 0 });
    await d.say(1);

    const card = d.sayOver(2);
    await d.click(d.page.getByRole('tab', { name: 'Office desk' }));
    await d.wait(1);
    await d.focus(d.iso(), { pad: 0, part: deskPart });
    await d.wait(0.8);
    await d.click(d.outline('Cream mug'));
    d.lower('CREAM MUG', 'a Thing: stats, history, zones');
    await d.wait(0.6);
    await d.focus(d.inspector(), {
      pad: 8,
      part: (b) => ({ ...b, height: Math.min(b.height, 380) }),
    });
    await d.until(card + 1.2);

    await d.focus(null);
    await d.wait(0.4);
    const last = d.sayOver(3);
    await d.focus(d.iso(), { pad: 0, part: deskPart });
    d.lower('DEMO CAMERA', 'the office through its corner camera · no model calls', 3.2);
    await d.until(last + 0.6);
    await d.focus(null);
    await d.wait(1.4);
  },
};
