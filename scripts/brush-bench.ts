/**
 * The AI brush's selection step on captured real rooms (scripts/lib/rooms.ts),
 * offline: for each thing marked in a room's `truth.json`, Spark's box for it
 * and that box's middle (a box on part of a thing), each read as the panel
 * reads it and as a live request would outline it, from SAM's stored answer
 * for that box. Per case:
 *
 *   named    the panel names the marked thing (its group, or nothing for a thing
 *            the room draws only as an object)
 *   agree    the request works on the same target as the panel
 *   SAM      whether SAM's outline was kept or replaced by the room's drawing
 *   IoU      SAM's outline against the room's drawing of the target, in the box
 *   size     the camera's size of the outline used against the room's, largest share off
 *
 *   bun run bench:brush             offline, from stored SAM answers
 *   bun run bench:brush --live      ask SAM again for every case and store the answers
 *                                   (billed: one SAM image each, $0.0025)
 *
 * SAM's answers are kept beside the room as `brush-sam.json` (local, like
 * the frame). A case whose box has changed since its answer was stored is
 * reported as needing `--live`.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  groupBounds,
  ISO_TILE_CM,
  META_PRICES,
  photoBox,
  selectionBox,
  selectionMask,
  type Bits,
  type DeskMemory,
  type Segmentation,
  type SelectionShape,
  type SelectionTarget,
} from '@livinglayer/domain';
import { drawnOf, keepOutline, samMask } from '../apps/server/src/assist.js';
import { parseConfig } from '../apps/server/src/config.js';
import { MetaAdapter } from '../apps/server/src/meta.js';
import { selectionRoom } from '../apps/server/src/select.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { has, parseArgs } from './lib/args.js';
import { report, type Row } from './lib/bench.js';
import { BRUSH_TARGETS, rectShape, sameTarget, targetName } from './lib/brush.js';
import { dataDir, roomsDir } from './lib/evidence.js';
import { capturedRooms, layOut, roomFrame } from './lib/rooms.js';
import { truthIn } from './lib/truth.js';

const args = parseArgs();
const live = has(args, 'live');
interface StoredSam {
  shape: SelectionShape;
  segmentation: Pick<Segmentation, 'frame' | 'detections'>;
  at: string;
}
const samFile = (dir: string) => join(dir, 'brush-sam.json');
/** Misses known and why; reported, but they don't fail the run. A box on part of a thing is one too. */
const KNOWN_GAPS: Record<string, string> = {
  'office-d desk whole':
    "SAM outlines the desk, but its outline covers under 60% of the room's drawing of it (MIN_COVERED), so the route reads it as nothing and uses the drawing",
  'office-d chair whole':
    'the chair is partly hidden behind the desk, so the camera sizes it short (ai-brush.md, photoBox)',
};

// Read before loading the server's .env, whose DATA_DIR is relative to its own checkout.
const rooms = capturedRooms().filter((r) => truthIn(r.dir));
if (!rooms.length) {
  console.log(
    `No captured room in ${roomsDir()} has marked points (truth.json): see scripts/lib/truth.ts.`,
  );
  process.exit(0);
}
let meta: MetaAdapter | null = null;
if (live) {
  // The running server's keys, when this is a worktree with no .env of its own.
  const env = join(dirname(dataDir()), '.env');
  if (!process.env.MODEL_API_KEY && existsSync(env)) process.loadEnvFile(env);
  // Spend kept in a throwaway store, so the server's ledger isn't touched.
  meta = new MetaAdapter(
    parseConfig(process.env),
    new EvidenceStore(mkdtempSync(join(tmpdir(), 'brush-bench-'))),
  );
}

const iou = (a: Bits, b: Bits) => {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.data.length; i++) {
    both += a.data[i]! & b.data[i]!;
    either += a.data[i]! | b.data[i]!;
  }
  return either ? both / either : NaN;
};

