import type { Shot } from '../lib/director.js';
import { draftedRoom } from './draft.js';

/** 2:45: the camera's view beside the room it drew, then the title. Live, the room is warm and the lamp on. */
export const end: Shot = {
  name: 'end',
  at: '2:45',
  about: 'the split view, the privacy line, the title',
  lines: [
    'Frames leave the house only when you press a button that says so.',
    'Living Layer: every thing in your home, with a memory.',
  ],
  async setup(d) {
    await draftedRoom(d);
    await d.button('Split').click();
  },
  async run(d) {
    const first = d.sayOver(0);
    await d.focus(d.page.getByRole('region', { name: 'Scene and segmentation' }), { pad: 0 });
    await d.until(first + 0.3);
    const second = d.sayOver(1);
    await d.wait(0.4);
    d.title('Living Layer', 'every thing in your home, with a memory', second - d.now() + 2.4);
    await d.until(second + 2.2);
  },
};
