import { hexLab } from './color.js';
import type { Point, Quad, SurfacePin } from './iso.js';
import { cm } from './iso-furniture.js';
import { ISO_PRESETS } from './iso-presets.js';
import { cornerCamera, lookAt, projectRoom } from './room-camera.js';
import { floorSolid, renderRoom, sceneSolids, type RoomSolid } from './room-render.js';

/**
 * The demo is the office seen by a camera mounted in its front corner: the
 * same room the iso view draws, rendered through `DEMO_CAMERA`. Its frames,
 * its pin and its synthetic SAM masks all come from that one picture, so the
 * demo runs the pipeline a real corner camera does, with no camera and no
 * model call.
 */
export const DEMO_FRAME = { width: 960, height: 640 } as const;
export const DEMO_ROOM = ISO_PRESETS.office;
export const DEMO_CAMERA = cornerCamera(DEMO_ROOM.grid, { frame: { ...DEMO_FRAME } });

/**
 * Where the demo mug stands on the office desk: its centre, in room tiles.
 * Each position renders its own frame and counts as its own source image.
 */
export const DEMO_POSITIONS = {
  centre: { label: 'Centre', x: 4.85, y: 2.55 },
  right: { label: 'Right', x: 6.05, y: 2.45 },
  front: { label: 'Front left', x: 2.2, y: 3.4 },
} as const;
export type DemoPosition = keyof typeof DEMO_POSITIONS;

const desk = DEMO_ROOM.surfaces.find((s) => s.id === 'desk:top')!;
/** A cream mug about 8.5 cm across and 9.5 cm tall, coffee in it, its handle to the right. */
export const DEMO_MUG = { r: cm(4.25), h: cm(9.5), color: '#e3d9c6', coffee: '#6b5443' } as const;

/** A cork coaster about 10 cm across, under where the mug stands on the right. */
const DEMO_COASTER = {
  x: DEMO_POSITIONS.right.x,
  y: DEMO_POSITIONS.right.y,
  r: cm(5),
  h: cm(0.5),
  color: '#a9825a',
} as const;
const coasterSolid: RoomSolid = {
  id: 'coaster',
  box: {
    at: { x: DEMO_COASTER.x - DEMO_COASTER.r, y: DEMO_COASTER.y - DEMO_COASTER.r, z: desk.z },
    size: { w: 2 * DEMO_COASTER.r, d: 2 * DEMO_COASTER.r, h: DEMO_COASTER.h },
  },
  shape: 'cylinder',
  color: hexLab(DEMO_COASTER.color),
};

/** The mug's solids at a position: its body and handle, on the desk top. */
function demoMugSolids(position: DemoPosition): RoomSolid[] {
  const { x, y } = DEMO_POSITIONS[position];
  const { r, h } = DEMO_MUG;
  const color = hexLab(DEMO_MUG.color);
  return [
    {
      id: 'mug',
      box: { at: { x: x - r, y: y - r, z: desk.z }, size: { w: 2 * r, d: 2 * r, h } },
      shape: 'cylinder',
      color,
    },
    {
      id: 'mug',
      box: {
        at: { x: x - r * 0.82, y: y - r * 0.82, z: desk.z + h },
        size: { w: 1.64 * r, d: 1.64 * r, h: 0.001 },
      },
      shape: 'cylinder',
      color: hexLab(DEMO_MUG.coffee),
      flat: true,
    },
    {
      id: 'mug',
      box: {
        at: { x: x + r * 0.85, y: y - cm(0.6), z: desk.z + h * 0.2 },
        size: { w: cm(2.6), d: cm(1.2), h: h * 0.6 },
      },
      shape: 'prism',
      color,
    },
  ];
}

const frames = new Map<DemoPosition, ReturnType<typeof renderRoom>>();
/** The demo camera's frame with the mug at `position`, labelled per pixel. */
export function demoFrame(position: DemoPosition = 'centre') {
  let picture = frames.get(position);
  if (!picture) {
    picture = renderRoom(DEMO_CAMERA, [
      floorSolid(DEMO_ROOM.grid),
      ...sceneSolids(DEMO_ROOM),
      coasterSolid,
      ...demoMugSolids(position),
    ]);
    frames.set(position, picture);
  }
  return picture;
}

const closeUps = new Map<DemoPosition, ReturnType<typeof renderRoom>>();
/**
 * A close photo of the demo mug, as a person would take one to model it:
 * from the corner camera's side, about 45 cm away. Across the room the mug
 * is too few pixels to fit a model to.
 */
export function demoCloseUp(position: DemoPosition = 'centre') {
  let picture = closeUps.get(position);
  if (!picture) {
    const { x, y } = DEMO_POSITIONS[position];
    const centre: [number, number, number] = [x, y, desk.z + DEMO_MUG.h / 2];
    const to = DEMO_CAMERA.position.map((v, k) => v - centre[k]!);
    const n = Math.hypot(...to);
    const at = centre.map((v, k) => v + (to[k]! / n) * 1.5) as [number, number, number];
    const frame = { width: 480, height: 480 };
    const camera = lookAt(at, centre, 240 / Math.tan((40 * Math.PI) / 360), frame, DEMO_ROOM.grid);
    picture = renderRoom(camera, [
      floorSolid(DEMO_ROOM.grid),
      ...sceneSolids(DEMO_ROOM),
      coasterSolid,
      ...demoMugSolids(position),
    ]);
    closeUps.set(position, picture);
  }
  return picture;
}

/** The office desk's top as the demo camera sees it: the pin a person would save. */
export const DEMO_SURFACE: SurfacePin = {
  scene: 'office',
  surfaceId: desk.id,
  corners: (
    [
      [desk.rect.x, desk.rect.y],
      [desk.rect.x + desk.rect.w, desk.rect.y],
      [desk.rect.x + desk.rect.w, desk.rect.y + desk.rect.d],
      [desk.rect.x, desk.rect.y + desk.rect.d],
    ] as const
  ).map(([x, y]) => {
    const p = projectRoom(DEMO_CAMERA, { x, y, z: desk.z })!;
    return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 } satisfies Point;
  }) as Quad,
  frame: { ...DEMO_FRAME },
};
