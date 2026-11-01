# Notes for coding agents

What isn't obvious from the code. [CONTRIBUTING.md](CONTRIBUTING.md) has setup, checks and commit style; [docs/architecture.md](docs/architecture.md) has how things fit together.

## Ground rules

- Don't start the dev server or run a build unless asked. If one is already running, use it to look.
- Commit with `bun run commit -m "…" -- <files>`: it verifies just those files on HEAD in a clean worktree and commits only them, since other sessions edit and stage in this checkout. The pre-commit hook refuses plain `git commit`; `COMMIT_ANY=1` is for a merge's conflicts, after checking what is staged.
- When a check fails for no reason you can see, run `git status --short`: another session's half-done edit may be on disk. `bun run verify --at staged` or `--at <ref>` judges a snapshot in a clean worktree.
- Commit summaries stay under about 60 characters (Conventional Commits); put the detail in the body.
- Types are checked by `tsrs` against TypeScript 7.1 (`bun run typecheck`). Bun's own `bun check` is quicker but passes errors 7.1 reports, so it doesn't stand in for it.
- `bun run verify` checks format, types, tests, the benches and the colour audit in about a minute, as one summary; `bun run commit` runs it for you.
- Before merging another session's branch, run `bun run verify --at <merge> --against main`. When you brief a side session, ask it to work from the latest `main` and check `bun run bench:at main room` before it reports, since `main` may have moved.

## The isometric room

- One tile is 30 cm (`ISO_TILE_CM`, `cm()` in `packages/domain/src/iso-furniture.ts`), in every scene. Template sizes, model parts and fixtures (`tileCm()`) are real measurements; don't derive a scale from a scene's furniture.
- A prop is a box (for placing, picking and draw order). Its `form` names the model drawn inside it, built from `FURNITURE_SPECS`, and turned by its `turns`.
- Anything that needs a prop's shape (camera silhouettes, the room camera's renderer, synthetic photos) must go through `propSolids`, never the prop's box: a desk's box is mostly air. Grep for `propSolids` to find every reader.
- Changing a measurement means editing `FURNITURE_SPECS`, not a literal in a builder. To try values without editing, use `withFurniture` or a `--set` flag (below).

## The room camera

- Each room has one fixed camera, high in its front corner, calibrated against the room (`room-camera.ts`, `POST /api/room/calibrate`). The isometric room is the base: a scan places templates through that camera (`layoutRoom`), and nothing from the photo is pasted onto the room.
- There is no path without it: a scan, "Find the desk" and the room picture all go through the calibrated camera, and refuse (409 `not_calibrated`) until there is one or when a frame is another size. The demo is always calibrated.
- `RoomCamera` is in the scene's own tiles, walls included: the floor's inner corner is at the walls' thickness (0.2 tiles in the presets), so pass `origin` to `cameraFromMarks` when a scene has walls.
- The demo is the office rendered through `DEMO_CAMERA` (`demo-room.ts`): its frames, SAM masks, pin and the mug's close-up all come from that render. A demo mask is exactly what the frame shows, so test against `demoSegmentation`, not hand-written boxes.
- A saved camera or the phone may keep a zoomed view (`crop`): its frames arrive already cut, so the calibrated `RoomCamera` is the crop's, with its principal point off centre. Never assume `cx`, `cy` is the frame's middle.
- Across a room a mug is about 17 × 23 pixels. Anything that models or recognises one thing (the item fitter, the appearance layer) needs a close photo or a zoomed crop of it, not the whole frame.

## Look before and after

These run in seconds and need no server. Their output goes to `out/` (ignored).

