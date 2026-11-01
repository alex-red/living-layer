# SAM step experiments · log, October 31, 2026

Can the room setup's SAM step be made better, and does a better mask place things better? Tried on the live room's stored drafts, offline where possible. Every billed call is cached, so a rerun costs nothing.

**Short answer:** not on these frames. Placement doesn't hinge on the masks. All seven ways of making them moved the marked things by a few pixels at most. The large errors come from the layout and the calibration. Spent $0.04 in all.

## How it was judged

- **Spark's listing is held fixed.** Every arm sends SAM the stored draft's own boxes, so only the picture or the prompt changes.
- **SAM is deterministic.** The same frame with the same boxes gives the same masks (a control arm matched to IoU 1.00). Any difference is the change's.
- **Truth is marked by hand.** On one frame (e8f15e31), nine points mark where things touch down: the desk top's far corner, the laptop, mug, keyboard, mouse, pen cup, bottle, fan and chair. The frame is captured as the room `office-d`, with the points in its `truth.json` (local only: the frame is a home). `bun run bench:rooms` now scores it against them. `scripts/experiments/evaluate.ts` lays every cached arm out as the setup does and reports each point's distance in pixels.
- **Check what a truth point is the point of.** The first bottle point was a different pink thing than the one Spark's `bottle-1` names, and read as a 41 px error. Draw the marked and projected points over the frame before trusting a number.

## Results (frame e8f15e31, error in pixels)

| arm                                  | median | desk corner | laptop | small things on the desk | fan | chair |
| ------------------------------------ | -----: | ----------: | -----: | -----------------------: | --: | ----: |
| first pass (Spark's boxes)           |     10 |          56 |     20 |                     3–10 |  59 |    54 |
| frame cleaned by Muse Image: tidy    |      9 |          56 |     43 |                      2–9 |  60 |    50 |
| frame cleaned by Muse Image: light   |      9 |          56 |     19 |                      3–9 |  55 |    51 |
| second pass, points from the drawing |      8 |          55 |     17 |                      2–8 |  57 |    56 |
| … negative points only               |      9 |          55 |     29 |                      3–9 |  57 |    54 |
| … positive points only               |     10 |          54 |     15 |                     3–10 |  59 |    55 |
| … better mask per thing (rule below) |      8 |          54 |     18 |                      2–8 |  59 |    54 |

## What was learned

1. **Masks aren't what limits placement here.** Small things on the desk land within 2–10 px of where they stand in every arm. The desk, fan and chair are 50–60 px off in every arm, the fan even where its mask went from wrong to right. Work on placement should go to the layout and calibration, not to SAM.
2. **Muse Image keeps the framing.** A 1792 × 1344 edit scaled back to the frame sits within 1–2 px everywhere (edge correlation per tile, `clean-frame.ts`), so a cleaned frame can be used through the calibrated camera. On a well-lit frame it changes little; dark or night frames are untested.
3. **A second pass with points from the draft fixes masks the first got badly wrong, and harms good ones.** The fan's mask was the wall seen through its loop. With points it covers the fan, ring and base. But positive points also collapsed some masks (a chair to 7% of its box; small things to 2–3%), and the desk split into twice the pieces.
4. **The drawing has to be slid onto the photo first.** The first layout's drawings were up to 40 px off and put points on the wrong things (a shelf's on the cat tree, the monitor's negative on its screen). Sliding each drawing to best overlap the first mask (±40 px) fixed that. Many slid the whole 40 px, which says how far off the first layout is for big things.
5. **Keep the better mask per thing:** a second-pass mask replaces the first only when it agrees better with the slid drawing and keeps at least 70% of the first's area. That keeps the fan's fix and rejects the collapses. The judge isn't independent (the drawing comes from the first layout), and it changed placement by a pixel or two.
6. **The near edge's quantile is right at 0.98.** Lower values made the desk far worse (56 → 186 px at 0.9). Its near points are real (the drawers' foot), not stray pixels.

## Open questions

- **The desk's room-side edge is 7° off its wall** through the room's camera, at every turn of the left wall's marks. Either the desk isn't square to the wall, or the camera is off in a way the wall turn doesn't touch (roll, the lens). It is the desk's 55 px error, and likely the chair's and fan's. A second marked frame, or measuring the desk, would tell.
- **The fan's base reads as behind the back wall** (y −0.09 tiles) through the camera. That wall's marks may be off near the frame's right edge, as the left's were.

## For the implementation

- Use the second pass only where the first mask is clearly wrong. A big thing whose mask is mostly not where its drawing is (a fan through its loop) is the case it fixes. Not as a default step.
- Don't clean frames with Muse Image for SAM: $0.01 and up to two minutes per frame for no gain in daylight.
- Mark truth on a second frame before tuning placement. One frame is too few to tell a camera error from a desk set at an angle.

## Tools

The marked points and their scoring are `scripts/lib/truth.ts`, used by the rooms bench too.

All in `scripts/experiments/`. Each billed call is cached under `.data/experiments/` (ignored), and each script has its own spending cap (`--max-usd`).

| script              | what it does                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `clean-frame.ts`    | cleans a draft's frame with Muse Image, then SAM with the same boxes; alignment and mask measures |
| `render-prompts.ts` | the second pass: points from the draft's drawing (`--dry` to see them, `--variant neg\|pos`)      |
| `render-points.ts`  | how the points are chosen: the drawing slid onto the first mask, feet and middle, what touches it |
| `evaluate.ts`       | every cached arm laid out and scored against the hand-marked points                               |
| `lib.ts`            | the capped Meta adapter and mask measures (IoU, pieces, area)                                     |
