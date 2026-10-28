# Architecture

```
browser (apps/web)  ──/api──▶  Fastify (apps/server)  ──▶  Meta Responses API (Spark, SAM)
                                   │                   └─▶  Home Assistant REST API
                                   └─▶  SQLite + files in .data/
```

The browser never talks to Meta or Home Assistant directly. Keys and tokens live in the server's `.env`.

## Modes

Every request carries a `mode`, either `fixture` or `live`.

- **fixture** uses the illustrated desk in `apps/web/public/desk.svg`, hand-written discovery results, a synthetic SAM stream, and a virtual lamp. It never makes network calls. The mug can sit at one of three `FIXTURE_POSITIONS`: the web redraws the desk with the mug offset, the synthetic mask moves by the same amount, and each position counts as its own source image.
- **live** validates and re-encodes an uploaded image with `sharp`, then calls the real services. Each outbound Meta attempt is counted against a per-day limit in SQLite _before_ the request is sent, so failures count too.

Fixture and live have separate desk memory. Fixture runs never count toward the live checklist in the UI.

## Server

| File        | Responsibility                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`    | Routes for the individual probes (`text`, `discover`, `segment`, `lamp`), loopback host/origin checks, and recording each run as an evidence record |
| `desk.ts`   | The placement workflow: select a mug, track it, save a zone, mark the camera fixed, verify, reset                                                   |
| `meta.ts`   | Spark (structured JSON output) and SAM (streamed) through the OpenAI-compatible SDK, with retries disabled                                          |
| `sam.ts`    | Runs the SAM stream through `@meta-sam/parser` and rejects anything incomplete, mismatched, or oversized                                            |
| `lamp.ts`   | Turns one light on, then polls its state to see whether it matches                                                                                  |
| `store.ts`  | SQLite tables for evidence, desk memory, placement claims, and the request budget                                                                   |
| `errors.ts` | `LabError`, and mapping upstream failures to generic messages so provider errors never leak keys or inputs                                          |

## Placement rule

`placementGate` in `packages/domain` makes the decision. A placement is **inside** only when:

- an observation exists for the remembered object and is less than five minutes old,
- a zone was saved on the same source image (zones are tied to a SHA-256 of the prepared image, not to physical coordinates), or the camera is marked fixed and the zone was drawn on a frame of the same size, and
- the whole detection box fits within the zone.

**Fixed camera.** Off by default. When a person marks the camera as fixed, `zoneApplies` lets a zone carry over to any new frame of the same size, and every decision made that way records `assumedFixedCamera: true`. Nothing checks that the camera really stayed put.

**Lamp on entering.** Desk memory keeps the last inside/outside verdict, and each decision records a `transition`: `entered`, `stayed_inside`, `left` or `stayed_outside`. The lamp fires only on `entered`. Saving a new zone or resetting clears the verdict, so the next inside counts as entering. Blocked decisions don't change it.

A newer segmentation replaces the current observation. Each segmentation can still trigger the lamp at most once: `claimPlacement` writes a row before the lamp call, and the pending event is saved first. If the process dies mid-call, the record stays `unconfirmed` and is never retried automatically.

## Tracking

The first identity is always manual: a person confirms a mug mask with `desk/select`. After that, `desk/track` takes the newest mug segmentation, picks the detection that overlaps the last box most (or the nearest one when none overlap) with `pickTracked`, records it as a `tracked` observation with its overlap, and verifies it in the same request. A frame with no mug changes nothing. Earlier observations are kept, newest first, in the memory's `history` (up to 12), which the lab shows as a timeline and a trail on the scene.

**Following locally (prototype).** Calling SAM for every frame pays for detection when only matching is needed. `Follow locally` in the lab cuts a grayscale template of the mug from the last SAM-confirmed frame and searches each new frame near the last box by normalized cross-correlation (`packages/domain/src/tracker.ts`). Nothing leaves the browser. The live camera is sampled every 100 ms at 160 px wide; in fixture mode each mug move is one step.

- **Masked template.** Only pixels inside SAM's mask are matched, not the whole box, so the desk around the mug isn't part of what's being looked for. When the mug moves onto a different surface, such as a white shirt, the old background can't drag the match down. A mask too plain to match on its own (a white mug with no shading) falls back to the whole box.
- **Look-alikes.** Each match records its lead over the best match elsewhere in the search area. A lead under 0.1 means two places look like the mug, so the box holds still rather than jumping to the look-alike. A small distance penalty breaks ties in favour of where the mug was.
- **Lost.** A score under 0.6 or a lead under 0.1 counts as unsure. While unsure, the box holds still and the search widens each step, so a mug that moved fast can still be found.

- **Stillness.** Picking the mug up always breaks the match for a moment: a hand covers it, it tilts, it blurs. So neither kind of SAM call below goes out until the area around the mug (the box grown by its own size on each side) has been still for 8 samples, about 0.8 s. "Still" means under 1.5% of pixels changed by more than 24 grey levels, the same rule as the playground's motion gate. Once the mug is set down, the widened search usually finds it again with no SAM call at all. Motion elsewhere in view, like typing, doesn't count.

SAM runs again through the normal `desk/track` path only when:

- **confirm**: the local box sits on the other side of the zone edge for a few samples. Leaving is confirmed too, so the server's last verdict stays right and the next entry still fires the lamp. Live checks wait at least 2 s after the last one.
- **re-anchor**: the match stays unsure for a few samples. Live re-anchors back off from 2 s to 30 s while the mug stays lost, and reset after about 3 s of good matches. If SAM can't see the mug either, following stays on and tries again later.

The lamp only ever fires on a SAM observation. The local box is a reason to look again, never a verdict. The template is only cut from SAM frames, so it doesn't drift. The zone can only be watched when it carries over, meaning the camera is marked fixed. A white mug against a white shirt has almost no contrast to match on, so expect a re-anchor there rather than a confident local box. Big changes in rotation, scale or lighting also show up as weak matches and fall back to SAM.

## Isometric view

`Iso` in the lab stage draws the same desk memory as a room: an office, a desk or a fridge. The scenes are hand-made presets in `packages/domain/src/iso-presets.ts`, built from prisms and cylinders on a tile grid. Nothing is generated: props and item models are drawn by a code-only voxel kernel (`packages/domain/src/iso-voxel.ts`) as pixel-art sprites, which `apps/web/src/iso` places in an SVG scene with the zones, trail and labels on top.

- **Pinning.** A person clicks the four corners of one surface (the desktop, a fridge shelf) on a photo, clockwise from the back left. `POST /api/desk/surface` saves them in desk memory as `surface`, and `surfaceMap` turns them into a homography from frame pixels to that surface. Like a carried zone, a pin applies to any frame of the same size and assumes the camera didn't move. The illustrated fixture fills the frame with the desktop, so it uses `FIXTURE_SURFACE` without a pin. Reset keeps the pin.
- **Placing.** `projectBox` stands the observation on the surface at the bottom-centre of its box, where it touches the surface, sized from the box's bottom edge. The trail and the zone are mapped the same way. A zone dragged on the iso surface is turned back into a frame `ZoneRect` (the bounding box of its corners), so `placementGate` is unchanged. The iso view never makes a decision.
- **Guessing.** `Guess scene` (`POST /api/scene/classify`, run kind `scene`) asks Spark which preset fits a live photo and which of its optional props are visible. The answer is checked against `sceneGuessSchema`, so Spark can only pick from the presets and props that exist. It is billed and counted like `discover`. The fixture always answers `desk`.

- **Model kernel.** Every part is a signed distance function; `voxelize` samples their union on a grid (32 voxels along an item's longest side in the room, 64 in the editor, 16 per tile for props) with a normal, a colour, a material and ambient occlusion per surface voxel. `renderSprite` casts one isometric ray per pixel and lights the hit with a fixed key light, four-step ramps with cooler shadows (`rampLab` in `color.ts`), ordered dithering, gloss and metal highlights, see-through glass, a darker outline where the model meets the background, a line where a nearer part overlaps, and a two-step contact shadow. Props are snapped to a palette built from the room's tones; items keep their photo's colours. Prop faces stay in the SVG, invisible, so picking and dragging still follow the geometry. `renderView` draws the same grid from the photo's camera, for fitting.
- **Item models.** `Model` opens an editor for a detailed model of the remembered object: up to 12 parts in item space, where the footprint fills the unit square and the height can reach 6 units (`packages/domain/src/iso-item.ts`). Shapes are `lathe` (a side profile turned on an axis, with an optional open top, inner wall and liquid), `rbox`, `tube` (a Bézier), `extrude` and `blob`; the first shapes (`cylinder`, `box`, `cone`, `handle`, `lid`) still load and are drawn as the new ones. Parts carry a material and up to six paint layers (`band`, `stripes`, `dots`, `top`, and palette-indexed `decal`s at most 64 × 32). A part can be locked so a refit keeps it.
- **Fitting to the photo.** `POST /api/item/draft` (run kind `item`) cuts the sighting out of its stored photo with SAM's mask (`maskedCrop`; the fixture rasterizes `desk.svg`), picks an archetype (`iso-archetypes.ts`: mug, cup, bottle, can, book, box, plant, generic) and runs `fitItem` (`item-fit.ts`). It clusters colours in OKLab and merges lit and shaded clusters of one material. It finds the axis from the narrowest rows and a handle from the rows that stick out on one side, and reads the camera's elevation from the surface pin's foreshortening or else from the rim's ellipse. It then corrects the side profile for the stacked-ellipse outline a lathe makes from above, finds bands down the front, and unwraps the visible half of the surface into a decal. Finally it renders the model from the camera and nudges its numbers by coordinate descent until the silhouette matches the mask (at most 48 renders). The result is stored with a fit record: archetype, numbers, IoU, ΔE, elevation, views, crop and assists. `sampled` makes no model call. `spark` adds Meta's models, each only able to help: Spark names the archetype and material (`itemClassSchema`); SAM segments parts inside the crop (a handle, the liquid), which the fitter uses instead of its own guesses; Spark then compares a render with the photo and suggests corrections clamped to ±20% (`applyCheck`), kept only if the silhouette still matches. A later sighting of the same object is fused into the shape (`fuseFits`). `POST /api/item/refit` fits again to the stored crop, keeping locked parts; `GET /api/item/crop` serves the crop for the editor's `Photo vs model` overlay. `POST /api/item/save` stores edits and scores them again against the crop. The model lives in desk memory as `item`, survives new sightings, and is cleared on reset with the object. Extra objects (below) get models the same way, by `objectId`. `bun scripts/fit-bench.ts` measures fit accuracy on synthetic crops, the fixture and any real crops in `fixtures/items/`.
- **Templates and custom scenes.** Every scene is built from the prop palette in `packages/domain/src/iso-templates.ts`: desks, tables, shelves, a fridge, lamps, books and so on. One placed template is a group. Its props and surfaces share the group id as a prefix (`desk`, `desk:leg-0`, surface `desk:top`), and it moves, turns and goes as one. The presets are made of these templates too. `Edit scene` starts from a preset, an empty floor or a Spark draft. You add templates (`addTemplate` finds the first spot where nothing overlaps), drag and turn groups, and remove them. Tabletop templates settle onto whatever surface ends up under them (`settleGroup`). Groups that cut into each other are flagged, since the depth sort assumes boxes don't intersect. `POST /api/scene/save` checks the scene against `isoSceneSchema` and keeps it in desk memory as `scene`, which reset keeps. It shows as `Custom`, and its surfaces can be pinned like a preset's. Saving a scene that no longer has the pinned surface clears the pin.
- **Spark layouts.** `Draft with Spark` in the scene editor (`POST /api/scene/draft`, run kind `layout`) asks Spark only which templates stand where on a grid, checked against `sceneDraftSchema`. `buildScene` builds the geometry, puts floor things first, settles tabletop things onto their surfaces, and checks the result against `isoSceneSchema`. Nothing is saved until you save it. The fixture answers with a fixed layout of the illustrated desk.
- **More objects, zones and lights.** `Objects & rules` adds up to four more objects and eight more zones (`others` and `rules` in desk memory). An extra object is confirmed by hand from a mask in the newest segmentation, of any concept, and then tracked only in segmentations of that same concept (`desk/objects/select`, `desk/objects/track`). A rule ties one object, one zone and one light together. `ruleGate` runs the same checks as `placementGate`: a fresh sighting, a zone drawn on that image or carried over by the fixed-camera assumption, and the whole box inside the zone. Each rule keeps its own inside/outside story, switches its light only on `entered`, and claims `segmentRunId:ruleId` before the call, so one segmentation can try each rule at most once. Rules are checked when their object is tracked (the mug's rules too, after the main zone) and on `Check rules`. The main zone, the main lamp and their tests are unchanged. Live lights are `HA_ENTITY_ID` plus `HA_EXTRA_ENTITY_IDS`, and the lamp adapter refuses any other entity. Fixture mode has three virtual lights. In a scene, a lamp prop stands for the main light unless the scene editor ties it to another (`lightId`). The fixture's synthetic SAM only knows the mug, so in fixture mode rules can only target the mug.

Amber stays reserved for lamps: an iso lamp warms only once an action on its light is confirmed.

## Lamp results

Home Assistant accepting a request, the entity reporting the requested state, and the bulb actually lighting up are three separate things. `LampResult` records the first two (`accepted`, `stateConfirmed`). `physicalEffectVerified` is always `false`, because the software has no way to see the lamp.

## Not built yet

- Automatic motion detection and continuous capture, outside the local-following prototype
- Recognising the same mug by appearance. Tracking matches by position only, so two mugs swapping places would fool it.
- Camera calibration, so a zone can carry over between frames from a camera that did move
- Combined conditions, such as two objects in their zones before one light turns on. Each rule is one object, one zone and one light.
- Extra objects in fixture mode: the synthetic SAM output only has the mug
