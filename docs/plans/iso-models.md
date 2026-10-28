# Plan: photo-accurate isometric models

Status: built, see [architecture.md](../architecture.md#isometric-view). Builds on [isometric.md](isometric.md) (Phases 1 to 5 built). Where the build differs from this plan, [As built](#as-built) says so.

## Where we are

- Items are up to 12 parametric parts (`cylinder | box | cone | handle | lid`) in `packages/domain/src/iso-item.ts`, drawn by `IsoItem.tsx` as flat SVG: one fill for the top, one shaded fill for the side, a polyline for the handle.
- A draft comes from either `sampledItem` (3-bit RGB buckets plus the mask's height-to-width ratio, then the hard-coded mug) or Spark, which guesses part numbers from the crop.
- Props in scenes use the same `Solid` faces.

What holds it back:

1. **Shapes are too coarse.** A straight cylinder can't show a mug's taper, rim lip, foot ring or curved belly. Most household objects are a profile turned on a lathe, and we have no lathe.
2. **Numbers are guessed, not measured.** Spark is asked for geometry, which language models are bad at, and nothing checks the result against the photo.
3. **Flat shading.** One fill per face, no light direction, no outline, no contact shadow, no highlight. It reads as a diagram, not as a 2.5D object.
4. **No surface detail.** Bands, stripes, logos and prints are what make a mug look like _your_ mug, and parts have one colour.

## Approach

Three layers, each code-first and testable on its own:

1. **Spec** (domain, zod): richer parametric parts. Still small, editable, schema-checked, stored in desk memory.
2. **Fit** (server): measure the spec from the SAM mask and crop, then render it from the camera's view and refine it until it matches. Spark only names the archetype and the materials.
3. **Render** (web): the spec is turned into signed distance functions, voxelized, and lit into a crisp pixel-art sprite. The SVG scene keeps the overlays (zones, trail, labels) and places sprites in depth order.

The spec stays the source of truth. Voxels are only how it is drawn, so the editor's sliders keep working and a model never has to be stored as a voxel grid.

## 1. Spec: a richer part grammar

New part shapes in `iso-item.ts` (the old ones become shorthands for the new ones, so stored items still load):

- `lathe`: a profile of up to 16 `(r, z)` points revolved around an axis, with an optional wall thickness and an open or closed top. Covers mugs, cups, bottles, bowls, vases, lamp shades, plant pots and cans.
- `rbox`: a box with a corner radius and a bevel. Covers books, phones, laptops, boxes and remotes.
- `tube`: a circle swept along a 2 to 4 point Bézier. Covers handles, cables and lamp arms. Replaces `handle`.
- `extrude`: a footprint polygon of up to 12 points pushed up, with a bevel. For anything flat and odd-shaped.

Every part also gets:

- `material`: `matte | gloss | metal | glass | fabric | wood`. This sets the light ramp, the highlight and the transparency.
- `paint`: an optional list of surface layers, in the part's own UV coordinates (around × up for `lathe`, per face for `rbox`):
  - `band` (z0, z1, colour), `stripes` (count, angle, colours), `dots`
  - `decal`: a small palette-indexed image, at most 64 × 32, cut from the photo (see Fit, step 4)
- `inside`: a colour for the inner wall and the liquid level, for open lathes.

Limits stay tight (parts ≤ 12, profile points ≤ 16, decal ≤ 64 × 32 indexed in ≤ 16 colours) so a model stays a few KB and Spark can still fill it in with strict JSON.

## 2. Archetypes

A small library of recipes in `packages/domain/src/iso-archetypes.ts`. Each one is a function from a few measured numbers to a spec:

| Archetype | Measured inputs                                     | Parts                         |
| --------- | --------------------------------------------------- | ----------------------------- |
| mug       | profile, handle span and height, rim colour, inside | lathe (open), tube, paint     |
| cup/glass | profile, material                                   | lathe (open, glass)           |
| bottle    | profile, cap height, label band                     | lathe, lathe (cap), decal     |
| can       | height, radius, decal                               | lathe, decal                  |
| book      | w × d × h, spine colour, cover decal                | rbox, paint                   |
| box-ish   | w × d × h, radius, top and front colours            | rbox                          |
| plant     | pot profile, foliage blob size and colour           | lathe, voxel blob (noise SDF) |
| generic   | silhouette                                          | `extrude` or a carved hull    |

Spark's job is to choose one (plus materials and a one-line description). The numbers come from the photo.

## 3. Render: SDF → voxels → lit sprite

All of this lives in pure TypeScript (`packages/domain/src/iso-voxel.ts`), so it runs in tests and on the server as well as in the browser.

1. **SDF per part.** A lathe is a 2D distance to the profile polyline, revolved; an `rbox` is the standard rounded-box SDF; a tube is a distance to a Bézier. The item is their union. Paint is looked up by mapping a surface point back to the part's UV.
2. **Voxelize.** Sample the SDF on a grid, 32³ in the scene and 64³ for the editor preview. Store occupancy, a part id, a colour index and an outward normal (from the SDF gradient). A mug is about 5k surface voxels, which takes a few ms.
3. **Light** (the look is decided here, and it is fixed for every item and prop so scenes read as one style):
   - one key light from the upper left, plus ambient
   - a 3 or 4 step ramp per colour, with hue-shifted shadows (cooler and more saturated) instead of plain darkening
   - ambient occlusion from neighbouring voxels, so the inside of a mug and the gap under a handle go dark
   - a specular highlight for `gloss` and `metal`, alpha for `glass`
   - a 1px selective outline: darker than the shaded colour, only on the silhouette and at depth jumps
   - a soft contact shadow ellipse on the surface underneath
   - items keep their true colours; props are quantized to the scene palette (Quiet Neon)
4. **Draw** as an isometric sprite to an `OffscreenCanvas`, at integer pixel scale, once per item and quarter turn, then cache it by spec hash. The SVG scene places it with `<image>` in the existing `depthOrder`. Items don't overlap each other, so sorting per sprite is enough.
5. **Props too.** Move the prop templates in `iso-templates.ts` onto the same kernel (wood-grain stripes on the desk top, a bevelled monitor, a lathe lamp), so a photo-accurate mug doesn't sit in a flat-shaded room.

WebGPU (already used by `PixelFeed`) is an optional fast path for bigger grids later. Canvas 2D is enough at 32³ to 64³, and it works everywhere and in Playwright.

## 4. Fit: from photo to spec

Pure code in `packages/domain/src/item-fit.ts` (so fixture mode, tests and the benchmark run the real fitter), called by `apps/server/src/item.ts` with the SAM mask and the crop we already have:

1. **Camera view.** The surface pin's homography gives the camera's tilt over the desk. Turn it into a view elevation, so the fitter knows how squashed the rim ellipse should be and can correct the profile for the angle.
2. **Silhouette.**
   - Walk each row of the mask to get left and right edges.
   - For lathe archetypes, find the symmetry axis (the median of the row midpoints over the rows without a handle). The half-width per row is the profile, simplified to ≤ 16 points with Douglas–Peucker.
   - Whatever sits well outside the symmetric profile on one side is the handle: take its top, bottom and reach for the tube.
   - The rim ellipse at the top gives the depth radius, which cross-checks the elevation.
3. **Colour regions.**
   - k-means in OKLab instead of 3-bit buckets, with 2 to 6 clusters chosen by an elbow rule.
   - Label the clusters by where they sit: body, inside (inside the rim ellipse), handle, base.
   - Run-length the body's dominant cluster per row to find horizontal bands and stripes.
4. **Decal.** For a lathe, unwrap the visible half: each crop column maps to an angle through `asin((x - axis) / r(z))`. Resample to a 64 × 32 strip, quantize to the cluster palette, and mirror or fill the unseen back half with the body colour. Do the same per face for `rbox` (cover, spine).
5. **Check and refine (analysis by synthesis).**
   - Render the spec's silhouette and colour from the estimated camera view, using the same SDF kernel (a small orthographic raymarch, about 128 px).
   - Score it: silhouette IoU against the mask, and mean ΔE (OKLab) inside the mask.
   - Refine a handful of numbers (profile radii, handle span, band edges, elevation) by coordinate descent for at most about 50 renders. That's local, deterministic and under a second.
   - Store the score with the item (`fit: { iou, deltaE, views }`) and show it in the editor as a match percentage.
6. **More sightings, better model.** Every confirmed segmentation of the same object is another view. Over time, fill the decal's unseen half from other angles and average the profile. This also gives the appearance signature the earlier plan mentioned.

Spark gets the crop and returns `{ archetype, materials, description, backside? }` under strict JSON. It never returns numbers. Fixture mode covers all of this offline, because the fitter is pure code: the fixture mug runs through the real fitter instead of a hand-written model.

## 5. Editor and scene changes

- `ItemEditor` gains a profile editor (drag the lathe points on a 2D side view), paint layers, a material picker, and a **Photo vs model** toggle that overlays the rendered silhouette on the crop, with the fit score.
- A **Refit** button runs step 5 again after manual edits, keeping the parts that were locked by hand.
- The scene draws item sprites at the tracked position and keeps the marker label and the `unsure` styling as SVG on top.

## 6. Tests and evaluation

- Unit tests:
  - SDF primitives (known distances)
  - the voxelizer (a mug at 32³ has a hollow inside and a hole through the handle)
  - the profile fit (a synthetic mask from a known lathe recovers its profile within 3%)
  - unwrap: a striped synthetic cylinder gives straight stripes
- A **fit benchmark** in `fixtures/items/`: 10 to 20 real crops (mugs, a bottle, a book, a can) with masks and hand-checked specs. `bun scripts/fit-bench.ts` prints IoU and ΔE per item. Track it so changes don't regress accuracy. Targets: IoU ≥ 0.9 and ΔE ≤ 8 for lathe items.
- Golden sprite snapshots: render each archetype and template to PNG and compare with a pixel tolerance. These double as an art-direction review sheet.
- Playwright: the editor toggle shows the overlay, and the scene still has the item marker and no horizontal scroll on mobile.

## Build order

1. **Kernel:** SDFs, the voxelizer, lighting and sprite rendering, with snapshot tests. Render the existing mug through it to compare against today's look. First demo point.
2. **Lathe, rbox and tube parts,** plus migrating the old shapes. The mug archetype by hand.
3. **Silhouette fit and OKLab regions** for lathe archetypes, the fixture mug through the real fitter, and the fit benchmark.
4. **Analysis-by-synthesis refine,** the fit score, and the Photo vs model toggle in the editor.
5. **Decal unwrap and paint layers.**
6. **Props on the kernel,** so the whole scene has one look.
7. **Spark as archetype classifier,** then other archetypes (bottle, can, book, plant), then multi-sighting fusion.

## Meta's models

Meta's models help the fit, but none of them owns it. Each answer is checked against the photo before it is kept:

- **SAM 3.1** segments parts inside the masked crop, with concepts per archetype: `mug handle` and `coffee` for a mug, `drink` for a cup, `soil` for a plant. A handle mask replaces the fitter's guess at which rows hold the handle. An inside mask replaces the rim ellipse when the fitter looks for the liquid.
- **Muse Spark** names the archetype and material and describes the object, under strict JSON (`itemClassSchema`). After the fit, it sees the photo next to the model drawn from the same camera in flat colours, and suggests height, width and handle multipliers and a body colour (`itemCheckSchema`). The fitter clamps them to ±20% (±30% for the handle) and keeps them only if the silhouette still matches the mask within 0.01 IoU.
- **SAM 3D Objects** would turn a crop into a 3D mesh. It needs Linux and an NVIDIA GPU with 32 GB of memory, so it isn't part of the live path. If an offline run is ever wanted for a hero object, its mesh can be voxelized into the same kernel. Turning the mesh into parts would keep the editor and fitter working.

A Spark draft is up to four billed calls: Spark twice, and SAM up to twice. Every call counts against the daily spending limit. Each step is recorded in the fit's `assists`, and the editor shows them. Fixture mode stands in an offline Spark class and makes no calls.

## Decisions

- **Look: crisp pixel art.** Voxel sprites with palette ramps and a selective outline. They are forgiving, look cohesive, and hide small fit errors. A smoother painted look stays possible later, through a higher grid resolution without quantization.
- **Grid size:** 32³ in the scene and 64³ for the editor close-up.
- **Colours:** items keep their true colours, so they match the photo, and props are quantized to the Quiet Neon palette.

## As built

- The fitter lives in the domain package, not the server (see Fit, above).
- Items may stand up to 6 units tall, not 3. Models are one unit wide, so a bottle is about 3.7 units high.
- The fitter takes the axis from the narrowest rows, because a mug's handle can cover more than half of them.
- The profile is corrected for the outline a lathe makes from above, since every height's slice is an ellipse and a shoulder widens the rows above it.
- Plants are fitted pot first: the pot is found by colour, and the foliage height is measured above it.
- Multi-sighting fusion averages the shape and handle, weighted by views, and takes colours and print from the newest view that has them. It does not yet fill the decal's unseen half from other angles. That needs the object's turn between sightings, which nothing measures yet.
- The fit benchmark (`bun scripts/fit-bench.ts`) has synthetic crops for every archetype, the illustrated fixture mug, and four real mug crops in `fixtures/items/`. Every turned body meets IoU ≥ 0.9 and ΔE ≤ 8. On synthetic crops, side lighting alone accounts for about 6 ΔE, even against the true model. Boxes are reported but not held to the target, since a box seen face-on can't tell its depth from its height.
- Reference sprites for every archetype are in `tests/golden/`. To accept a new look, run `UPDATE_GOLDEN=1 bun test tests/model.test.ts`.
- Real photos: the 14 live mug detections in local evidence, from one Tim Hortons mug, fit at IoU 0.71–0.95 and ΔE 7.6–13.5. So real photos miss the targets. The mug isn't rotationally symmetric (its outline slants at the bottom), several SAM masks are cut off at the bottom, and the crops are about 100 px wide. A turned body can only approximate that shape. The fitter was hardened against these photos:
  - it takes the axis from rows that show the hole between handle and body;
  - it measures the side away from the handle;
  - it smooths the profile, so a ragged mask edge doesn't become ridges;
  - a band must wrap most of its rows, so a line of print isn't read as a band;
  - print is found by its contrast with the body's own shading in each column, so a grey logo on a white mug survives;
  - it looks for a coloured inside across the whole opening;
  - the refine stays within 15° of the measured camera angle, and a rim reading steeper than 60° falls back to 30°.
  - A slanted-base cut was tried and dropped: it raised the overlap a little but left models floating off the ground.

  Four of these crops are now in `fixtures/items/`, with the owner's consent. The benchmark reports them against the same targets, marked "known gap", without failing the run: a model of turned bodies can't match a mug that isn't one. The targets still hold for turned bodies (the synthetic cases and the fixture).

- Live Spark and SAM calls are covered by a route test against a mocked Meta API (`tests/item.test.ts`), not by billed calls.
