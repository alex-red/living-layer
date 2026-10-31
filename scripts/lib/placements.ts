/**
 * Where a room layout put each thing, in a form that compares across code
 * changes: its middle, footprint and turn in tiles, and its status. The
 * draft tool prints these, and the rooms bench keeps them as snapshots.
 */
import { groupBounds, type PhotoLayout } from '@livinglayer/domain';

export interface Placement {
  status: string;
  /** What it is drawn as: a template or an object model. */
  as: string;
  /** Its middle on the floor or on what it stands on, in tiles. */
  x: number;
  y: number;
  z: number;
  /** Its footprint once turned, and its height, in tiles. */
  w: number;
  d: number;
  h: number;
  turns: number;
}

export function placements(layout: PhotoLayout): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  for (const t of layout.things) {
    const box = t.group ? groupBounds(layout.scene, t.group) : (t.foot ?? null);
    const turns = t.group
      ? (layout.scene.props.find((p) => p.group === t.group && p.id === t.group)?.turns ?? 0)
      : (t.turns ?? 0);
    out[t.id] = {
      status: t.status,
      as: t.as,
      x: box ? box.at.x + box.size.w / 2 : NaN,
      y: box ? box.at.y + box.size.d / 2 : NaN,
      z: box?.at.z ?? NaN,
      w: box?.size.w ?? NaN,
      d: box?.size.d ?? NaN,
      h: box?.size.h ?? NaN,
      turns,
    };
  }
  return out;
}

/** How one set of placements differs from another, thing by thing. */
export interface Change {
  id: string;
  /** How far its middle moved, in tiles; NaN when either side has no place. */
  moved: number;
  /** How much its footprint or height changed, in tiles. */
  resized: number;
  turned: boolean;
  status?: { from: string; to: string };
  /** In only one of the two. */
  only?: 'before' | 'after';
}
export function compare(
  before: Record<string, Placement>,
  after: Record<string, Placement>,
): Change[] {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return ids.map((id) => {
    const a = before[id];
    const b = after[id];
    if (!a || !b)
      return { id, moved: NaN, resized: NaN, turned: false, only: a ? 'before' : 'after' };
    return {
      id,
      moved: Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z),
      resized: Math.max(Math.abs(b.w - a.w), Math.abs(b.d - a.d), Math.abs(b.h - a.h)),
      turned: a.turns !== b.turns,
      ...(a.status !== b.status ? { status: { from: a.status, to: b.status } } : {}),
    };
  });
}

const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '–');
/** The placements as a table, with what moved since `before` when given. */
export function placementTable(
  now: Record<string, Placement>,
  before?: Record<string, Placement>,
): string {
  const changes = before ? new Map(compare(before, now).map((c) => [c.id, c])) : null;
  const rows = Object.entries(now).map(([id, p]) => {
    const c = changes?.get(id);
    return [
      id,
      p.as,
      p.status,
      `${f(p.x)}, ${f(p.y)}, ${f(p.z)}`,
      `${f(p.w)} × ${f(p.d)} × ${f(p.h)}`,
      String(p.turns),
      ...(changes
        ? [
            c?.only
              ? 'new'
              : [
                  c && c.moved > 0.005 ? `moved ${f(c.moved)}` : '',
                  c && c.resized > 0.005 ? `resized ${f(c.resized)}` : '',
                  c?.turned ? 'turned' : '',
                  c?.status ? `${c.status.from} → ${c.status.to}` : '',
                ]
                  .filter(Boolean)
                  .join(', ') || '–',
          ]
        : []),
    ];
  });
  const head = ['thing', 'as', 'status', 'middle (tiles)', 'size (tiles)', 'turns'];
  if (changes) head.push('since');
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)) + 2);
  return all
    .map((r) =>
      r
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join('')
        .trimEnd(),
    )
    .join('\n');
}
