/**
 * Captured real rooms (see scripts/lib/rooms.ts), laid out again with this
 * tree's code and compared with the layout last accepted for each: how far
 * the furthest thing moved or was resized, things turned, and things whose
 * status changed (placed, outside the room…). A snapshot, not the truth: it
 * catches a change that moves real rooms, and the overlay shows whether the
 * move is better. Rooms are local only; with none captured it says how.
 *
 * A room with points marked by hand where things touch down (`truth.json`,
 * scripts/lib/truth.ts, `bun run truth`) is also measured against them: the
 * median distance in pixels from where the layout draws each, against MARKED,
 * and the points over its overlay (green marked, red drawn). That one is the
 * truth, so in a marked room it alone is judged: what moved against the
 * snapshot is only noted. Each mark's own error is kept for `--compare`.
 *
 *   bun run bench:rooms                  → out/rooms-<name>.png (over the frame) and -iso.png
 *   bun run bench:rooms --marks          each marked point's error, room by room
 *   bun run bench:rooms --set layout.pastTop=2,4,8   sweep the layout's numbers
 *   bun run bench:rooms --accept         keep this tree's layouts as expected
 *   bun run bench:rooms --accept office  only that room
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { flag, has, parseArgs, variants, withVariant } from './lib/args.js';
import { report, type Row } from './lib/bench.js';
import { roomsDir } from './lib/evidence.js';
import { isoPicture, layoutOverlay } from './lib/overlay.js';
import { compare, placementTable, placements } from './lib/placements.js';
import { acceptRoom, capturedRooms, expectedOf, layOut, roomFrame } from './lib/rooms.js';
import { errorLine, markName, placementError, truthIn, truthSvg } from './lib/truth.js';

/** How far anything may move or grow before a change counts, in tiles. */
const TOLERANCE = 0.15;
/** The median marked point may be this far from where the layout draws it, in pixels: a hand's mark is good to about 10. */
const MARKED = 15;
const args = parseArgs();
const rooms = capturedRooms();
if (!rooms.length) {
  console.log(
    `No captured rooms in ${roomsDir()}. Capture a draft with \`bun run draft capture <run> --name <room>\`.`,
  );
  process.exit(0);
}
const out = resolve(import.meta.dir, '..', 'out');
mkdirSync(out, { recursive: true });

if (has(args, 'accept')) {
  const only = flag(args, 'accept');
  for (const room of rooms.filter((r) => only === 'true' || r.name === only)) {
    acceptRoom(room);
    console.log(`Accepted ${room.name}: its layout with this tree is what the bench expects now.`);
  }
  process.exit(0);
}

const rows: Row[] = [];
const details: string[] = [];
const swept = variants(args.flags.get('set'));
const marksTable: string[] = [];
for (const v of swept)
  for (const room of rooms) {
    const start = performance.now();
    const { layout, calibration, refined } = withVariant(v, () => layOut(room));
    const ms = Math.round(performance.now() - start);
    const now = placements(layout);
    const expected = expectedOf(room) ?? now;
    const changes = compare(expected, now);
    const finite = (x: number) => (Number.isFinite(x) ? x : 0);
    const worst = changes.reduce((a, c) =>
      Math.max(finite(c.moved), finite(c.resized)) > Math.max(finite(a.moved), finite(a.resized))
        ? c
        : a,
    );
    const truth = truthIn(room.dir);
    const errors = truth ? placementError(layout, calibration.camera, truth) : null;
    const marked = errors ? errorLine(errors) : null;
    const furthest = errors?.reduce((a, e) => (e.error > a.error ? e : a));
    const moved = Math.max(0, ...changes.map((c) => Math.max(finite(c.moved), finite(c.resized))));
    const turned = changes.filter((c) => c.turned).length;
    const status = changes.filter((c) => c.status || c.only).length;
    rows.push({
      case: room.name,
      variant: v.label,
      // A marked room is judged by its marks; what moved against the snapshot is only noted.
      metrics: marked
        ? { marked: { value: marked.median, target: MARKED, better: 'lower', digits: 0 } }
        : {
            moved: { value: moved, target: TOLERANCE, better: 'lower', unit: 'tiles' },
            turned: { value: turned, target: 0, better: 'lower', digits: 0 },
            status: { value: status, target: 0, better: 'lower', digits: 0 },
          },
      notes: {
        ...(marked ? { snapshot: `moved ${moved.toFixed(2)}, ${turned} turned` } : {}),
        worst: worst.id,
        ms: String(ms),
        things: String(layout.things.length),
        ...(refined ? { wall: `${refined.wall} turned ${refined.degrees}°` } : {}),
        ...(furthest ? { furthest: `${furthest.thing} ${Math.round(furthest.error)} px` } : {}),
      },
      ...(errors ? { details: Object.fromEntries(errors.map((e) => [markName(e), e.error])) } : {}),
    });
    if (errors && has(args, 'marks'))
      marksTable.push(
        `${room.name}${swept.length > 1 ? ` · ${v.label}` : ''}:\n${errors
          .map(
            (e) =>
              `  ${markName(e).padEnd(22)} ${Number.isFinite(e.error) ? `${Math.round(e.error)} px` : 'not drawn'}${e.note ? `  (${e.note})` : ''}`,
          )
          .join('\n')}`,
      );
    // Pictures and the snapshot's table for the build as it is, not every variant of a sweep.
    if (v !== swept[0]) continue;
    const file = resolve(out, `rooms-${room.name}.png`);
    const drawn = await layoutOverlay(layout, calibration.camera, roomFrame(room));
    writeFileSync(
      file,
      errors
        ? await sharp(drawn)
            .composite([{ input: truthSvg(errors, calibration.camera.frame) }])
            .png()
            .toBuffer()
        : drawn,
    );
    writeFileSync(resolve(out, `rooms-${room.name}-iso.png`), await isoPicture(layout));
    if (
      changes.some(
        (c) => c.moved > TOLERANCE || c.resized > TOLERANCE || c.turned || c.status || c.only,
      )
    )
      details.push(`${room.name} (${file}):\n${placementTable(now, expected)}`);
  }
if (marksTable.length) console.log(`${marksTable.join('\n\n')}\n`);
const code = report(rows, args, 'rooms bench', swept);
if (details.length)
  console.log(
    `\n${details.join('\n\n')}\n\nLook at the overlays; \`bun run bench:rooms --accept\` keeps a change that is better.`,
  );
process.exit(code);
