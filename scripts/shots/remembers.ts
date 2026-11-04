import type { Director, Shot } from '../lib/director.js';

/** Live, in a fresh browser: the user's own office, picked again (it changes nothing). */
export async function liveOffice(d: Director) {
  await d.live();
  const chooser = d.page.getByRole('group', { name: 'Choose a scene' });
  await chooser
    .or(d.page.getByRole('button', { name: 'Stop camera' }))
    .first()
    .waitFor();
  if (await chooser.count()) await chooser.getByRole('button', { name: /My office/ }).click();
  await d.button('Stop camera').waitFor({ timeout: 20_000 });
}

/**
 * Scene 3 (0:42), Live and read-only: the camera beside the room it keeps,
 * a push in to the desk's cards, and the anime filter. It switches views and
 * a filter in its own throwaway browser; nothing in the lab is saved.
 */
export const remembers: Shot = {
  name: 'remembers',
  at: '0:42',
  about: 'Live: the office camera and its twin, the desk’s cards, the anime filter',
  lines: [
    'Behind the camera, Living Layer keeps a little model of the room: every thing in it, where it stands, and what it’s been up to.',
    'The mug knows when I last drank from it. The monitor knows it’s been off for three hours. Neither of them is smart. The camera does all of it.',
    'It also does anime. We’re not sure why either.',
  ],
  async setup(d) {
    await liveOffice(d);
    await d.button('Split').click();
    await d.wait(2.5);
  },
  async run(d) {
    const stage = d.page.getByRole('region', { name: 'Scene and segmentation' });
    const iso = d.iso();

    const first = d.sayOver(0);
    await d.wait(0.6);
    await d.focus(iso, { pad: 0 });
    d.lower('SAM 3.1', 'outlines every thing in the room');
    await d.until(first + 0.2);

    const second = d.sayOver(1);
    // The camera's own badges on the desk: the mug's last use, the monitor's power.
    await d.focus(null);
    await d.click(d.button('Photo'));
    // The stream restarts with the view: play the wait for it fast.
    d.fast(8);
    await d.cue(stage.locator('.frame-live').first(), 20);
    await d.wait(0.4);
    d.fast(1);
    await d.focus(stage.locator('.scene').first(), {
      pad: 0,
      part: (b) => ({
        x: b.x + b.width * 0.1,
        y: b.y + b.height * 0.35,
        width: b.width * 0.5,
        height: b.height * 0.5,
      }),
    });
    await d.wait(0.8);
    d.lower('DINOV3 · ON THIS MACHINE', 'knows the mug from frame to frame', 3.6);
    await d.until(second + 0.3);

    await d.focus(null);
    await d.click(stage.getByRole('button', { name: 'Filter', exact: true }));
    const anime = d.page
      .getByRole('menuitemradio', { name: /Anime ✦/ })
      .or(d.page.getByRole('menuitem', { name: /Anime ✦/ }));
    await d.click(anime.first());
    const third = d.sayOver(2);
    await d.focus(stage.locator('.scene').first(), { pad: 0 });
    await d.until(third + 1.6);
    await d.focus(null);
    await d.wait(0.8);
  },
};