const rows: Row[] = [];
let asked = 0;
for (const captured of rooms) {
  const frame = roomFrame(captured);
  if (!frame) continue;
  const { layout, calibration } = layOut(captured);
  const memory = {
    mode: 'live',
    object: null,
    observation: null,
    zone: null,
    lastDecision: null,
    scene: layout.scene,
    camera: { ...calibration, scene: 'custom' },
  } as DeskMemory;
  const room = selectionRoom(memory);
  const stored: Record<string, StoredSam> = existsSync(samFile(captured.dir))
    ? JSON.parse(readFileSync(samFile(captured.dir), 'utf8'))
    : {};
  const things = [...new Set(truthIn(captured.dir)!.map((p) => p.thing))];
  for (const id of things) {
    const thing = layout.things.find((t) => t.id === id);
    const inventory = captured.input.inventory.things.find((t) => t.id === id);
    if (!thing || !inventory) continue;
    // What the room can name: a template's group; a thing drawn as an object isn't one.
    const wanted: SelectionTarget | null = thing.group
      ? { kind: 'prop', id: thing.group, label: '' }
      : null;
    const b = inventory.box;
    const [w, h] = [b.x2 - b.x1, b.y2 - b.y1];
    const boxes = {
      whole: rectShape(b),
      middle: rectShape({
        x1: b.x1 + w * 0.2,
        y1: b.y1 + h * 0.2,
        x2: b.x2 - w * 0.2,
        y2: b.y2 - h * 0.2,
      }),
    };
    for (const [part, shape] of Object.entries(boxes)) {
      const key = `${id}:${part}`;
      const caseName = `${captured.name} ${id} ${part}`;
      if (meta) {
        const p = selectionBox(shape, room.frame);
        const sam = await meta.segmentBoxes(
          `data:image/png;base64,${frame.toString('base64')}`,
          [{ id: 1, box: { left: p.left, top: p.top, right: p.right, bottom: p.bottom } }],
          room.frame.width,
          room.frame.height,
        );
        asked++;
        stored[key] = {
          shape,
          segmentation: { frame: sam.output.frame, detections: sam.output.detections },
          at: new Date().toISOString(),
        };
      }
      const panel = room.resolve(selectionMask(shape, room.frame));
      const named = sameTarget(panel.target, wanted);
      const answer = stored[key];
      const fresh = answer && JSON.stringify(answer.shape) === JSON.stringify(shape);
      const notes: Record<string, string> = {
        panel: targetName(panel.target),
      };
      const metrics: Row['metrics'] = {
        named: { value: named ? 1 : 0, target: 1, better: 'higher', digits: 0 },
      };
      // A box on the middle of a thing covers too little of it for the panel to name it, and SAM outlines a piece.
      const knownGap = part === 'middle' || caseName in KNOWN_GAPS;
      if (!fresh) {
        notes.SAM = 'no answer: --live';
        rows.push({ case: caseName, variant: 'as built', metrics, notes, knownGap });
        continue;
      }
      // As the route does: SAM's largest outline cut to the box, kept when it is of the panel's target.
      const sam = samMask(answer.segmentation, shape, room.frame);
      const { outline, samMissed } = keepOutline(room, shape, panel.target, sam);
      // The request's target is the panel's; `agree` holds that, as the route does.
      metrics.agree = { value: 1, target: BRUSH_TARGETS.agree, better: 'higher', digits: 0 };
      notes.SAM = !answer.segmentation.detections.length
        ? 'found none'
        : samMissed
          ? `replaced (it outlined ${samMissed})`
          : panel.target
            ? 'kept'
            : 'kept (no target to check it by)';
      const drawn = drawnOf(room, panel.target);
      if (drawn) {
        const inside = selectionMask(shape, room.frame);
        for (let i = 0; i < drawn.data.length; i++)
          drawn.data[i] = drawn.data[i]! & inside.data[i]!;
        const v = iou(sam, drawn);
        if (Number.isFinite(v))
          metrics.IoU = { value: v, target: BRUSH_TARGETS.samIoU, better: 'higher' };
      }
      const camera = photoBox(room.camera, outline, room.scene.grid);
      const own = panel.target?.kind === 'prop' ? groupBounds(room.scene, panel.target.id) : null;
      if (camera && own) {
        const cm = (tiles: number) => tiles * ISO_TILE_CM;
        const gap = Math.max(
          Math.abs(camera.w - cm(own.size.w)) / cm(own.size.w),
          Math.abs(camera.d - cm(own.size.d)) / cm(own.size.d),
          Math.abs(camera.h - cm(own.size.h)) / cm(own.size.h),
        );
        metrics.size = {
          value: gap,
          target: BRUSH_TARGETS.sizeGap,
          better: 'lower',
          unit: '%',
          digits: 0,
        };
      }
      rows.push({
        case: caseName,
        variant: 'as built',
        metrics,
        notes,
        knownGap,
      });
    }
  }
  if (meta) writeFileSync(samFile(captured.dir), JSON.stringify(stored), { mode: 0o600 });
}
const code = report(rows, args, 'brush');
const gaps = rows.filter((r) => r.case in KNOWN_GAPS);
if (gaps.length)
  console.log(`\nknown gaps:\n${gaps.map((r) => `  ${r.case}: ${KNOWN_GAPS[r.case]}`).join('\n')}`);
if (meta)
  console.log(`\nasked SAM ${asked} times: $${(asked * META_PRICES.samPerImage).toFixed(4)}`);
process.exit(code);
