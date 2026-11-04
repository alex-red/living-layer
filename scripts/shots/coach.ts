import type { Box } from '../lib/demo-shot.js';
import type { Shot } from '../lib/director.js';

/** The coach's cards stand over the room's right side: a box round one, from its button. */
const card = (b: Box): Box => ({ x: b.x - 40, y: b.y - 120, width: 330, height: 300 });

/**
 * The room coach, on the demo's sample day (offline, its buttons act): a
 * nudge worded by Spark from the room's own numbers, Take 5, then Check now
 * for a health check at once. Live, Check now asks Spark (one cheap call) and
 * a nudge has only Dismiss, so the demo is where it shows best.
 */
export const coach: Shot = {
  name: 'coach',
  at: '1:26',
  about: 'the room coach: a health check, a nudge with a joke, Take 5, Check now',
  lines: [
    'And it looks out for you. Every few minutes, the room coach does a health check: water, screen time, late nights, a lamp left on.',
    'The numbers come from the room. Spark only finds the words.',
    'Take five, and the screen goes off for five minutes.',
    'Or ask for a check right now.',
  ],
  async setup(d) {
    await d.freshDemo();
    await d.button('Use the demo office').click();
    await d.button('Iso').click();
    await d.button('◷ Your day').click();
    await d.page.getByRole('slider', { name: 'Time of day' }).fill('900');
  },
  async run(d) {
    const replay = d.page.getByRole('region', { name: 'Day replay' });
    const first = d.sayOver(0);
    await d.focus(d.page.getByRole('region', { name: 'Scene and segmentation' }), { pad: 0 });
    await d.click(d.button('Play the day'));
    const take5 = d.button('Take 5');
    await d.cue(take5, 30);
    await d.page.getByRole('button', { name: 'Pause' }).click();
    await d.focus(take5, { pad: 0, part: card });
    d.lower('ROOM COACH', 'a health check every few minutes · its own numbers');
    await d.until(first + 0.2);

    const second = d.sayOver(1);
    d.lower('MUSE SPARK 1.3', 'words the nudge · one cheap call, only when due', 3);
    await d.until(second + 0.3);

    const third = d.sayOver(2);
    await d.click(take5);
    await d.until(third + 0.6);

    const fourth = d.sayOver(3);
    await d.focus(replay, { pad: 12 });
    await d.click(replay.getByRole('button', { name: 'Check now' }));
    // The check's own nudge comes in on top of the others.
    const fresh = d.page
      .locator('strong', { hasText: /Hydration/ })
      .filter({ visible: true })
      .first();
    await d.cue(fresh, 30);
    await d.focus(fresh, {
      pad: 0,
      part: (b) => ({ x: b.x - 30, y: b.y - 40, width: 340, height: 200 }),
    });
    await d.until(Math.max(fourth, d.now()) + 1.8);
    await d.focus(null);
    await d.wait(0.8);
  },
};
