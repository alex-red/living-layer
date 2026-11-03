/**
 * Which candidate goes to which followed thing, decided for all of them at
 * once ([plan](../../../docs/plans/multi-tracking.md#phase-2-motion-and-joint-assignment)):
 * the Hungarian algorithm over a cost per pair, so two things never take the
 * same candidate and the one that fits best overall wins, not the one asked
 * about first. A thing may also go without (`unassigned`), so it doesn't take
 * a far candidate just because one is left. Each thing's margin is what the
 * best other assignment would cost it: under `MULTI.minMargin` the two
 * readings are about as likely, and neither should be trusted.
 */
export const MULTI = {
  /** Least identity margin (in cost) for an assignment to count as sure. */
  minMargin: 0.15,
  /** What a thing pays to take no candidate: farther than this, it goes without. */
  unassigned: 1.5,
};

/** Stands in for a pair ruled out, so the matrix stays finite. */
const BIG = 1e9;

/** Minimum-cost perfect matching of a square matrix; `row → column`. */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++)
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else minv[j]! -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const rowOf = new Array<number>(n);
  for (let j = 1; j <= n; j++) rowOf[p[j]! - 1] = j - 1;
  return rowOf;
}

function solve(cost: number[][], unassigned: number) {
  const n = cost.length;
  const m = n ? cost[0]!.length : 0;
  const size = n + m;
  // Things × (candidates + one "none" per thing); leftover candidates pair with filler rows.
  const square = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => {
      if (i < n) {
        if (j < m) return Number.isFinite(cost[i]![j]!) ? cost[i]![j]! : BIG;
        return unassigned;
      }
      return 0;
    }),
  );
  const rowOf = hungarian(square);
  const pick = rowOf.slice(0, n).map((j, i) => (j < m && square[i]![j]! < BIG ? j : null));
  let total = 0;
  pick.forEach((j, i) => (total += j === null ? unassigned : cost[i]![j]!));
  return { pick, total };
}

interface Assignment {
  /** Each thing's candidate index, or null when it goes without. */
  pick: (number | null)[];
  /**
   * For each thing, how much more the best assignment that doesn't give it
   * this pick would cost (at most what going without would). Null for a
   * thing that took nothing.
   */
  margins: (number | null)[];
}

/**
 * Assign candidates to things. `cost[i][j]` is what thing `i` taking
 * candidate `j` costs; Infinity rules the pair out (a mug never takes a
 * book's outline).
 */
export function assignTracks(cost: number[][], unassigned = MULTI.unassigned): Assignment {
  const { pick, total } = solve(cost, unassigned);
  const margins = pick.map((j, i) => {
    if (j === null) return null;
    const without = cost.map((row, r) =>
      r === i ? row.map((c, k) => (k === j ? Infinity : c)) : row,
    );
    return solve(without, unassigned).total - total;
  });
  return { pick, margins };
}
