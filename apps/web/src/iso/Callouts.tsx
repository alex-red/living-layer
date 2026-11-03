import {
  FOOD_LEFT,
  STAT_KINDS,
  dayOf,
  daysUntil,
  foodNow,
  toIso,
  type Food,
  type IsoVec,
  type StatKey,
  type StatNow,
} from '@livinglayer/domain';
import { useNow } from '../useNow';
import { useThingStats } from '../workspace/state/stats';
import { statBadge, statTone } from './StatBadges';

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

/** Card width and line heights, in the scene's own units (a tile is 64 wide). */
const W = 104;
/** How much wider each side of the scene is drawn to hold a column of cards. */
export const CALLOUT_SIDE = W + 14;
const HEAD = 15;
const LINE = 11;
const GAP = 6;
const PAD = 6;

/** How many lines a card takes, so the cards can be stacked before they render. */
function linesOf(c: IsoCallout): number {
  if (c.builtIn) return 2;
  const food = c.food ? 1 + (c.food.left ? 1 : 0) + (c.food.opened ? 1 : 0) : 0;
  return Math.max(1, food + (c.stats?.length ?? 0));
}
const heightOf = (c: IsoCallout) => HEAD + linesOf(c) * LINE + PAD;

interface Placed {
  c: IsoCallout;
  at: { sx: number; sy: number };
  x: number;
  y: number;
  h: number;
  side: 'left' | 'right';
}
/**
 * The cards in two columns at the scene's sides, each by its thing's height
 * on screen and pushed apart so none overlap: things left of the middle get
 * the left column.
 */
function layout(
  callouts: IsoCallout[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): Placed[] {
  const mid = (bounds.minX + bounds.maxX) / 2;
  const placed: Placed[] = [];
  for (const side of ['left', 'right'] as const) {
    const column = callouts
      .map((c) => ({ c, at: toIso(c.anchor) }))
      .filter(({ at }) => (side === 'left' ? at.sx < mid : at.sx >= mid))
      .sort((a, b) => a.at.sy - b.at.sy);
    const x = side === 'left' ? bounds.minX + 4 : bounds.maxX - 4 - W;
    let next = bounds.minY + 4;
    const cards = column.map(({ c, at }) => {
      const h = heightOf(c);
      const y = Math.max(next, at.sy - h / 2 - 30);
      next = y + h + GAP;
      return { c, at, x, y, h, side };
    });
    // A column that runs off the bottom is moved up as one.
    const over = next - GAP - (bounds.maxY - 4);
    if (over > 0) for (const card of cards) card.y -= over;
    placed.push(...cards);
  }
  return placed;
}

/**
 * The stats layer: a card for each thing with something to say (food's use-by
 * day and how much is left, its stats), joined to the thing by a thin elbow
 * line, beside the room rather than over it.
 */
export function Callouts({
  callouts,
  bounds,
}: {
  callouts: IsoCallout[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}) {
  const now = useNow(60_000);
  return (
    <g className="iso-callouts" aria-label="Things’ stats">
      {layout(callouts, bounds).map(({ c, at, x, y, h, side }) => {
        const edge = side === 'left' ? x + W : x;
        const knee = side === 'left' ? edge + 10 : edge - 10;
        const lineY = y + HEAD / 2 + 1;
        const tone = c.builtIn ? 'idle' : (foodNow(c.food, now)?.tone ?? 'ok');
        return (
          <g key={c.id} className={`iso-callout ${tone}`} data-callout={c.id}>
            <polyline
              className="iso-callout-line"
              points={`${edge},${lineY} ${knee},${lineY} ${at.sx},${at.sy}`}
            />
            <circle className="iso-callout-dot" cx={at.sx} cy={at.sy} r={1.8} />
            <foreignObject x={x} y={y} width={W} height={h}>
              <button
                type="button"
                className="callout-card"
                onClick={c.onSelect}
                title={c.builtIn ? `Open the ${c.label.toLowerCase()}` : undefined}
              >
                <span className="callout-name">{c.label}</span>
                {c.builtIn ? (
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

/** Its use-by line, a meter of how much is left, and since when it is open. */
function FoodLines({ food, now }: { food?: Food | undefined; now: number }) {
  const status = foodNow(food, now);
  if (!food) return null;
  const left = food.left ?? 'full';
  // Full is all five steps, empty none.
  const steps = FOOD_LEFT.length - 1 - FOOD_LEFT.indexOf(left);
  const open = food.opened ? -daysUntil(food.opened, dayOf(now)) : null;
  return (
    <>
      <span className={`callout-row big ${status?.tone ?? 'ok'}`}>
        {food.expires ? (status?.text.split(' · ')[0] ?? '') : 'No use-by day'}
      </span>
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

/** Each stat it keeps, as the room's badges word it, in its tone. */
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
        <b>{STAT_KINDS[key].label}</b> {s ? statBadge(key, s, now).toLowerCase() : 'waiting'}
      </span>
    );
  });
}
