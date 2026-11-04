import type { Box } from '../lib/demo-shot.js';
import type { Shot } from '../lib/director.js';

/** The coach's cards stand over the room's right side: a box round one, from its button. */
const card = (b: Box): Box => ({ x: b.x - 140, y: b.y - 120, width: 330, height: 300 });

/**
 * The demo's fridge (offline): stocked, every thing in it with its use-by
 * day and a health bar over it, seen from its corner and cut away. The
 * leftover chicken's card says it goes off today. The fridge's own room
 * coach says so at breakfast, and that the milk is nearly gone; its button
 * asks the room what to eat first. At five it has a dinner idea from what
 * goes off soonest. The use-by days are set on each thing, not read by the
 * camera: no line claims it reads a label.
 */
export const fridge: Shot = {
  name: 'fridge',
  at: '1:26',
  about:
    'the fridge: use-by days over each thing, its coach at breakfast and dinner, what to eat first',
  lines: [
    'It knows what’s in the fridge, and when each thing goes off.',
    'The coach tells you before the chicken does. And when the milk’s nearly gone.',
    'It knows what to eat first. Which, again, is the chicken.',
    'And at five, it has ideas about dinner.',
  ],
  async setup(d) {
    await d.freshDemo();
    await d.button('Fridge').click();
    await d.button('Iso').click();
    // Each food thing's use-by day and health bar over the room.
    const stats = d.page
      .getByRole('group', { name: 'Layers in the room' })
      .getByRole('button', { name: 'Stats', exact: true });
    if ((await stats.getAttribute('aria-pressed')) !== 'true') await stats.click();
  },
  async run(d) {
    const room = d.page.getByRole('region', { name: 'Scene and segmentation' });
    const angles = d.page.getByRole('group', { name: 'Fridge seen from' });
    const first = d.sayOver(0);
    await d.focus(room, { pad: 0 });
    d.lower('THE FRIDGE', 'a use-by day on each thing · nudged before it goes off');
    await d.wait(1.2);
    await d.click(angles.getByRole('button', { name: 'Cut away' }));
    await d.wait(1);
    await d.click(d.outline(/^Leftover chicken/));
    const food = d
      .inspector()
      .getByRole('status')
      .filter({ hasText: /^Expires today/ });
    await d.cue(food, 10);
    await d.focus(food, {
      pad: 0,
      part: (b) => ({ x: b.x - 20, y: b.y - 60, width: 420, height: 200 }),
    });
    await d.until(Math.max(first, d.now()) + 0.6);

    // Breakfast on the sample day: the fridge coach's nudges about the leftovers and the milk.
    await d.focus(room, { pad: 0 });
    await d.button('◷ Your day').click();
    const clock = d.page.getByRole('slider', { name: 'Time of day' });
    await clock.fill('486');
    const second = d.sayOver(1);
    d.lower('ROOM COACH', 'the fridge’s own nudges · its numbers, Spark’s words');
    const ask = d.button('What do I eat?');
    await d.cue(ask, 10);
    await d.focus(d.page.getByRole('log', { name: 'Notifications' }), { pad: 16 });
    await d.until(Math.max(second, d.now()) + 1);

    const third = d.sayOver(2);
    await d.click(ask);
    const answer = d.page.getByText(/^Eat the leftover chicken first/).first();
    await d.cue(answer, 20);
    // The sentence and the foods in order under it.
    await d.focus(answer, { pad: 16, part: (b) => ({ ...b, height: b.height + 70 }) });
    await d.until(Math.max(third, d.now()) + 1.2);

    // Five o'clock: a dinner idea from what goes off soonest.
    const fourth = d.sayOver(3);
    await d.focus(room, { pad: 0 });
    await clock.fill('1021');
    const dinner = d.button('Sounds good');
    await d.cue(dinner, 10);
    await d.focus(dinner, { pad: 0, part: card });
    await d.wait(1.2);
    await d.click(dinner);
    await d.until(Math.max(fourth, d.now()) + 1.2);
    await d.focus(null);
    await d.wait(0.8);
  },
};
