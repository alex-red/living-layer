import {
  FOOD_LEFT,
  STAT_KINDS,
  ago,
  statWords,
  dayOf,
  daysUntil,
  foodHealth,
  foodNow,
  toIso,
  type Food,
  type IsoVec,
  type StatKey,
  type StatNow,
} from '@livinglayer/domain';
import { useMemo } from 'react';
import { useNow } from '../useNow';
import { useZoomView } from '../ZoomPan';
import { useThingStats } from '../workspace/state/stats';
import { statTone } from './StatBadges';
import type { IsoObject } from './IsoScene';

/**
 * Cards for the things the camera places (the mug, a mouse) that keep stats,
 * by their thing's id, each on the top of its box. Selecting one opens it as
 * an object: the mug is the outline's `main`.
 */
export function sightedCallouts(
  objects: readonly IsoObject[],
  statsOf: (thingId: string) => readonly StatKey[],
  select: (objectId: string) => void,
): IsoCallout[] {
  return objects.flatMap((o) => {
    const id = o.thingId ?? o.id;
    const stats = statsOf(id);
    if (!stats.length) return [];
    const { at, size } = o.box;
    return [
      {
        id,
        label: o.label,
        anchor: { x: at.x + size.w / 2, y: at.y + size.d / 2, z: at.z + size.h },
        stats,
        onSelect: () => select(o.id === 'tracked' ? 'main' : o.id),
      },
    ];
  });
}

/** A thing the stats layer writes up: a card beside the room, a line to the thing. */
export interface IsoCallout {
  id: string;
  label: string;
  /** Where the line ends: the top of the thing, in the room. */
  anchor: IsoVec;
  /** Drawn with the room, keeping nothing yet: the card says how to start. */
  builtIn?: boolean;
  food?: Food;
  /** Stats it keeps, read live by its id. */
  stats?: readonly StatKey[];
  lamp?: boolean;
  /** What can be done to it from its card: on and off for a thing a light, switch or desktop drives. */
  actions?: readonly CalloutAction[];
  onSelect?: () => void;
}
/** A button on a card. `current` marks the one it is now (on when it is on). */
interface CalloutAction {
  label: string;
  current?: boolean;
  run: () => void;
}

/**
 * How the cards fit the pane: `full` cards with every line; `compact`, when
 * a card would be drawn small, its name, use-by and health in larger type;
 * `pips`, when even those can't be read, no cards, only each thing's health
 * bar over it.
 */
export type CalloutDensity = 'full' | 'compact' | 'pips';
/** Card width, in the scene's own units (a tile is 64 wide): the same in every density, so the view keeps its size. */
const W = 104;
/** How much wider each side of the scene is drawn to hold a column of cards. */
export const CALLOUT_SIDE = W + 14;
const GAP = 6;
const PAD = 6;
/** A card's heading and line heights, by density. */
const METRICS = { full: { head: 15, line: 11 }, compact: { head: 17, line: 14 } };
/**
 * The density for a card drawn `cardPx` wide on screen, from the one now. Each
 * step back up needs room to spare, so a pane at the edge doesn't flicker
 * (pips draw no columns, so the room itself is drawn larger then).
 */
export function calloutDensity(cardPx: number, now: CalloutDensity): CalloutDensity {
  if (now === 'pips') return cardPx > 135 ? 'compact' : 'pips';
  if (cardPx < 80) return 'pips';
  if (now === 'compact') return cardPx > 175 ? 'full' : 'compact';
  return cardPx < 150 ? 'compact' : 'full';
}
export const CALLOUT_WIDTH = W;

