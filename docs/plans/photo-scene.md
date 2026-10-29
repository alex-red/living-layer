# Plan: a scene from one photo

Status: built, see [architecture.md](../architecture.md#isometric-view). Builds on [isometric.md](isometric.md) and [iso-models.md](iso-models.md), both built. Where the build differs from this plan, [As built](#as-built) says so.

## Goal

Upload one photo of a desk or a room. About half a minute later, you have an isometric scene of it to review. The furniture is placed, the main surface is pinned, and every movable object has a fitted model. Accept it, tick the objects you want tracked, and the loop runs as before: move the mug into the zone and the lamp turns on.

Today the same result takes six separate steps: `Guess scene` or `Draft with Spark`, then clicking the four corners of the surface, then `Discover` and `Segment` once per concept, confirming each mask, and `Model` per object. Each of those works, but Spark's layout positions are guesses. It puts a desk "about here", the same way it used to guess item numbers. This plan applies to scenes the rule that made the item models work: **Spark names things, SAM outlines them, and code measures.**

## Should it use SAM? Yes, as the measuring tool, in one call

SAM 3.1 takes one text concept per request, so segmenting a desk by noun would cost a call per kind of thing, and the daily budget is 20. But a request can instead carry **up to 16 box prompts**, each under its own id ([Meta docs](https://dev.meta.ai/docs/sam/segmenting)). So the draft becomes:

1. **Spark, 1 call:** what is in the photo, and a rough box for each thing.
2. **SAM, 1 call:** an exact mask for every one of those boxes.

That's 2 billed calls for a whole scene, or 3 with the optional check. Today, getting the same masks costs one SAM call per concept. Spark's rough boxes are fine, because SAM snaps each one to the real outline, and everything after that is measured from the masks.

Without SAM, positions and sizes would come from Spark's boxes alone, with the same guessing problem the layout has now. Spark's boxes are loose by tens of pixels, and a loose box on a desk makes a model float or overlap its neighbour.

## Pipeline

All the geometry is pure code in `packages/domain`, like the fitter, so fixture mode, the tests and a benchmark all run the real thing. The server route is `POST /api/scene/from-photo` (run kind `photo-scene`), and every step is recorded in the run's evidence.

### 1. Inventory (Spark)

`photoInventorySchema`, strict JSON:

- `kind`: `desk | office | fridge | room`
- `things[]`, at most 16:
  - `id`
  - `label`: a short grounded noun, the same rule as `discover`
  - `as`: a template id (`TEMPLATE_IDS`) or an item archetype (`mug`, `bottle`, ...)
  - `role`: `furniture | surface | object`
  - `on`: the id of the thing it stands on, or `floor`
  - `box`: rough, in 0–1000 normalised image coordinates
- `summary`: one line

Spark never returns sizes, tile positions or turns. Those come from step 3 onwards.

### 2. Masks (SAM, box prompts)

- Add box prompts to `MetaAdapter.segment`, beside the concept prompt. Ids are the inventory ids, so each mask comes back already labelled.
- A thing SAM finds nothing for is dropped and shown as "not found" in review. It is never invented.
- The masks are stored like any segmentation, so later tracking and `maskedCrop` reuse them without another call.

### 3. Auto-pin the main surface

The biggest `surface` mask (the desktop, or a shelf) becomes the pin:

- Take the mask's convex hull and reduce it to the best four-corner fit: Douglas–Peucker down to 4 points, then a least-squares adjustment of each edge.
- Order the corners clockwise from the back left. That gives `surfaceMap`'s homography and the camera's elevation, the same as a manual pin.
- Review shows the four corners as handles, so a person fixes a bad corner by dragging it in the existing pin UI. This replaces clicking all four corners from scratch.
- If no surface is found, or the quad's fit IoU is under 0.85, the draft falls back to a manual pin.

### 4. Place things

- **On the surface:** an object's position comes from `projectBox` (bottom centre of its mask), unchanged. Its width comes from the mask's bottom edge through the homography.
- **On the floor:** the floor is the pinned surface's plane moved down by the template's known height (a desk top is 2.4 tiles up). The camera elevation from step 3 projects each furniture mask's lowest row onto that floor. This is approximate, and the review says so. Spark's `on` and box order break ties, for example the chair goes in front of the desk.
- **Turns:** take the quarter turn whose rendered outline best matches the mask (step 6). The template's long side follows the mask's long side.
- Then `buildScene`/`settleGroup` stack tabletop things exactly as Spark layouts are stacked today.

### 5. Model the objects

Each `object` mask goes through `fitItem` with `sampled` assists: pure code, no extra call. With 16 things that's a few hundred milliseconds of renders per object, so it runs in a worker on the server and streams progress. `Refine with Spark` stays a per-item button in the editor, billed as now.

### 6. Check the scene against the photo

This is the analysis-by-synthesis step from the item fitter, done for the whole scene:

- Render every prop's silhouette from the estimated camera, extending `renderView` from items to scenes.
- Score IoU per thing against its SAM mask.
- Nudge `x`, `y`, `turns` and size by coordinate descent, with at most about 60 renders in total.
- Store `fit: { iou, perThing, elevation }` on the draft. Review shows a match percentage per row, so a badly placed thing is easy to spot.

### 7. Spark check (optional, 1 call)

Spark sees the photo next to the flat-colour render and returns `{ missing[], extra[] }` against the inventory ids.

- A missing thing gets one box-prompted SAM retry, only if the budget allows. Otherwise it's listed for the person to add.
- Nothing is kept unless the scene score holds.

### 8. Review and save

A new **From photo** entry in the scene editor:

- Left: the photo with mask outlines and the pin quad.
- Right: the draft scene.
- Below: one row per thing, with its label, template, match percentage, and buttons to remove it or change its template.
- Objects have a **Track** checkbox. Ticking one confirms it into `object`/`others`, so identity stays a human decision, as the design requires. The first object ticked becomes the main object (the mug).

**Save** writes the scene, the pin, the confirmed objects and their item models to desk memory in one transaction, through the existing save paths and schemas. Nothing is saved before that.

## Fixture mode

The illustrated `desk.svg` covers the whole loop offline:

- The fixture inventory names its things: desk, monitor, lamp, book, bottle and mug.
- The fixture SAM rasterises each of those shapes from the SVG as its mask. Today the synthetic SAM only knows the mug, so this also lets fixture rules target the book and bottle.
- Fixture mode makes no calls, and the expected scene is a golden test.

## What not to use

- **Muse Image.** Generated pixels can't be tracked, aren't evidence, and don't work offline. This is the same reason as in [isometric.md](isometric.md#approach). A generated "poster" would look good in a video, but it's the one thing judges could call a trick, and it would compete with the real renderer. Leave it out.
- **Muse Wonder** is a coding agent, not something to run at runtime.
- **SAM video** (a short pan around the desk) would give several views, which fixes the floor-depth guess and fills in the back halves of decals. It's worth doing after the event, not before.

## Hackathon fit

Indie track. The judges score creativity, technical ambition and whether it works. Submissions close **Nov 4, 9:00 PM ET**, which leaves 7 days from today (Oct 28).

- **Creativity:** "photograph your desk, get a living pixel-art twin that switches your real lamp" is the demo in one sentence. Every model in it is fitted to your photo, so it's your mug and not a stock one.
- **Technical ambition:**
  - Two Meta models in one pipeline, each in its proper role: Spark plans and checks, and SAM measures with 16 box prompts in a single call.
  - The camera is recovered from one photo through an automatic surface pin.
  - Analysis by synthesis runs at both scene and item level.
  - The pipeline runs in 2 or 3 calls, within a 20-call day.
- **It works:**
  - Fixture mode runs the full pipeline with no key.
  - Golden tests and a scene benchmark cover it.
  - The evidence log shows every model call and what it changed.
  - The review step makes a wrong guess cheap to fix instead of fatal.

For the submission video, upload the photo, show the review with its match percentages, drag one corner, tick the mug, save, then move the real mug and show the lamp turning on. Under 2 minutes. Update the README's "How it works" to lead with this flow.

## Build order

Each step ends with a test, and the cut line sits after step 5: a feature that ends there is complete and demoable.

1. **SAM box prompts:** the adapter, a parser test against a mocked Meta API, and box masks for the fixture's things. _(day 1)_
2. **Inventory:** the schema, the Spark call, the fixture answer, and a route test. _(day 1–2)_
3. **Auto-pin:** quad fit and corner ordering. Unit tests on synthetic quads under perspective, plus the fixture desk. _(day 2)_
4. **Placement and models:** floor projection, `fitItem` per object, `buildScene`, and the fixture scene as a golden test. _(day 3)_
5. **Review and save:** the UI, the single save transaction, and Playwright tests (from photo, track the mug, save, the marker moves, no horizontal scroll on mobile). _(day 4–5)_ **Cut line.**
6. **Scene score and refine:** extend `renderView` to scenes, coordinate descent, and a benchmark in `scripts/scene-bench.ts`. _(day 5–6)_
7. **Spark check,** README, and the demo video. _(day 6–7)_

## Open decisions

- Does **From photo** replace the lab's first steps (Discover, Segment, Confirm), or sit beside them? The proposal is to put it beside them for now, since the existing flow and its tests stay as they are. If it proves itself in the demo, it becomes the default way in.
- What should the room kind do? `room` with furniture only on the floor can't be pinned from a desktop. The proposal is to pin the floor, using a rug if there is one or else the floor region SAM returns for the `floor` thing, and to accept a coarser match.

## As built

- **Names.**
  - The run kind is `photo`.
  - The layout code lives in `packages/domain/src/photo-scene.ts`. It is pure, so the review page runs the same layout again on every change, in the browser.
  - The draft route is in `apps/server/src/photo.ts`. The save route is in `desk.ts`, because it uses the desk's own sighting helpers.
- **Auto-pin.** A desk mask from a real photo includes the legs, and has holes where things stand on it. So the pin takes three steps:
  1. The holes are filled with the masks of the things standing on it (not a chair in front).
  2. An opening sized to about 7% of the surface's width removes the legs (`surfaceTop`).
  3. The biggest quad inside the hull is fitted. The corners are then refined so that the whole template (top, front edge and legs), drawn from the camera they imply, matches the mask (`refinePin`).

  Without the last step, the front corners sat on the bottom of the desk's front edge.

- **Camera.**
  - When the photo's perspective shows it, the focal length is measured from the right angle at the corners. On synthetic photos taken at an angle to the desk, that recovers the camera exactly.
  - A desk seen square on can't show it, so a typical lens (0.8 × the long side) is assumed. The review says "lens guessed".
- **Scene check.** Each prop's silhouette is drawn by projecting its corners through the recovered camera, not by extending `renderView`. That is exact for boxes, needs no voxels, and keeps a check under a millisecond. Every placed template gets at most 40 tries (turns, then ½, ¼ and ⅛ tile steps), rather than 60 tries for the whole scene. The pinned surface itself is never moved.
- **Models.**
  - Objects are fitted on the server inside the draft request, at most 8 per draft. The rest can be drafted later from the Model tab. Nothing is streamed: the fitter takes under a second per object.
  - The fixture fits without a camera angle, since the illustration has none.
- **Tracking.** An extra object remembers its label as its SAM concept, so it is later followed in segmentations of that same word. The fixture's synthetic SAM still only knows the mug, so in fixture mode only the mug can be tracked to a new frame.
- **Saving.** An object that isn't tracked but has a template (book, bottle, plant) stands in the saved scene as a prop (`sceneForSave`). One that has no template is left out.
- **Benchmark.** `bun scripts/scene-bench.ts` draws synthetic photos with known cameras and lays them out:
  - a desk at four angles, one with a wide lens;
  - a table;
  - a room with a shelf, a plant and a chair.

  Every case meets the targets:

  | Measure                | Result                       | Target      |
  | ---------------------- | ---------------------------- | ----------- |
  | Pin corners            | 0.6–1.9% of the diagonal     | 2.5%        |
  | Surface depth          | within 8.3% (square-on 8.4%) | 10%         |
  | Every thing's position | within 0.4 tiles             | half a tile |
  | Scene match            | 83–92%                       | none        |
  | Time per photo         | under 70 ms                  | none        |

  These are synthetic photos with exact masks. The first real photo (Oct 28: a cluttered desk from a network camera at 1280 × 720, behind and above the desk) went through the live path in 12.6 s for about $0.016, without the check. Spark listed 11 things and SAM outlined all of them. The desk was pinned at a 64% match with its front edge out of frame, and the whole scene scored 32%. Clutter the templates can't draw (plushes, a cat tower) is what pulls the score down. Finding the desk again on its own (`desk/auto-pin`, one SAM call) put the corners on the visible top, clear of the plushes.

- **Not built.**
  - Pinning the floor for a room with no desk. It still falls back to spreading things over the grid by where they are in the photo.
  - A streamed progress bar.
- **Tests.**
  - `tests/photo.test.ts` covers the mask paths, the quad fit, the camera (measured and guessed lens), layouts at three angles, removals and missing masks, the fixture route through save and tracking, the mocked live route (one Spark call and one SAM call carrying every box), the check request, and the budget refusal.
  - `tests/browser/lab.spec.ts` has the review flow: draft, tick the bottle, drag a corner, check mobile width, save.
