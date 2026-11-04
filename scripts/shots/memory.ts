import type { Shot } from '../lib/director.js';

/** 1:50: what the room remembers: a sample day played fast, then a question answered with its moments. */
export const memory: Shot = {
  name: 'memory',
  at: '1:50',
  about: 'Your day played fast, “When did I last drink from my mug?” answered',
  lines: [
    'Every thing keeps a history. This is a sample day in the office, played fast.',
    'Ask the room, and it answers with the moments it rests on.',
  ],
  async setup(d) {
    await d.freshDemo();
    await d.button('Use the demo office').click();
    await d.button('Iso').click();
  },
  async run(d) {
    const replay = d.page.getByRole('region', { name: 'Day replay' });
    const first = d.sayOver(0);
    await d.click(d.button('◷ Your day'));
    await replay.waitFor();
    await d.page.getByRole('slider', { name: 'Time of day' }).fill('900');
    await d.focus(d.page.getByRole('region', { name: 'Scene and segmentation' }), { pad: 0 });
    await d.click(d.button('Play the day'));
    d.lower('YOUR DAY', 'a sample day · events from the room’s things');
    await d.until(first + 0.8);
    await d.click(replay.getByRole('button').first());

    const second = d.sayOver(1);
    await d.focus(replay, { pad: 16 });
    await d.type(
      replay.getByRole('textbox', { name: 'Ask your room' }),
      'When did I last drink from my mug?',
      0.04,
    );
    await d.click(replay.getByRole('button', { name: 'Ask', exact: true }));
    const cited = replay
      .getByRole('group', { name: 'What it rests on' })
      .getByRole('button')
      .first();
    await d.cue(cited, 30);
    await d.wait(1.2);
    await d.click(cited);
    await d.focus(null);
    await d.until(Math.max(second, d.now()) + 1.6);
  },
};
