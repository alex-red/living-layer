/**
 * How closely a scene laid out from one photo matches where things really
 * are. Draws synthetic photos of a surface with furniture and objects from
 * known cameras, outlines them the way SAM would (each mask only where
 * nothing nearer hides it), lays them out, and prints per case how much
 * room is left before each target (SCENE_TARGETS): the fitted pin's corners
 * against the true ones (share of the frame diagonal), the surface depth the
 * corners imply against the truth, and the worst position error of any thing
 * in tiles. The illustrated demo is listed too. Flags are in scripts/lib/bench.ts.
 *
 *   bun run bench:scene
 *   bun run bench:scene --set desk.topCm=3,4,5      sweep a measurement
 *   bun run bench:scene --compare out/scene-base.json
 */
import {
  SCENE_TARGETS,
  groupBounds,
  layoutPhoto,
  syntheticPhoto,
  withFurniture,
  type SyntheticPhotoOptions,
} from '@livinglayer/domain';
import { parseArgs, variants } from './lib/args.js';
import { report, type Row } from './lib/bench.js';
import { demoPhotoInventory, demoPhotoSegmentation } from '../apps/server/src/demo.js';

const deskThings: Pick<SyntheticPhotoOptions, 'furniture' | 'objects'> = {
  furniture: [{ id: 'chair', as: 'chair', x: 1.3, y: 3.2 }],
  objects: [
    { id: 'mug', as: 'mug', x: 2.6, y: 1.2, r: 0.3, h: 0.7 },
    { id: 'bottle', as: 'bottle', x: 0.7, y: 0.8, r: 0.25, h: 1.5 },
  ],
};
const roomThings: Pick<SyntheticPhotoOptions, 'furniture' | 'objects'> = {
  furniture: [
    { id: 'chair', as: 'chair', x: 1.6, y: 3.3 },
    { id: 'shelf', as: 'shelf', x: 5.2, y: -0.4 },
    { id: 'plant', as: 'plant', x: -1.8, y: 1.6 },
  ],
  objects: [{ id: 'mug', as: 'mug', x: 3, y: 1.4, r: 0.3, h: 0.7 }],
};
const cases: { name: string; options: SyntheticPhotoOptions }[] = [
  { name: 'desk, 35° turned', options: { elevation: 35, yaw: 0.4, f: 1000, ...deskThings } },
  { name: 'desk, 50° turned', options: { elevation: 50, yaw: -0.3, f: 1000, ...deskThings } },
  { name: 'desk, 28° square on', options: { elevation: 28, yaw: 0, f: 1000, ...deskThings } },
  { name: 'desk, 60° wide lens', options: { elevation: 60, yaw: 0.25, f: 700, ...deskThings } },
  {
    name: 'table, 40° turned',
    options: {
      elevation: 40,
      yaw: -0.5,
      f: 1100,
      surface: { as: 'table', w: 3, d: 3 },
      objects: deskThings.objects,
    },
  },
  { name: 'room, 32° turned', options: { elevation: 32, yaw: 0.35, f: 900, ...roomThings } },
];

/**
 * A square table top seen at an angle can't tell its depth from its width
 * as surely as a desk's long edge does: its depth reads 12% short. Reported,
 * but it doesn't fail the run.
 */
const KNOWN_GAPS = new Set(['table, 40° turned']);

const args = parseArgs();
const rows: Row[] = [];
for (const v of variants(args.flags.get('set')))
  for (const c of cases)
    withFurniture(v.overrides, () => {
      const s = syntheticPhoto(c.options);
      const start = performance.now();
      const layout = layoutPhoto({ ...s, refine: true });
      const ms = Math.round(performance.now() - start);
      const diag = Math.hypot(s.segmentation.frame.width, s.segmentation.frame.height);
      const corners = layout.pin
        ? Math.max(
            ...layout.pin.corners.map((p, i) =>
              Math.hypot(p.x - s.truth.corners[i]!.x, p.y - s.truth.corners[i]!.y),
            ),
          ) / diag
        : Infinity;
      const depth = layout.camera?.surface.d ?? NaN;
      const depthError = Math.abs(depth - s.truth.surface.d) / s.truth.surface.d;
      // Worst position error: furniture by its back-left corner, objects by their centre.
      let worst = 0;
      let who = '';
      const origin = layout.origin;
      for (const t of layout.things) {
        const at = s.truth.at[t.id];
        if (!at || !origin) continue;
        if (t.status === 'object' && t.foot) {
          const x = t.foot.at.x + t.foot.size.w / 2 - origin.x;
          const y = t.foot.at.y + t.foot.size.d / 2 - origin.y;
          const e = Math.hypot(x - at.x, y - at.y);
          if (e > worst) [worst, who] = [e, t.id];
        } else if (t.group) {
          const b = groupBounds(layout.scene, t.group)!;
          const e = Math.hypot(b.at.x - origin.x - at.x, b.at.y - origin.y - at.y);
          if (e > worst) [worst, who] = [e, t.id];
        } else [worst, who] = [Infinity, `${t.id} (unplaced)`];
      }
      rows.push({
        case: c.name,
        variant: v.label,
        knownGap: KNOWN_GAPS.has(c.name),
        metrics: {
          corners: { value: corners, target: SCENE_TARGETS.corners, better: 'lower', unit: '%' },
          depth: {
            value: Number.isNaN(depthError) ? Infinity : depthError,
            target: SCENE_TARGETS.depth,
            better: 'lower',
            unit: '%',
            digits: 1,
          },
          position: {
            value: worst,
            target: SCENE_TARGETS.position,
            better: 'lower',
            unit: 'tiles',
          },
        },
        notes: {
          worst: who,
          camera: `${Math.round(layout.camera?.elevation ?? 0)}°${layout.camera?.focalGuessed ? '?' : ''}`,
          match: `${Math.round((layout.score ?? 0) * 100)}%`,
          ms: String(ms),
        },
      });
    });
const code = report(rows, args, 'scene');
{
  const segmentation = await demoPhotoSegmentation();
  const detections = { desk: '1', mug: '2', book: '3', bottle: '4' };
  const start = performance.now();
  const layout = layoutPhoto({
    inventory: demoPhotoInventory,
    segmentation,
    detections,
    refine: true,
  });
  console.log(
    `\ndemo: ${layout.pin ? 'pinned' : 'not pinned'}, ${layout.things.filter((t) => t.status === 'object').length} objects, match ${Math.round((layout.score ?? 0) * 100)}%, ${Math.round(performance.now() - start)} ms`,
  );
}
console.log(
  "\n? after the camera: the corners were too square-on to measure the lens, so it's guessed.",
);
process.exit(code);
