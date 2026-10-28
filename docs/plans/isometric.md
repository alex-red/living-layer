# Plan: isometric scenes and items

Status: Phase 1 built (see the isometric view in [architecture.md](../architecture.md#isometric-view)). Phase 2 built too. The model is stored in desk memory (`item`) instead of a separate table, and a local `sampled` draft sits next to the Spark one. Phases 3 to 5 (free-form scenes, more objects, zones and lights, and Spark layouts) are built as described in the architecture doc.

## Approach

An isometric scene is a **typed scene spec** that the browser **draws as SVG**. It is not a generated image.

- **Why not generated images:** an image model can't give positions we can track, doesn't work offline in fixture mode, and breaks the "never grade the evidence" rule in [design.md](../design.md).
- **How it connects to tracking:** every scene has one or more _surfaces_ (the desktop, a fridge shelf). A surface links the camera to the iso view. A person clicks its four corners on a real photo, which gives a homography that maps SAM boxes and zones onto the iso floor.
- **Bonus:** those four corners are also the first step toward the camera calibration listed under "Not built yet" in [architecture.md](../architecture.md).

## Phase 1: Office, Desk and Fridge scenes

### 1. Domain (`packages/domain/src/iso.ts`)

- An `isoSceneSchema` (zod) holding:
  - `kind: 'office' | 'desk' | 'fridge'`
  - `grid`: width × depth in tiles
  - `props[]`: id, type, tile position, size, height, rotation, palette
  - `surfaces[]`: id, the prop it belongs to, a rectangle in tile space, a height
  - `anchors`: zone and object slots
- Pure maths:
  - `toIso(x, y, z)` and `fromIso`
  - depth sort by `x + y + z`, then by height
  - `homography(cornersPx → surfaceRect)`, plus `projectBox`, which places a SAM box's bottom-centre on a surface
- Unit tests in `tests/iso.test.ts`, in the style of `tracker.test.ts`.

### 2. Presets (`packages/domain/src/iso-presets.ts`)

- Three hand-written scenes built from a small prop kit: desk, chair, monitor, lamp, shelf, and a fridge body with an open door, shelves and a crisper.
- The desk preset copies `desk.svg` (book, bottle, mug), so the fixture lines up without a calibration step.
- The fridge preset has several shelf surfaces, which is where multiple zones start to matter.

### 3. Renderer (`apps/web/src/iso/`)

- `IsoScene.tsx` draws each prop as three extruded faces (top, left, right) in SVG, using Quiet Neon surface tones. Prism and cylinder primitives are enough for now.
- `IsoOverlay` draws, in the house colours:
  - the remembered object as a marker or sprite in `--chosen`
  - the zone as a tinted rectangle on its surface
  - the observation `history` trail
  - `--warm` only when the lamp fires
- Use SVG rather than WebGPU: it can be tested and it's accessible. `PixelFeed` can still pixelate the result later as a style option.

### 4. Calibration UI

- A "Pin surface" step in the lab stage: click the four corners of the desk or shelf on the current frame.
- Store the corners in `DeskMemory` as a new field: `surface?: { sceneKind, surfaceId, cornersPx, frame }`.
- In fixture mode the corners are preset.

### 5. Optional Spark assist

- `POST /api/scene/classify` asks Spark (structured output, like `discover`) which preset fits the photo and which props it can see. The answer picks the preset and switches props on or off. It never invents geometry.
- The fixture returns `desk`.
- Each call is counted against the request budget and recorded as evidence under a new `RunKind`, `'scene'`.

### 6. Where it appears in the app

- A **Scene / Iso** toggle in the lab stage pane, so the iso view is a second view of the same memory.
- A preset picker.
- Zones can also be drawn on the iso surface. The inverse homography turns them back into a normal `ZoneRect`, so `placementGate` doesn't change.

### 7. Tests

- Unit: projection and depth sort, a homography round trip, and the fixture mug landing on the expected desk tile.
- Playwright: switch to Iso, move the fixture mug, check that the marker moves, and check there's no horizontal scroll on mobile.

**Out of scope for Phase 1:** free-form scene building, moving props, and any scene type beyond the three.

## Phase 2: detailed item models (the mug)

### 1. Item spec (`packages/domain/src/iso-item.ts`)

- An `isoItemSchema` made of parametric parts: `cylinder | box | torusHandle | cone | lid`. Each part has dimensions, an offset, a colour and an optional decal.
- Parts are easier to edit and validate than voxels, and stay sharp at any size. Voxels could come later as another part type for hand-sculpting.

### 2. First draft from the photo

- `POST /api/item/draft` takes the SAM crop of the confirmed object: the mask, the box and the source image.
  - On the server, sharp samples the main colours inside the mask, and the mask gives the width-to-height ratio.
  - Spark gets the crop and returns a part list that matches the schema (strict JSON), for example "cylinder body, handle on the right, rim colour".
- The fixture returns a hand-written cream mug.
- Each item is stored per object in a new `items` table in `store.ts`, linked to `DeskMemory.object.id`.

### 3. Item editor (`apps/web/src/iso/ItemEditor.tsx`)

- The part list on one side and a live iso preview on the other.
- Edits: change dimensions with sliders, add or remove parts, recolour from the sampled colours or the neon palette, and rotate the preview in 90° steps.
- An optional pixel look through the existing `PixelFeed` palettes.

### 4. Back into the scene

- `IsoOverlay` draws the item model in place of the generic marker, at the tracked position and scaled to the surface.
- This also prepares for recognising the same mug by appearance later: the sampled colours and proportions make a cheap appearance signature.

## Phases 3 to 5 (built)

The three items that were listed as later, in this order:

- Free-form scenes: the same spec, with a prop palette and drag-to-place on the grid.
- Several objects, zones and lights per scene. The fridge shelves will need this first.
- Spark-drafted scenes that go beyond choosing a preset.

## Build order

1. Iso maths and tests.
2. The desk preset and renderer, then the overlay showing live tracking. This is the first demoable point.
3. Surface pinning.
4. The Office and Fridge presets, then the Spark classify call.
5. Phase 2: item spec, then draft endpoint, then editor, then using the item in the scene.

## Open decision

This plan assumes hand-made presets plus parametric parts, with Spark only choosing and drafting, never generating images. If we want AI-generated isometric art instead, the Phase 1 renderer and tracking overlay change a lot.