/** How many lines a card takes, so the cards can be stacked before they render. */
function linesOf(c: IsoCallout, density: CalloutDensity): number {
  const actions = c.actions?.length && !c.builtIn ? 1 : 0;
  if (density === 'compact') return (c.builtIn ? 1 : c.food?.expires ? 2 : 1) + actions;
  if (c.builtIn) return 2;
  const food = c.food
    ? 1 + (c.food.expires ? 1 : 0) + (c.food.left ? 1 : 0) + (c.food.opened ? 1 : 0)
    : 0;
  const said = food + (c.stats?.length ?? 0);
  // A card with only its buttons to show says nothing more.
  return Math.max(actions ? 0 : 1, said) + actions;
}
const heightOf = (c: IsoCallout, density: CalloutDensity) => {
  const m = METRICS[density === 'compact' ? 'compact' : 'full'];
  return m.head + linesOf(c, density) * m.line + PAD;
};

interface Placed {
  c: IsoCallout;
  at: { sx: number; sy: number };
  x: number;
  y: number;
  /** Its height as drawn, in scene units. */
  h: number;
  side: 'left' | 'right';
  /** How much the card is drawn scaled: 1 at fit, 1 / zoom when zoomed, so it keeps its size. */
  k: number;
}
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/**
 * The part of the scene a zoomed view shows, in scene units: the scene is
 * drawn in a `view.w` × `view.h` box, fitted like `xMidYMid meet`, then
 * scaled by `view.s` and moved by `view.x`, `view.y`.
 */
export function visibleScene(
  view: { s: number; x: number; y: number; w: number; h: number },
  box: { minX: number; minY: number; width: number; height: number },
): Bounds {
  const k = Math.min(view.w / box.width, view.h / box.height);
  const ox = (view.w - box.width * k) / 2;
  const oy = (view.h - box.height * k) / 2;
  const toX = (px: number) => box.minX + ((px - view.x) / view.s - ox) / k;
  const toY = (py: number) => box.minY + ((py - view.y) / view.s - oy) / k;
  return { minX: toX(0), maxX: toX(view.w), minY: toY(0), maxY: toY(view.h) };
}
/**
 * The cards in two columns at the scene's sides. Things are split left to
 * right where the two columns come out nearest the same height, so lines
 * don't cross; each card sits by its thing's height on screen, pushed down
 * so none overlap. `extent` is how far the columns reach, for the view to
 * grow to. With `zoom`, the cards are drawn that much smaller, so a zoomed
 * view keeps them their size on screen at its edges.
 */
export function layoutCallouts(
  callouts: IsoCallout[],
  bounds: Bounds,
  density: CalloutDensity = 'full',
  zoom = 1,
): { placed: Placed[]; extent: { minY: number; maxY: number } } {
  const k = 1 / zoom;
  const all = callouts
    .map((c) => ({ c, at: toIso(c.anchor), h: heightOf(c, density) * k }))
    .sort((a, b) => a.at.sx - b.at.sx);
  const gap = GAP * k;
  const total = all.reduce((sum, a) => sum + a.h + gap, 0);
  let split = 0;
  let best = Infinity;
  for (let i = 0, left = 0; i <= all.length; left += i < all.length ? all[i]!.h + gap : 0, i++) {
    const off = Math.abs(left - (total - left));
    if (off < best) [best, split] = [off, i];
  }
  const placed: Placed[] = [];
  let minY = bounds.minY;
  let maxY = bounds.maxY;
  for (const side of ['left', 'right'] as const) {
    const column = (side === 'left' ? all.slice(0, split) : all.slice(split)).sort(
      (a, b) => a.at.sy - b.at.sy,
    );
    const x = side === 'left' ? bounds.minX + 4 * k : bounds.maxX - (4 + W) * k;
    const height = column.reduce((sum, a) => sum + a.h + gap, -gap);
    // A column taller than the room starts above it; the view grows to hold it.
    let next = Math.min(bounds.minY + 4 * k, (bounds.minY + bounds.maxY) / 2 - height / 2);
    for (const { c, at, h } of column) {
      const y = Math.max(next, at.sy - h / 2 - 30 * k);
      next = y + h + gap;
      placed.push({ c, at, x, y, h, side, k });
    }
    if (column.length) {
      minY = Math.min(minY, placed.find((p) => p.side === side)!.y - 4 * k);
      maxY = Math.max(maxY, next - gap + 4 * k);
    }
  }
  return { placed, extent: { minY, maxY } };
}