| When you change…                        | Run                                                        | What it tells you                                                                   |
| --------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| a furniture model or template           | `bun run sheet` (`--only chair --zoom 6`, `--room office`) | every template at every turn as one PNG you can open; time per model                |
| templates, `room-scan.ts`, the renderer | `bun run bench:room`                                       | position, turn and size margins for rooms scanned by their corner camera            |
| the room, its camera or the demo        | `bun run room` (`--labels`, `--hfov 80 --height 270`)      | the room as its corner camera sees it, the demo's frame, as a PNG                   |
| the item fitter or kernel               | `bun run bench:fit`                                        | IoU and ΔE margins per crop                                                         |
| how a typed request is read             | `bun run bench:intent` (`--live` asks Spark, billed)       | each sample request's ops against those wanted                                      |
| the AI brush's build or check           | `bun run assist <run>` (`latest`, `--catalog`)             | a stored brush request built and checked again offline, then and now                |
| the watcher or the local tracker        | `bun run bench:track` (`capture` records a clip first)     | cost per layer and per thing, and SAM asks, on the watched camera's own frames      |
| any of the above                        | `bun run bench:at HEAD room`                               | the same bench at a commit, then this tree against it, with regressions flagged     |
| a measurement you're unsure of          | `bun run bench:room --set desk.topCm=3,4,5`                | every combination, a per-variant summary, and which values sit in a narrow pocket   |
| a colour, material or tone              | `bun run sheet --turns 0 --audit`                          | specks: pixels much lighter than a prop's own tones (a metal highlight gone cream)  |
| tones, to match a picture               | `bun run ref office`                                       | each named region's colours and the tone that draws them; checks the boxes too      |
| the room's overall look                 | `bun run sheet --room office --against office`             | the room beside the reference picture                                               |
| the room draft (layout, models)         | `bun run draft <run> --relayout`                           | a stored draft laid out again with this tree, what moved, both over its frame       |
| the same, on real rooms                 | `bun run bench:rooms` (`--accept` to keep a change)        | captured real rooms against their accepted layouts, and marked points; overlays     |
| SAM, or anything before the layout      | `bun scripts/experiments/evaluate.ts <run>`                | each cached experiment's masks laid out and scored against the room's marked points |
| a calibration                           | `bun run calib --grid`                                     | the saved fit, room sizes the marks fit, marks and grid over a frame                |
| what a live run did, or why it failed   | `bun run runs [<run>]`                                     | the run log; one run's steps, assists and pictures saved to `out/runs/`             |

- A live draft costs money and finds problems late. Try a change on stored drafts first (`bun run draft <run> --relayout`, `bun run bench:rooms`, both offline); run live only to capture a new frame, then `bun run draft capture <run> --name <room>`. Captured rooms stay local (`.data/rooms/`, ignored): they are photos of a real home.
- An accepted layout is only a snapshot. A captured room's `truth.json` marks by hand where things touch down in its frame (`scripts/lib/truth.ts`), and the rooms bench scores against it. Judge a placement change by that, not by mask measures: in `docs/plans/sam-experiments.md` masks changed a lot and placement didn't. Mark only what the frame shows, and look at the overlay first, since a point can mark another thing than the one Spark's id names.
- Unit tests don't cover every bench case. Run the bench before and after; a case that met its targets and no longer does is a regression even if `bun test` passes.
- A bench's own targets (`ROOM_TARGETS`, `FIT_TARGETS`) are shared with the tests; known gaps are listed in the bench with a reason.
- Golden sprites: `tests/golden/` (archetypes) and `tests/golden/props/` (templates). Accept a deliberate new look with `UPDATE_GOLDEN=1 bun test tests/model.test.ts tests/furniture.test.ts`, and look at the PNGs before committing them.
- Screenshots of the running app are downscaled and the browser zoom only crops: to judge a model's pixels, use the sheet. `--fit 320` gives small things like a jar a readable size; `--focus x0,y0,x1,y1` (shares) keeps one part.
- A failing golden writes `out/golden-diff/<name>.png` (golden, new, moved pixels): look at it before `UPDATE_GOLDEN=1`. Goldens allow 1% of pixels to move, so a few specks pass them: the audit is what catches those.
- Choose a measurement from a stable range, not a value that passes beside a miss: the sweep's stability lines say which. Narrow pockets broke twice after unrelated changes.
- Reference pictures live in `design/reference/` with a JSON of named regions (shares of the picture, the tone, the face). Check `out/ref-<name>-regions.png` after editing boxes: a box over an edge reads the wrong colour.

## Shell

The agent shell here may be fish. Put anything with loops or `set --` in a script and run it with `bash`, or use a Bun script.
