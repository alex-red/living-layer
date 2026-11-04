import { fixtureBox, fixtureModel, type Fixture } from './fixture.js';
import type { IsoScene, IsoVec } from './iso.js';
import { rotateItem } from './iso-item.js';
import { screenPart } from './item-screen.js';
import { projectRoom, type RoomCamera } from './room-camera.js';
import type { LumaFrame } from './tracker.js';
import { calibrationOf, type DeskMemory } from './memory.js';

/** What names a thing whose picture is a screen: its power is read off the screen alone. */
const SCREEN = /\b(monitor|screen|display|tv|television)\b/i;
/** Whether a thing, by its name, is a screen: a monitor, a display, a TV. */
const isScreen = (label: string) => SCREEN.test(label);

/** The scene a lab's room is in: its calibrated camera's, else its own drawn one, else the office. */
export const roomSceneOf = (memory: Pick<DeskMemory, 'mode' | 'camera' | 'scene'>) =>
  calibrationOf(memory)?.scene ?? (memory.scene ? 'custom' : 'office');

/**
 * The Things in a lab's room a desktop's display can be: its screens (by
 * name) first, then the rest, for a monitor named otherwise.
 */
export function displayChoices(memory: DeskMemory): { screens: Fixture[]; others: Fixture[] } {
  const room = roomSceneOf(memory);
  const here = (memory.fixtures ?? []).filter((f) => f.scene === room);
  return {
    screens: here.filter((f) => isScreen(f.label)),
    others: here.filter((f) => !isScreen(f.label)),
  };
}

/** Four points in shares of the frame, clockwise from the top left as the camera sees them. */
export type UnitQuad = [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
];

/**
 * A screen's face in the room camera's frame: its model's screen
 * (`screenPart`, a monitor's panel), its side toward the camera. A box round
 * the whole thing takes in its stand, the wall behind and whatever is in
 * front, and the room's light drifts those as much as the screen going on
 * does. Null for what isn't a screen, has no panel, or isn't in this room.
 */
export function screenInFrame(
  fixture: Pick<
    Fixture,
    'label' | 'scene' | 'surfaceId' | 'at' | 'turns' | 'size' | 'model' | 'state' | 'states'
  >,
  scene: IsoScene | null,
  camera: RoomCamera,
): UnitQuad | null {
  if (!isScreen(fixture.label)) return null;
  const box = fixtureBox(fixture, scene);
  // One item unit is the footprint's longer side, as the room draws it.
  const k = Math.max(box.size.w, box.size.d);
  const turned = rotateItem(fixtureModel(fixture), fixture.turns);
  const id = screenPart(turned);
  const p = id && turned.parts.find((x) => x.id === id);
  if (!p) return null;
  const at = { x: box.at.x + p.at.x * k, y: box.at.y + p.at.y * k, z: box.at.z + p.at.z * k };
  const w = p.size.w * k;
  const d = p.size.d * k;
  const h = p.size.h * k;
  // Thinner along x, it faces along x; else along y.
  const alongX = w / Math.min(d, h) <= d / Math.min(w, h);
  const middle = { x: at.x + w / 2, y: at.y + d / 2 };
  // The side nearer the camera.
  const face = alongX
    ? at.x + (camera.position[0] > middle.x ? w : 0)
    : at.y + (camera.position[1] > middle.y ? d : 0);
  const corner = (u: number, z: number): IsoVec =>
    alongX
      ? { x: face, y: at.y + u * d, z: at.z + z * h }
      : { x: at.x + u * w, y: face, z: at.z + z * h };
  const seen = [corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0)].map((v) =>
    projectRoom(camera, v),
  );
  if (seen.some((p) => !p)) return null;
  const { width: W, height: H } = camera.frame;
  const pts = seen.map((p) => ({ x: p!.x / W, y: p!.y / H }));
  // Clockwise from the top left as seen: the two higher points first, left to right.
  const [a, b] = [...pts].sort((p, q) => p.y - q.y || p.x - q.x).slice(0, 2) as [
    { x: number; y: number },
    { x: number; y: number },
  ];
  const top = a.x <= b.x ? [a, b] : [b, a];
  const bottom = pts.filter((p) => p !== a && p !== b).sort((p, q) => q.x - p.x);
  const quad = [...top, ...bottom] as UnitQuad;
  return quad.every((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1) ? quad : null;
}

/** The box round a quad, in the same shares. */
export function quadBox(q: UnitQuad) {
  const x = Math.min(...q.map((p) => p.x));
  const y = Math.min(...q.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...q.map((p) => p.x)) - x,
    height: Math.max(...q.map((p) => p.y)) - y,
  };
}

/**
 * How far in from a screen's edges its sample starts, as a share of its
 * width and height: past the bezel, and past the few pixels a model's panel
 * misses the real one by.
 */
const INSET = 0.08;
/**
 * A `w` × `h` grey sample of a quad of the frame, bilinear between its
 * corners, so every pixel taken is inside it (`sampleInto` for a box).
 */
export function sampleQuadInto(
  frame: LumaFrame,
  [tl, tr, br, bl]: UnitQuad,
  out: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  for (let y = 0; y < h; y++) {
    const v = INSET + ((y + 0.5) / h) * (1 - 2 * INSET);
    for (let x = 0; x < w; x++) {
      const u = INSET + ((x + 0.5) / w) * (1 - 2 * INSET);
      const px = (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);
      const py = (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);
      const fx = Math.min(frame.width - 1, Math.max(0, Math.floor(px * frame.width)));
      const fy = Math.min(frame.height - 1, Math.max(0, Math.floor(py * frame.height)));
      out[y * w + x] = frame.data[fy * frame.width + fx]!;
    }
  }
  return out;
}