/**
 * How far below the pane's top each column of cards starts, in pixels: clear
 * of the view's tag and Randomize on the left, the zoom and "Your day" on the right.
 */
const CORNER_PX = { left: 60, right: 72 } as const;
/** How far in from the pane's sides the cards keep, in pixels, however small or zoomed the view. */
const SIDE_PX = 12;

/**
 * The cards moved down, a column at a time and keeping their order, so none
 * starts in the pane's top corners. `top` is the pane's top edge in scene
 * units and `pxPerUnit` how many pixels a scene unit is drawn.
 */
export function clearCorners(placed: Placed[], top: number, pxPerUnit: number): Placed[] {
  let out = placed;
  for (const side of ['left', 'right'] as const) {
    const ys = placed.filter((p) => p.side === side).map((p) => p.y);
    const shift = ys.length ? top + CORNER_PX[side] / pxPerUnit - Math.min(...ys) : 0;
    if (shift > 0) out = out.map((p) => (p.side === side ? { ...p, y: p.y + shift } : p));
  }
  return out;
}

/**
 * The cards moved in from the pane's sides, a column at a time, so each keeps
 * `SIDE_PX` clear of its edge on screen, however few pixels a scene unit is.
 * `seen` is what the pane shows, in scene units.
 */
export function clearSides(
  placed: Placed[],
  seen: { minX: number; maxX: number },
  pxPerUnit: number,
): Placed[] {
  const inset = SIDE_PX / pxPerUnit;
  return placed.map((p) => {
    const x =
      p.side === 'left'
        ? Math.max(p.x, seen.minX + inset)
        : Math.min(p.x, seen.maxX - inset - W * p.k);
    return x === p.x ? p : { ...p, x };
  });
}

/**
 * How much bigger than at fit a card is drawn in a pane with `spare` scene
 * units bare at each side: as big as fits between the pane's side and the
 * room, but no wider on screen than a readable card needs. 1 with nothing to spare.
 */
function spreadScale(spare: number, pxPerUnit: number): number {
  if (spare * pxPerUnit < 8) return 1;
  // The column, its gap and the side inset all fit between the pane's side and the room.
  const room = (CALLOUT_SIDE + spare - SIDE_PX / pxPerUnit) / (W + 4);
  return Math.max(1, Math.min(room, READABLE_PX / (W * pxPerUnit)));
}
/**
 * How wide a card is drawn on screen in a `pane` (pixels) showing a room of
 * `room` scene units, its card columns beside it: wider than at fit where a
 * short, wide pane leaves its sides bare (`spreadCallouts`). What picks the
 * cards' density.
 */
export function cardPx(pane: { w: number; h: number }, room: { w: number; h: number }): number {
  const w = room.w + 2 * CALLOUT_SIDE;
  const px = Math.min(pane.w / w, pane.h / room.h);
  return W * px * spreadScale((pane.w / px - w) / 2, px);
}
/**
 * The cards in a pane wider than the scene (a short, wide one: a phone on its
 * side), where the room is fitted to the height and the sides are bare: the
 * columns move out to the pane's sides and the cards grow into the room they
 * leave, to a readable size (`READABLE_PX`), never over the room nor past the pane's top and
 * bottom. Null when there is no width to spare. `box` is the scene's view box
 * (the room and its card columns), `seen` what the pane shows of it.
 */
