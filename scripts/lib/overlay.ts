/**
 * A room drawn over a frame of its camera, to judge a layout or a
 * calibration against the photo: each thing's drawing tinted and outlined,
 * named over its top; boxes for things drawn as models (an object's foot);
 * and the calibration's marks and floor grid. With no frame, a dark canvas
 * of the camera's size.
 */
import sharp from 'sharp';
import {
  floorSolid,
  projectRoom,
  renderRoom,
  sceneSolids,
  type IsoBox,
  type IsoScene,
  type RoomCamera,
  type RoomMarks,
} from '@livinglayer/domain';

export interface Overlay {
  camera: RoomCamera;
  /** The frame the camera saw; its size must be the camera's. */
  frame?: Buffer | null;
  scene?: IsoScene;
  /** Things drawn as boxes, labelled. */
  boxes?: { label: string; box: IsoBox }[];
  marks?: RoomMarks;
  /** The floor's tiles drawn through the camera. */
  grid?: boolean;
}

const TINTS: [number, number, number][] = [
  [255, 80, 80],
  [80, 200, 255],
  [255, 220, 60],
  [120, 255, 120],
  [255, 120, 255],
  [255, 160, 60],
  [160, 120, 255],
  [60, 255, 220],
];
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

export async function overlay({ camera, frame, scene, boxes = [], marks, grid }: Overlay) {
  const { width, height } = camera.frame;
  const base = frame
    ? await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    : {
        data: Buffer.alloc(width * height * 4, 24),
        info: { width, height },
      };
  if (base.info.width !== width || base.info.height !== height)
    throw new Error(
      `The frame is ${base.info.width} × ${base.info.height}; the camera's is ${width} × ${height}.`,
    );
  const px = base.data;
  const svg: string[] = [];
  const at = (x: number, y: number, z: number) => projectRoom(camera, { x, y, z });
  const text = (x: number, y: number, label: string, color: string) =>
    svg.push(
      `<text x="${x}" y="${y}" fill="${color}" stroke="#000" stroke-width="0.6" font-family="sans-serif" font-size="${Math.max(12, width / 70)}">${esc(label)}</text>`,
    );

  if (scene) {
    const picture = renderRoom(camera, [floorSolid(scene.grid), ...sceneSolids(scene)], {
      labels: true,
    });
    for (let i = 0; i < width * height; i++) {
      const id = picture.ids[i]!;
      const name = id >= 0 ? picture.names[id]! : null;
      if (!name || name === 'floor' || name.startsWith('wall')) continue;
      const tint = TINTS[id % TINTS.length]!;
      const edge = [1, -1, width, -width].some((d) => picture.ids[i + d] !== id);
      const a = edge ? 1 : 0.25;
      for (let k = 0; k < 3; k++) px[i * 4 + k] = px[i * 4 + k]! * (1 - a) + tint[k]! * a;
    }
    for (const g of new Set(scene.props.map((p) => p.group))) {
      if (g.startsWith('wall')) continue;
      const own = scene.props.filter((p) => p.group === g);
      const x = Math.min(...own.map((p) => p.at.x));
      const y = Math.min(...own.map((p) => p.at.y));
      const x1 = Math.max(...own.map((p) => p.at.x + p.size.w));
      const y1 = Math.max(...own.map((p) => p.at.y + p.size.d));
      const top = Math.max(...own.map((p) => p.at.z + p.size.h));
      const p = at((x + x1) / 2, (y + y1) / 2, top);
      if (p) text(p.x, p.y, g, '#fff');
    }
  }
  for (const { label, box } of boxes) {
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([u, v]) => at(box.at.x + u! * box.size.w, box.at.y + v! * box.size.d, box.at.z));
    if (corners.some((c) => !c)) continue;
    svg.push(
      `<polygon points="${corners.map((c) => `${c!.x},${c!.y}`).join(' ')}" fill="none" stroke="#ff0" stroke-width="2"/>`,
    );
    text(corners[0]!.x, corners[0]!.y, label, '#ff0');
  }
  if (grid) {
    const lines: string[] = [];
    const line = (a: [number, number], b: [number, number]) => {
      const p = at(a[0], a[1], 0);
      const q = at(b[0], b[1], 0);
      if (p && q) lines.push(`M${p.x} ${p.y}L${q.x} ${q.y}`);
    };
    for (let x = 0; x <= camera.room.w; x++) line([x, 0], [x, camera.room.d]);
    for (let y = 0; y <= camera.room.d; y++) line([0, y], [camera.room.w, y]);
    svg.push(`<path d="${lines.join('')}" fill="none" stroke="#f0f" stroke-opacity="0.5"/>`);
  }
  if (marks) {
    const wall = (points: { x: number; y: number }[]) =>
      `<polyline points="${[marks.corner, ...points].map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#f0f" stroke-width="2.5" stroke-dasharray="8 5"/>`;
    svg.push(wall(marks.back), wall(marks.left));
    svg.push(`<circle cx="${marks.corner.x}" cy="${marks.corner.y}" r="6" fill="#f0f"/>`);
  }
  return sharp(px, { raw: { width, height, channels: 4 } })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svg.join('')}</svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
}

/** A room layout over its frame: the scene's templates, and a box for each thing drawn as a model. */
export const layoutOverlay = (
  layout: { scene: IsoScene; things: { id: string; foot?: IsoBox }[] },
  camera: RoomCamera,
  frame?: Buffer | null,
) =>
  overlay({
    camera,
    frame: frame ?? null,
    scene: layout.scene,
    boxes: layout.things.flatMap((t) => (t.foot ? [{ label: t.id, box: t.foot }] : [])),
  });
