import type { Shot } from '../lib/director.js';

/**
 * 1:25: box the desk with the AI brush and say what it is; it is rebuilt at
 * its real size and put in the room. In the demo, "It's an IKEA Alex desk"
 * alone is asked back (which change?), so the request names the change too.
 */
export const brush: Shot = {
  name: 'brush',
  at: '1:25',
  about: 'the AI brush: box the desk, make it an IKEA Alex desk',
  lines: [
    'The AI brush takes what I select and what I say.',
    'Spark reads the request, looks up the real product and rebuilds the model at its real size.',
    'Agents get the same tools over MCP.',
  ],
  // The preset office, as `bun run brush` uses: in a drafted room, putting the
  // model in the room is refused (the camera is calibrated on the preset).
  async setup(d) {
    await d.freshDemo();
    await d.button('Use the demo office').click();
    await d.button('Photo').click();
  },
  async run(d) {
    const first = d.sayOver(0);
    await d.click(d.button('AI brush B'));
    const frame = (await d.page.locator('.brush-overlay').boundingBox())!;
    await d.focus(d.page.locator('.brush-overlay'), { pad: 0 });
    // The selection `bun run brush --around desk` uses (frame 360,183 to 714,670 of 960 × 640).
    await d.drag(
      { x: frame.x + frame.width * 0.375, y: frame.y + frame.height * 0.29 },
      { x: frame.x + frame.width * 0.74, y: frame.y + frame.height * 0.95 },
      1,
    );
    const panel = d.page.getByRole('complementary', { name: 'AI brush' });
    await d.focus(panel, { pad: 12 });
    await d.type(
      d.page.getByLabel('What to do with the selection'),
      "Turn this into its own fixture, it's an IKEA Alex desk",
      0.035,
    );
    await d.until(first);
    const second = d.sayOver(1);
    await d.page.keyboard.press('Enter');
    d.lower('MUSE SPARK 1.3', 'reads the request · looks up the product');
    const put = panel.getByRole('button', { name: 'Put in the room' });
    await d.cue(put, 60);
    await d.focus(panel, { pad: 12 });
    await d.wait(1.6);
    await d.click(put);
    await d.wait(0.8);
    await d.focus(null);
    await d.click(d.button('Iso'));
    await d.wait(0.6);
    await d.focus(d.iso(), { pad: 0 });
    await d.until(Math.max(second, d.now() + 0.6));

    const third = d.sayOver(2);
    d.lower('MCP', 'bun run mcp · the brush’s ops, for agents', 3);
    await d.until(third + 1.4);
    await d.focus(null);
    await d.wait(1);
  },
};