export function spreadCallouts(
  callouts: IsoCallout[],
  seen: Bounds,
  box: { minX: number; width: number },
  pxPerUnit: number,
  density: CalloutDensity = 'full',
): Placed[] | null {
  const k = spreadScale((seen.maxX - seen.minX - box.width) / 2, pxPerUnit);
  return k > 1.02 ? withinHeight(callouts, seen, density, k, 1) : null;
}
/**
 * The cards laid out in `seen` drawn `k` times their size, made smaller (to
 * no less than `least`) until their columns fit its height. Null when even
 * `least` is as big as `k` already and they still don't.
 */
function withinHeight(
  callouts: IsoCallout[],
  seen: Bounds,
  density: CalloutDensity,
  k: number,
  least: number,
): Placed[] | null {
  for (let tries = 0; tries < 3; tries++) {
    const { placed, extent } = layoutCallouts(callouts, seen, density, 1 / k);
    const tall = (extent.maxY - extent.minY) / (seen.maxY - seen.minY);
    if (tall <= 1 || k <= least) return placed;
    k = Math.max(least, k / tall);
  }
  return null;
}
/** A zoomed card's width on screen at least, in pixels: at most this share of the pane's. */
const READABLE_PX = 120;
const READABLE_SHARE = 0.22;
/**
 * The cards zoomed in, at the edges of what is seen: as big on screen as at
 * fit, but no smaller than a readable width the pane can spare, nor so big
 * their columns overrun its height.
 */
export function zoomedCallouts(
  callouts: IsoCallout[],
  seen: Bounds,
  pxPerUnit: number,
  paneWidth: number,
  zoom: number,
  density: CalloutDensity = 'full',
): Placed[] {
  const least = 1 / zoom;
  const readable = Math.min(READABLE_PX, paneWidth * READABLE_SHARE) / (W * pxPerUnit);
  return (
    withinHeight(callouts, seen, density, Math.max(least, readable), least) ??
    layoutCallouts(callouts, seen, density, zoom).placed
  );
}

/**
 * The stats layer's cards as the view is zoomed: at fit, beside the room as
 * `fit` laid them out; zoomed in, at the edges of what the pane shows, their
 * own size on screen, only for the things in sight. Reads the zoom itself, so
 * a pan draws only the cards again.
 */
export function ZoomedCallouts({
  callouts,
  fit,
  viewBox,
  density = 'full',
}: {
  callouts: IsoCallout[];
  fit: Placed[];
  viewBox: { minX: number; minY: number; width: number; height: number };
  density?: CalloutDensity;
}) {
  const view = useZoomView();
  const zoomed = view.s > 1 && view.w > 0 && view.h > 0 && density !== 'pips';
  const shown = useMemo(() => {
    if (!view.w || !view.h) return fit;
    const seen = visibleScene(view, viewBox);
    const px = Math.min(view.w / viewBox.width, view.h / viewBox.height) * view.s;
    if (!zoomed) {
      const spread =
        density === 'pips' ? null : spreadCallouts(callouts, seen, viewBox, px, density);
      return clearSides(clearCorners(spread ?? fit, seen.minY, px), seen, px);
    }
    const inSight = callouts.filter((c) => {
      const at = toIso(c.anchor);
      return at.sx > seen.minX && at.sx < seen.maxX && at.sy > seen.minY && at.sy < seen.maxY;
    });
    const laid = zoomedCallouts(inSight, seen, px, view.w, view.s, density);
    return clearSides(clearCorners(laid, seen.minY, px), seen, px);
  }, [zoomed, fit, view, viewBox, callouts, density]);
  return <Callouts placed={shown} density={density} />;
}

/**
 * The stats layer: a card for each thing with something to say (food's use-by
 * day and how much is left, its stats), joined to the thing by a thin elbow
 * line, beside the room rather than over it.
 */
