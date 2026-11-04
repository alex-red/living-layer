# Corner camera, isometric room first · plan, October 30, 2026

Status: built, see [As built](#as-built--october-30-2026).

Today a photo is the base. We pin a surface in it, recover a camera from that one surface, and lay a 2.5D scene over the photo: photo textures (`photo-texture.ts`) and furniture nudged until it matches its mask (`layoutPhoto`, about 1,800 lines). The demo is a separate world: an illustrated close-up of a desk (`desk.svg`, `DEMO_POSITIONS`, `DEMO_SURFACE`), shaped nothing like a room.

The change makes the isometric room the base for everything:

- **One fixed camera per room, mounted high in a corner.** It is calibrated once against the room itself, not against whatever surface it happens to see.
- **The camera's job is to say what is in the room and where.** It names furniture and fixtures, and places them as templates on the room's 30 cm grid. Nothing from the photo is pasted onto the room.
- **The demo is the same room seen by a virtual corner camera.** Its frames are the iso scene rendered from that camera, so demo and live run one pipeline. The only difference is where the frames come from.

A high corner camera looks diagonally across the floor from above, which is the angle the iso view already draws. A zone drawn in the room lands where the person expects it in the camera, and the reverse.

## Decided

- **The lab shows the camera frame and the iso room side by side**, at equal size, once a room is calibrated.
- **Calibration:** SAM outlines the floor (one billed call), then the person drags the four corners and types the room's size.
- **The illustrated desk demo is replaced** by the iso office seen from a virtual corner camera.
- **All five phases** are to be done before submission.

## What stays

- Spark for naming things (`photoInventorySchema`) and SAM for outlining them. These are the same calls, prompts and billing.
- Templates, `FURNITURE_SPECS`, `propSolids`, the voxel kernel, and item and fixture models fitted from crops (`item-fit.ts`, `draftModel`).
- `placementGate` and `ruleGate`, unchanged. They still decide in frame pixels; only where their zone comes from changes (phase 3).
- The watcher, local following, appearance, MQTT and Home Assistant.

## Phases

Each phase leaves `main` working and verified (`bun run verify`), so we can stop after any of them before November 4.

### 1. A room camera (`packages/domain/src/room-camera.ts`)

- `RoomCamera` is a pinhole camera in room centimetres. The origin is the room's back-left floor corner: x along the back wall, y along the left wall, z up. It holds the focal length, the pose, the frame size, and the room's size in tiles.
- `cameraFromRoom(corners, frame, room)` builds one from the floor's corners as the camera sees them, plus the room's width and depth. A corner camera sees the far corner and both walls' floor lines, so the right angles measure the focal length. This is the same algebra as `cameraFromPin`, applied to the floor instead of a desktop.
- `project(camera, point)`, `unproject(camera, pixel, z)` and `footOf(camera, mask)` find where a mask meets the floor, or a surface at a known height.
- `virtualCorner(room, { height, inset, fov })` makes the camera a person would mount, for the demo and the benches.
- Tests: a round trip from scene to virtual camera to corners to `cameraFromRoom`, recovering the pose within `ROOM_TARGETS`.

### 2. The demo becomes a camera on the iso room

- `renderCamera(scene, camera)` draws the iso scene's props through a `RoomCamera` as a perspective picture, with an object mask per prop. It extends `renderView` and `syntheticPhoto`, which already draw templates from a photo's camera.
- `DemoSource` renders the office from `virtualCorner` instead of `desk.svg`. Moving the mug moves it in the scene and re-renders. The synthetic SAM returns the rendered masks, so it knows every object, which removes the "demo only knows the mug" limit.
- Retire `desk.svg`, `DEMO_POSITIONS`, `DEMO_SURFACE` and the hand-written demo masks once nothing reads them.

### 3. Zones and sightings live in the room

- A zone is stored in room space: a rectangle on a surface or the floor, in tiles. It is projected into the frame through the room camera when a gate needs it. The gates are unchanged, and a zone no longer depends on a source image's SHA-256.
- A fixed camera is required, so `assumedFixedCamera` is always true. Calibration adds what was missing: the calibration frame is kept, and `cameraMoved(frame)` (edges or DINOv3 patches against it) pauses rules and asks for a recalibration.
- A sighting is placed by `footOf` on the surface it stands on, replacing `projectBox` and the per-surface pin. A pin becomes a by-product of the room camera, not a step.

### 4. A room from the camera

- `POST /api/room/calibrate`: one frame. SAM outlines `floor`, and the floor mask's hull gives the corner candidates. The person drags the corners into place and enters the room's size. The camera is saved in desk memory as `camera` (`RoomCamera` plus the reference frame).
- `POST /api/room/scan` uses the same Spark inventory and one SAM call, then `layoutRoom`:
  - furniture stands where its mask meets the floor through the known camera;
  - each item is turned to whichever of its four turns best matches its mask, drawn through the same camera;
  - things on a surface stand on that surface's top.

  There is no surface bootstrap and no photo textures. `layoutRoom` replaces most of `layoutPhoto`.

- Review stays as it is now: the room drawn beside the frame, with things that can be swapped, removed or dragged, and save.
- `bench:room` replaces `bench:scene`. It takes known scenes, renders them from several corner cameras, scans them, and compares templates, positions and turns. The cases come from phase 2's renderer, so the benches and the demo share one source of truth.

### 5. Clean-up

- Remove `photo-texture.ts`, the surface pin flow (`auto-pin`, `pinFromMask`, `refinePin`), and the parts of `photo-scene.ts` that only existed to find a camera from one surface. `bench:scene` goes when `bench:room` covers it.
- Update `docs/architecture.md` and `AGENTS.md`, and add an upgrade for old desk memory: a zone tied to an image hash is dropped with a note asking to redraw it.

## Risks

- **Time.** Phases 1–2 are about a day, 3 about a day, 4 one to two days. Phase 4 is where it is least sure.
- **Calibration depends on seeing the floor corners.** A desk or sofa hiding a corner needs a fallback: two floor lines plus the room's size, or a guessed lens as `cameraFromPin` already uses.
- **Small things on a desk across the room are a few dozen pixels wide.** SAM will outline them, but item models fitted from a crop that small will be coarse. Fixtures and items can still be drafted from a close-up reference photo, as they are today.
- **A corner camera is wide-angle.** Barrel distortion bends the floor lines. A one-parameter radial term in `RoomCamera`, fitted from straight floor edges, may be needed for real cameras.

## As built · October 30, 2026

All five phases landed, with these changes from the draft above:

- **Calibration marks.** The draft relied on the floor's outline alone. In a furnished room the desk, bookcase, chair and plant hide most of the floor's edge, so the hull's top isn't the corner. `room/floor` now outlines the floor and the walls (two SAM calls, live), and `marksFromWalls` fits each wall's floor line to the points where floor meets wall directly. In the demo office the corner lands within half a pixel.
- **Lens and tilt.** The corner and two lines alone leave the lens trading off against the tilt: 10–20 px of error across the floor. A wall's far end (when it is in view) or the camera's height fixes it. The overlay has a box for each, and a typed height gives under 1 px.
- **Walls.** Preset walls are 0.2 tiles thick, so the floor's inner corner isn't the scene's origin. `cameraFromMarks` takes an `origin`, and the room's size is typed inside the walls (the office is 294 × 234 cm).
- **Gates.** These are unchanged. A zone drawn in the room keeps where (`onSurface`), and applies to every frame of the calibrated camera with no fixed-camera assumption. Its rectangle in the frame is still what's judged: a zone on a desk should reach a little behind what stands in it, since a mug's top rises above the desk's plane.
- **Small things.** Across the room the mug is 17 × 23 px. Item drafts in the demo model it from a close photo (`demoCloseUp`). The appearance layer embeds a zoomed square around the thing. At that size it is rarely sure of a moved mug, and the test checks that it is never sure of a wrong place.
- **Old demo memory.** Desk memory from the illustrated desk is dropped on load (`upgradeMemory`): its zones were the same frame size and would have carried over to the wrong place.

**The older paths, moved onto the camera (October 31).** There is no layout without a calibrated camera any more. `layoutPhoto`, `pinFromMask`, `refinePin`, the synthetic photos and `bench:scene` are gone (about 1,000 lines); `bench:room` and `bench:at … room` replace them. A scan, `desk/auto-pin` and the room picture refuse with 409 `not_calibrated` until there is a camera, or when a frame is another size. Auto-pin places any surface of the room through the camera, with no SAM call. The live onboarding's second step is calibrating the camera, not a close photo of the desk. The room picture is a corner-camera frame redrawn by Muse Image at the frame's size, keeping its framing (`drawnFrom`), so the scene maps onto it through the pin's camera both ways and dragging a fixture on it works. SAM no longer looks for the desk on the picture, and a picture drawn the old way is dropped on load. The demo's picture is its saved room rendered through the demo camera, and the bundled pictures of the illustrated desk are gone. The close desk view keeps its own hand-pinned camera and its picture (live only). The surface-top fitter (`fitSurfaceQuad`, `surfaceTop`) had no use left and went too. The camera behind a pin (`cameraFromPin`, `pinCamera`) stays: fixtures and pictures on a pinned surface go through it. Photo textures are gone: no new ones are painted, and old scenes still show theirs.
