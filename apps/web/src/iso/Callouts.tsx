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
import { useNow } from '../useNow';
import { useThingStats } from '../workspace/state/stats';
import { statTone } from './StatBadges';

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
  onSelect?: () => void;
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
  if (density === 'compact') return c.builtIn ? 1 : c.food?.expires ? 2 : 1;
  if (c.builtIn) return 2;
  const food = c.food
    ? 1 + (c.food.expires ? 1 : 0) + (c.food.left ? 1 : 0) + (c.food.opened ? 1 : 0)
    : 0;
  return Math.max(1, food + (c.stats?.length ?? 0));
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
  h: number;
  side: 'left' | 'right';
}
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
/**
 * The cards in two columns at the scene's sides. Things are split left to
 * right where the two columns come out nearest the same height, so lines
 * don't cross; each card sits by its thing's height on screen, pushed down
 * so none overlap. `extent` is how far the columns reach, for the view to
 * grow to.
 */
export function layoutCallouts(
  callouts: IsoCallout[],
  bounds: Bounds,
  density: CalloutDensity = 'full',
): { placed: Placed[]; extent: { minY: number; maxY: number } } {
  const all = callouts
    .map((c) => ({ c, at: toIso(c.anchor), h: heightOf(c, density) }))
    .sort((a, b) => a.at.sx - b.at.sx);
  const total = all.reduce((sum, a) => sum + a.h + GAP, 0);
  let split = 0;
  let best = Infinity;
  for (let k = 0, left = 0; k <= all.length; left += k < all.length ? all[k]!.h + GAP : 0, k++) {
    const off = Math.abs(left - (total - left));
    if (off < best) [best, split] = [off, k];
  }
  const placed: Placed[] = [];
  let minY = bounds.minY;
  let maxY = bounds.maxY;
  for (const side of ['left', 'right'] as const) {
    const column = (side === 'left' ? all.slice(0, split) : all.slice(split)).sort(
      (a, b) => a.at.sy - b.at.sy,
    );
    const x = side === 'left' ? bounds.minX + 4 : bounds.maxX - 4 - W;
    const height = column.reduce((sum, a) => sum + a.h + GAP, -GAP);
    // A column taller than the room starts above it; the view grows to hold it.
    let next = Math.min(bounds.minY + 4, (bounds.minY + bounds.maxY) / 2 - height / 2);
    for (const { c, at, h } of column) {
      const y = Math.max(next, at.sy - h / 2 - 30);
      next = y + h + GAP;
      placed.push({ c, at, x, y, h, side });
    }
    if (column.length) {
      minY = Math.min(minY, placed.find((p) => p.side === side)!.y - 4);
      maxY = Math.max(maxY, next - GAP + 4);
    }
  }
  return { placed, extent: { minY, maxY } };
}

/**
 * The stats layer: a card for each thing with something to say (food's use-by
 * day and how much is left, its stats), joined to the thing by a thin elbow
 * line, beside the room rather than over it.
 */
export function Callouts({
  placed,
  density = 'full',
}: {
  placed: Placed[];
  density?: CalloutDensity;
}) {
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
      {placed.map(({ c, at, x, y, h, side }) => {
        const edge = side === 'left' ? x + W : x;
        const knee = side === 'left' ? edge + 10 : edge - 10;
        const lineY = y + head / 2 + 1;
        const tone = c.builtIn ? 'idle' : (foodNow(c.food, now)?.tone ?? 'ok');
        return (
          <g key={c.id} className={`iso-callout ${tone}`} data-callout={c.id}>
            <polyline
              className="iso-callout-line"
              points={`${edge},${lineY} ${knee},${lineY} ${at.sx},${at.sy}`}
            />
            <circle className="iso-callout-dot" cx={at.sx} cy={at.sy} r={1.8} />
            <HealthPip food={c.food} at={at} now={now} />
            <foreignObject x={x} y={y} width={W} height={h}>
              <button
                type="button"
                className="callout-card"
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
                    ) : !c.food ? (
                      <span className="callout-row muted">Nothing kept yet</span>
                    ) : null}
                  </>
                )}
              </button>
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
    ) : (
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
