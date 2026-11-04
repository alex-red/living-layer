/**
 * The film, scene by scene, as docs/demo-video.md has it. Clips filmed on the
 * phone go under out/demo-video/phone/<scene>/; until one is there, its slate
 * says what to film, so the film can always be cut (`bun run shot film`).
 */
import type { Scene } from '../lib/scenes.js';

export const SCENES: Scene[] = [
  {
    name: 'hook',
    title: '1 · Too much control',
    parts: [
      {
        card: 'Have you ever felt like you had too much control in your life?',
        seconds: 4.8,
        look: 'typed',
      },
      {
        clip: 'phone/hook/plushies.mov',
        note: 'poke the pink plushie, the lamp turns purple; the white one, green; pink again',
        seconds: 6.5,
        sound: true,
      },
      { card: 'LIVING LAYER', sub: 'control anything', seconds: 2.6 },
    ],
    lines: [
      { text: 'Yeah. Us neither.', at: 5.6 },
      { text: 'So we made a way to control anything.', at: 8 },
    ],
  },
  {
    name: 'plushie',
    title: '2 · A plushie is a switch',
    parts: [
      { shot: 'plushies' },
      {
        clip: 'phone/plushie/poke.mov',
        note: 'a close poke of the pink plushie, the lamp turning purple',
        seconds: 3,
        sound: true,
      },
    ],
  },
  { name: 'remembers', title: '3 · The room remembers', parts: [{ shot: 'remembers' }] },
  {
    name: 'mug',
    title: '4 · The mug and the lamp',
    parts: [
      {
        clip: 'phone/mug/down.mov',
        note: 'tight on the desk: the mug put down, then the floor lamp switching on',
        seconds: 5,
        sound: true,
      },
      {
        clip: 'screen/mug.mp4',
        note: 'the lab, Live: the mug’s desk zone fills, OCCUPIED, the lamp lit in the twin',
        seconds: 5,
      },
      {
        clip: 'phone/mug/away.mov',
        note: 'the mug picked up and carried off; five minutes later the lamp goes off',
        seconds: 5,
        speed: 1,
      },
    ],
    lines: [
      { text: 'Put the mug down at the desk, and the lamp comes on.', at: 0.6 },
      { text: 'Walk away, and five minutes later it turns itself off.', at: 6 },
      { text: 'It runs on the server, so it keeps working with every tab closed.', at: 10.4 },
    ],
    lowers: [{ title: 'WATCHER', sub: 'on the server · no tab open', at: 10.6 }],
  },
  { name: 'ask', title: '5 · Ask your room', parts: [{ shot: 'ask' }] },
  { name: 'photo', title: '6 · One photo, one room', parts: [{ shot: 'draft' }] },
  { name: 'tell', title: '7 · Tell it what it is', parts: [{ shot: 'brush' }] },
  {
    name: 'switches',
    title: '8 · Anything can be a switch',
    parts: [
      {
        clip: 'phone/switches/plushie.mov',
        note: 'the plushie poked, the lamp purple',
        seconds: 2.2,
      },
      { clip: 'phone/switches/mug.mov', note: 'the mug down, the lamp on', seconds: 2.2 },
      {
        clip: 'phone/switches/monitor.mov',
        note: 'the monitor switched off by hand; then its card going dark in the twin',
        seconds: 2.8,
      },
      {
        clip: 'phone/switches/thinkpad.mov',
        note: 'the mug carried off; thinkpad1 shows “Refill? Water this time.”',
        seconds: 3.2,
      },
    ],
    lines: [
      {
        text: 'A plushie, a mug, a monitor that was never smart. A zone can switch a light, wake a laptop, or leave you a note.',
        at: 0.4,
      },
    ],
  },
  {
    name: 'end',
    title: '9 · Control anything',
    parts: [
      {
        clip: 'phone/end/poke.mov',
        note: 'back to the shelf: poke the plushie, the lamp goes purple; hold on the room',
        seconds: 5,
        sound: true,
      },
      {
        card: 'LIVING LAYER',
        sub: 'one camera · Muse Spark · SAM · Muse Image · DINOv3',
        seconds: 5.5,
      },
    ],
    lines: [
      { text: 'Frames only leave the house when you press a button that says so.', at: 0.3 },
      { text: 'Living Layer. For people with not nearly enough control in their lives.', at: 5.6 },
    ],
  },
];
