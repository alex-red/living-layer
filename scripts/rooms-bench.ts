/**
 * Captured real rooms (see scripts/lib/rooms.ts), laid out again with this
 * tree's code and compared with the layout last accepted for each: how far
 * the furthest thing moved or was resized, things turned, and things whose
 * status changed (placed, outside the room…). A snapshot, not the truth: it
 * catches a change that moves real rooms, and the overlay shows whether the
 * move is better. Rooms are local only; with none captured it says how.
 *
 *   bun run bench:rooms                  → out/rooms-<name>.png for each room
 *   bun run bench:rooms --accept         keep this tree's layouts as expected
 *   bun run bench:rooms --accept office  only that room
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flag, has, parseArgs } from './lib/args.js';
import { report, type Row } from './lib/bench.js';
import { roomsDir } from './lib/evidence.js';
import { layoutOverlay } from './lib/overlay.js';
import { compare, placementTable, placements } from './lib/placements.js';
import { acceptRoom, capturedRooms, expectedOf, layOut, roomFrame } from './lib/rooms.js';

/** How far anything may move or grow before a change counts, in tiles. */
const TOLERANCE = 0.15;
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
for (const room of rooms) {
  const start = performance.now();
  const layout = layOut(room);
  const ms = Math.round(performance.now() - start);
  const now = placements(layout);
  const expected = expectedOf(room) ?? now;
  const changes = compare(expected, now);
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const worst = changes.reduce((a, c) =>
    Math.max(finite(c.moved), finite(c.resized)) > Math.max(finite(a.moved), finite(a.resized))
      ? c
      : a,
  );
  rows.push({
    case: room.name,
    variant: 'as built',
    metrics: {
      moved: {
        value: Math.max(0, ...changes.map((c) => Math.max(finite(c.moved), finite(c.resized)))),
        target: TOLERANCE,
        better: 'lower',
        unit: 'tiles',
      },
      turned: {
        value: changes.filter((c) => c.turned).length,
        target: 0,
        better: 'lower',
        digits: 0,
      },
      status: {
        value: changes.filter((c) => c.status || c.only).length,
        target: 0,
        better: 'lower',
        digits: 0,
      },
    },
    notes: { worst: worst.id, ms: String(ms), things: String(layout.things.length) },
  });
  const file = resolve(out, `rooms-${room.name}.png`);
  writeFileSync(file, await layoutOverlay(layout, room.input.calibration.camera, roomFrame(room)));
  if (
    changes.some(
      (c) => c.moved > TOLERANCE || c.resized > TOLERANCE || c.turned || c.status || c.only,
    )
  )
    details.push(`${room.name} (${file}):\n${placementTable(now, expected)}`);
}
const code = report(rows, args, 'rooms bench');
if (details.length)
  console.log(
    `\n${details.join('\n\n')}\n\nLook at the overlays; \`bun run bench:rooms --accept\` keeps a change that is better.`,
  );
process.exit(code);