function Callouts({ placed, density = 'full' }: { placed: Placed[]; density?: CalloutDensity }) {
  const now = useNow(60_000);
  const head = METRICS[density === 'compact' ? 'compact' : 'full'].head;
  if (density === 'pips')
    return (
      <g className="iso-callouts pips" aria-label="Things’ freshness">
        {placed.map(({ c, at }) => (
          <g key={c.id} className="iso-callout" data-callout={c.id}>
            <HealthPip food={c.food} at={at} now={now} />
          </g>
        ))}
      </g>
    );
  return (
    <g className={`iso-callouts ${density}`} aria-label="Things’ stats">
      {placed.map(({ c, at, x, y, h, side, k }) => {
        const edge = side === 'left' ? x + W * k : x;
        const knee = side === 'left' ? edge + 10 * k : edge - 10 * k;
        const lineY = y + (head / 2 + 1) * k;
        const tone = c.builtIn ? 'idle' : (foodNow(c.food, now)?.tone ?? 'ok');
        return (
          <g key={c.id} className={`iso-callout ${tone}`} data-callout={c.id}>
            <polyline
              className="iso-callout-line"
              points={`${edge},${lineY} ${knee},${lineY} ${at.sx},${at.sy}`}
            />
            <circle className="iso-callout-dot" cx={at.sx} cy={at.sy} r={1.8} />
            <HealthPip food={c.food} at={at} now={now} />
            <foreignObject
              x={0}
              y={0}
              width={W}
              height={h / k}
              transform={`translate(${x} ${y}) scale(${k})`}
            >
              <div className="callout-card">
                <button
                  type="button"
                  className="callout-main"
                  onClick={c.onSelect}
                  title={c.builtIn ? `Open the ${c.label.toLowerCase()}` : undefined}
                >
                  <span className="callout-name">{c.label}</span>
                  {density === 'compact' ? (
                    <CompactLines c={c} now={now} />
                  ) : c.builtIn ? (
                    <>
                      <span className="callout-row muted">Drawn with the room</span>
                      <span className="callout-row hint">Make it a thing to track it</span>
                    </>
                  ) : (
                    <>
                      <FoodLines food={c.food} now={now} />
                      {c.stats?.length ? (
                        <StatLines id={c.id} keys={c.stats} lamp={c.lamp} now={now} />
                      ) : !c.food && !c.actions?.length ? (
                        <span className="callout-row muted">Nothing kept yet</span>
                      ) : null}
                    </>
                  )}
                </button>
                {!c.builtIn && c.actions?.length ? (
                  <span className="callout-actions">
                    {c.actions.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className={a.current ? 'current' : undefined}
                        aria-pressed={a.current ?? false}
                        onClick={a.run}
                      >
                        {a.label}
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
            </foreignObject>
          </g>
        );
      })}
    </g>
  );
}

/** A compact card's lines: its use-by and health, else what it would say first. */
function CompactLines({ c, now }: { c: IsoCallout; now: number }) {
  if (c.builtIn) return <span className="callout-row hint">Make it a thing</span>;
  const status = foodNow(c.food, now);
  const health = foodHealth(c.food, now);
  if (!c.food?.expires || !status)
    return c.stats?.length ? (
      <StatLines id={c.id} keys={c.stats.slice(0, 1)} lamp={c.lamp} now={now} />
    ) : c.actions?.length ? null : (
      <span className="callout-row muted">Nothing kept yet</span>
    );
  return (
    <>
      <span className={`callout-row big ${status.tone}`}>{status.text.split(' · ')[0]}</span>
      {health !== null && <HealthBar health={health} tone={status.tone} />}
    </>
  );
}
/** Health bar cells: each a tenth of its keeping time. */
const CELLS = 10;
/**
 * Its freshness over it in the room, like a game's health bar: a small bar
 * above the line's end, emptying as its use-by day nears.
 */
function HealthPip({
  food,
  at,
  now,
}: {
  food?: Food | undefined;
  at: { sx: number; sy: number };
  now: number;
}) {
  const health = foodHealth(food, now);
  if (health === null) return null;
  const w = 16;
  const h = 2.6;
  const x = at.sx - w / 2;
  const y = at.sy - 7;
  return (
    <g className={`iso-health ${foodNow(food, now)?.tone ?? 'ok'}`} aria-hidden="true">
      <rect
        className="iso-health-back"
        x={x - 0.6}
        y={y - 0.6}
        width={w + 1.2}
        height={h + 1.2}
        rx={0.8}
      />
      <rect
        className="iso-health-fill"
        x={x}
        y={y}
        width={Math.max(health > 0 ? 0.8 : 0, w * health)}
        height={h}
        rx={0.4}
      />
      {Array.from({ length: CELLS - 1 }, (_, i) => (
        <line
          key={i}
          className="iso-health-tick"
          x1={x + ((i + 1) * w) / CELLS}
          x2={x + ((i + 1) * w) / CELLS}
          y1={y}
          y2={y + h}
        />
      ))}
    </g>
  );
}
/** Its freshness as a bar of ten cells on its card, with how much of it is left. */
function HealthBar({ health, tone }: { health: number; tone: string }) {
  const lit = Math.ceil(health * CELLS);
  return (
    <span
      className={`callout-row health ${tone}`}
      aria-label={`${Math.round(health * 100)}% fresh`}
    >
      <span className="callout-health" aria-hidden="true">
        {Array.from({ length: CELLS }, (_, i) => (
          <i key={i} className={i < lit ? 'on' : ''} />
        ))}
      </span>
      <span className="callout-health-value">{Math.round(health * 100)}%</span>
    </span>
  );
}
/** Its use-by line, its health bar, a meter of how much is left, and since when it is open. */
function FoodLines({ food, now }: { food?: Food | undefined; now: number }) {
  const status = foodNow(food, now);
  if (!food) return null;
  const left = food.left ?? 'full';
  // Full is all five steps, empty none.
  const steps = FOOD_LEFT.length - 1 - FOOD_LEFT.indexOf(left);
  const open = food.opened ? -daysUntil(food.opened, dayOf(now)) : null;
  const health = foodHealth(food, now);
  return (
    <>
      <span className={`callout-row big ${status?.tone ?? 'ok'}`}>
        {food.expires ? (status?.text.split(' · ')[0] ?? '') : 'No use-by day'}
      </span>
      {health !== null && <HealthBar health={health} tone={status?.tone ?? 'ok'} />}
      {food.left && (
        <span className="callout-row" aria-label={`${left} left`}>
          <span className="callout-meter" aria-hidden="true">
            {Array.from({ length: FOOD_LEFT.length - 1 }, (_, i) => (
              <i key={i} className={i < steps ? 'on' : ''} />
            ))}
          </span>
          {left === 'full' ? 'Full' : `${left[0]!.toUpperCase()}${left.slice(1)} left`}
        </span>
      )}
      {open !== null && (
        <span className="callout-row muted">
          {open <= 0 ? 'Opened today' : `Opened ${open} day${open === 1 ? '' : 's'} ago`}
        </span>
      )}
    </>
  );
}

/** A stat's value after its name: "12 min ago", "On · 2 h", or that the camera hasn't seen it. */
function statLine(key: StatKey, s: StatNow | undefined, now: number): string {
  if (!s || s.value === null) return 'not seen yet';
  const since = STAT_KINDS[key].value === 'onOff' && s.since ? ` · ${ago(now - s.since)}` : '';
  return `${statWords(key, s.value, now)}${since}`;
}
/** Each stat it keeps, worded after its name, in its tone. */
function StatLines({
  id,
  keys,
  lamp,
  now,
}: {
  id: string;
  keys: readonly StatKey[];
  lamp?: boolean | undefined;
  now: number;
}) {
  const stats = useThingStats(id);
  return keys.map((key) => {
    const s: StatNow | undefined = stats?.[key];
    return (
      <span key={key} className={`callout-row stat ${s ? statTone(s, lamp) : 'unknown'}`}>
        <b>{STAT_KINDS[key].label}</b> {statLine(key, s, now)}
      </span>
    );
  });
}
