/**
 * The numbers a room draft's layout weighs its evidence with (`layoutRoom`,
 * `refineWalls`), in one place, so a bench can sweep them without an edit:
 * `bun run bench:rooms --set layout.pastTop=2,4,8`. Distances are in tiles.
 * Change a default here only after a sweep shows it sits in a stable range.
 */
export const LAYOUT_TUNING = {
  /** A thing whose back is within this of a wall is put flush against it. */
  flush: 0.5,
  /** Within this many pixels of the frame's edge, a mask's column is cut off. */
  edgePx: 3,
  /** The share of near points behind a footprint's near side: the rest are stray pixels. */
  reachQuantile: 0.98,
  /** The share of a top's points in front of its far edge, the same way round. */
  topQuantile: 0.02,
  /** How far a desk's, table's or shelf's estimated size may stray from its template's, as a share. */
  sizeMin: 0.6,
  sizeMax: 1.6,
  /** Shrinking a piece by all of one side costs as much as moving one a tile. */
  shrinkCost: 2,
  moveCost: 2,
  /** Moving towards the camera within a piece's slack, per tile: cheaper than any shrink of note. */
  slackCost: 0.2,
  /** How far a piece whose near side is only a bound may move towards the camera cheaply. */
  openSlack: 2,
  /** Cutting a seen top short, or pushing it past where it was seen, per tile: worse than moving a guess. */
  pastTop: 4,
  /** How far behind a wall a thing may seem to stand before it says the wall is off: a Spark size's slip. */
  wallSlack: 0.2,
  /** Further behind a wall than this, a thing hangs on it (a calendar) rather than standing there. */
  hanging: 4,
  /** Things that have to stand behind one wall before it is turned: one could be a bad outline. */
  witnesses: 3,
};
export type LayoutTuning = typeof LAYOUT_TUNING;

let overrides: Partial<LayoutTuning> = {};
/** The numbers in force: the defaults, with whatever `withLayout` is trying. */
export const layoutTuning = (): LayoutTuning => ({ ...LAYOUT_TUNING, ...overrides });
/** Runs `fn` with some of the layout's numbers changed, as `withFurniture` does for measurements. */
export function withLayout<T>(changes: Partial<LayoutTuning>, fn: () => T): T {
  const before = overrides;
  overrides = { ...before, ...changes };
  try {
    return fn();
  } finally {
    overrides = before;
  }
}
