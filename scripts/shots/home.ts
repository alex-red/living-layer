import type { Box } from '../lib/demo-shot.js';
import type { Shot } from '../lib/director.js';

/** The coach's cards stand over the room's right side: a box round one, from its button. */
const card = (b: Box): Box => ({ x: b.x - 140, y: b.y - 120, width: 330, height: 300 });

/**
 * The household's day in the demo's Home room (offline): the day plays fast,
 * people come and go and sit at the table, the cat naps, and the dog waits
 * by the door until the coach says he's been home alone. Then the room is
 * asked where the cat is. The day is scripted: nothing here claims the
 * camera sees people or pets.
 */
export const home: Shot = {
  name: 'home',
  at: '1:20',
  about: 'who’s home: the household’s day played fast, the dog home alone, where the cat is',
  lines: [
    'It keeps track of who’s home, too.',
    'Mostly the dog.',
    'And it can tell you where the cat is. Which is more than the cat will.',
  ],
  async setup(d) {
    await d.freshDemo();
    await d.button('Home').click();
    await d.button('Iso').click();
    // Each person's and pet's card over the room.
    const stats = d.page
      .getByRole('group', { name: 'Layers in the room' })
      .getByRole('button', { name: 'Stats', exact: true });
    if ((await stats.getAttribute('aria-pressed')) !== 'true') await stats.click();
    await d.button('◷ Your day').click();
    await d.page.getByRole('slider', { name: 'Time of day' }).fill('420');
    // From 45× to 120×: the day in about seven seconds.
    await d.page.getByRole('button', { name: /^\d+×$/ }).click();
  },
  async run(d) {
    const replay = d.page.getByRole('region', { name: 'Day replay' });
    const first = d.sayOver(0);
    await d.focus(d.page.getByRole('region', { name: 'Scene and segmentation' }), { pad: 0 });
    d.lower('SAMPLE DAY', 'who’s home, minute by minute');
    await d.click(d.button('Play the day'));
    await d.until(first + 0.4);

    // Biscuit, three hours home alone: the coach's nudge, and the replay held on it.
    // At 120× a nudge shows for a blink: hold the day mid-afternoon, then step to just after it.
    const clock = d.page.getByRole('slider', { name: 'Time of day' });
    await d.page.waitForFunction(
      () =>
        Number(
          document.querySelector<HTMLInputElement>('input[aria-label="Time of day"]')?.value,
        ) >= 900,
      undefined,
      { timeout: 30_000 },
    );
    await d.page.getByRole('button', { name: 'Pause' }).click();
    await clock.fill('926');
    const second = d.sayOver(1);
    const onMyWay = d.button('On my way');
    await d.cue(onMyWay, 10);
    await d.focus(onMyWay, { pad: 0, part: card });
    await d.until(Math.max(second, d.now()) + 1.2);
    await d.click(onMyWay);
    await d.wait(1.2);

    const third = d.sayOver(2);
    await d.focus(replay, { pad: 12 });
    await d.click(replay.getByRole('button', { name: 'Where’s Miso?' }));
    const answer = replay.getByText(/^Miso is /).first();
    await d.cue(answer, 20);
    await d.focus(answer, {
      pad: 0,
      part: (b) => ({ x: b.x - 30, y: b.y - 40, width: 520, height: 160 }),
    });
    await d.until(Math.max(third, d.now()) + 1.6);
    await d.focus(null);
    await d.wait(0.8);
  },
};
