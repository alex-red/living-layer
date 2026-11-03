# Notes for coding agents

What isn't obvious from the code. [CONTRIBUTING.md](CONTRIBUTING.md) has setup, checks and commit style; [docs/architecture.md](docs/architecture.md) has how things fit together.

## Ground rules

- Don't start the dev server or run a build unless asked. If one is already running, use it to look. A probe that leaves the dev server's demo changed puts it back with `bun run reset demo`.
- The dev server (`bun run dev`) is the web on 127.0.0.1:43430 and the API on 43431 (`PORT`); other servers listening on this machine belong to other projects. Browser tests run on free ports of their own.
- Commit with `bun run commit -m "…" -- <files>`: it verifies just those files on HEAD in a clean worktree and commits only them, since other sessions edit and stage in this checkout.
- When another session has edits in a file you changed too, commit only your hunks: `bun run commit --hunks <file> --match "<text in your lines>"` writes `out/<file>.patch`; read it, then `bun run commit -m "…" --patch out/<file>.patch [-- <other files>]`. It commits through a temporary index, so the file on disk and what others staged stay as they are. Don't hand-swap a file's contents to commit part of it: that has undone lines committed meanwhile.
- When a check fails for no reason you can see, run `git status --short`: another session's half-done edit may be on disk. `bun run verify --at staged` or `--at <ref>` judges a snapshot in a clean worktree.
- Commit summaries stay under about 60 characters (Conventional Commits); put the detail in the body.
- Types are checked by `tsrs` against TypeScript 7.1 (`bun run typecheck`). Bun's own `bun check` is quicker but passes errors 7.1 reports, so it doesn't stand in for it.
- `bun run verify` checks format, types, lint, tests, the benches, the colour audit and unused exports in about 20 seconds, its steps side by side, as one summary; `bun run commit` runs it for you. Lint fails on any warning (`oxlint --deny-warnings`, hooks rules included).
- The browser suite (Playwright, `tests/browser/`) is manual while this is a prototype: CI, the pre-push hook and `verify` don't run it. Run `bun run browser` only when asked, and don't add or update browser tests unless asked.
- Cover a change with unit tests instead (`bun test`, `tests/*.test.ts`): test behaviour through the exported function or the route (`testApp`), not internals; one behaviour per test with a name that says it; no network, no clock or random without injecting them; build inputs from the real fixtures (`demoSegmentation`, `FURNITURE_SPECS`) rather than hand-written stand-ins. A bug fix gets a test that failed before it. Pure logic pulled out of a component (into `packages/domain` or a plain module beside it) is how UI behaviour gets a unit test.
- `bun run test:fast` runs the tests in four processes, dealt by each file's last time (`scripts/test-times.json`; `--record` refreshes it). A file over about 5 s sets the floor for the whole run: share setup or split it. A test that is slow on its own gets an explicit timeout, since under load it crosses bun's 5 s default.
- `bun run dead-exports` lists exports nothing else imports, and verify reports the count (0 now). Un-export or delete what it names rather than ignoring it.
- Format with `bun run format` or `bunx oxfmt <files>`, never Prettier.
- Before merging another session's branch, run `bun run verify --at <merge> --against main`. When you brief a side session, ask it to work in a worktree from the latest `main` and check `bun run bench:at main room` before it reports, since `main` may have moved.

## The isometric room

- One tile is 30 cm (`ISO_TILE_CM`, `cm()` in `packages/domain/src/iso-furniture.ts`), in every scene. Template sizes, model parts and fixtures (`tileCm()`) are real measurements; don't derive a scale from a scene's furniture.
- A prop is a box (for placing, picking and draw order). Its `form` names the model drawn inside it, built from `FURNITURE_SPECS`, and turned by its `turns`.
- Anything that needs a prop's shape (camera silhouettes, the room camera's renderer, synthetic photos) must go through `propSolids`, never the prop's box: a desk's box is mostly air. Grep for `propSolids` to find every reader.
- Changing a measurement means editing `FURNITURE_SPECS`, not a literal in a builder. To try values without editing, use `withFurniture` or a `--set` flag (below).
- The room layout's own numbers (costs, slack, quantiles) live in `LAYOUT_TUNING`; try them with `withLayout` or `--set layout.<key>=…`. To see why a thing landed where it did, use `bun run draft <run> --why <thing>` or `layoutRoom`'s `trace` option, not a hook patched into the source.

## The room camera

- Each room has one fixed camera, high in its front corner, calibrated against the room (`room-camera.ts`, `POST /api/room/calibrate`). The isometric room is the base: a scan places templates through that camera (`layoutRoom`), and nothing from the photo is pasted onto the room.
- There is no path without it: a scan, "Find the desk" and the room picture all go through the calibrated camera, and refuse (409 `not_calibrated`) until there is one or when a frame is another size. The demo is always calibrated.
- `RoomCamera` is in the scene's own tiles, walls included: the floor's inner corner is at the walls' thickness (0.2 tiles in the presets), so pass `origin` to `cameraFromMarks` when a scene has walls.
- The demo is the office rendered through `DEMO_CAMERA` (`demo-room.ts`): its frames, SAM masks, pin and the mug's close-up all come from that render. A demo mask is exactly what the frame shows, so test against `demoSegmentation`, not hand-written boxes.
- A saved camera or the phone may keep a zoomed view (`crop`): its frames arrive already cut, so the calibrated `RoomCamera` is the crop's, with its principal point off centre. Never assume `cx`, `cy` is the frame's middle.
- Across a room a mug is about 17 × 23 pixels. Anything that models or recognises one thing (the item fitter, the appearance layer) needs a close photo or a zoomed crop of it, not the whole frame.

## Server and web

- A new route goes in its resource's plugin. Its request schema goes in `packages/domain/src/requests.ts`, the web's call in the route table (`routes.ts`), and its method and path in `tests/routes.test.ts`, which pins every route in sorted order.
- Tracking is local first: SAM by name, Spark's discovery, SAM finding a fixture and the watcher's SAM asks are refused (409 `tracking_ai_off`) or skipped until _Let tracking call AI_ is on (`tracking_ai` in `settings`), in demo mode too. `testApp` turns it on unless given `trackingAi: false`; a new route that calls SAM or Spark for tracking goes through `requireTrackingAi`.
- Never hold desk memory across an `await`: read and write it in one step with `store.updateMemory(mode, fn)`. A memory read before a slow call and saved after it drops whatever was saved meanwhile.
- New lab state goes in a slice under `apps/web/src/workspace/state/`, not in `useLabState.ts`, which only composes them. Anything that changes several times a second goes in a store (`state/store.ts`) read by the components that show it.
- In the kernel's hot loops (`voxelize`, `renderSprite`, `renderView`, `renderRoom`) don't allocate per voxel or pixel. Two-argument `Math.hypot` stays: `Math.sqrt` rounds differently there and moved the stored normals.
- Fits and room renders run in Bun Workers (`COMPUTE_WORKERS`). Tests run them in place, so a worker-only bug only shows in the running server.
- The server deletes evidence older than `EVIDENCE_RETENTION_DAYS` (30) at startup and daily. A probe or bench that needs an old run should copy what it needs or set it to 0.

## The AI brush's ops

A new thing the brush can do is an op, and an op touches the same places every time. `tests/op-coverage.test.ts` fails until the case or the gap is in.

1. **The op.** A recipe op (a model's parts) goes in `RECIPE_OPS` (`recipe-ops.ts`) with its schema, apply function and line. Anything else is an intent op in `intent.ts`: `INTENT_KINDS`, its line in `INTENT_ABOUT`, its typed shape in `IntentOp`, any new flat fields in `sparkIntentSchema` (null when unused; add them to the `op()` helper in `demo-intent.ts` and the tests' `empty`), and its checks in `readOp`. Spark's prompt lists it from these registries, so don't edit the prompt for it.
2. **The demo.** A pattern in `demoIntent` (`apps/server/src/demo-intent.ts`) that answers in Spark's shape, or a reason in `DEMO_GAPS` (`scripts/lib/intent-cases.ts`).
3. **Cases.** One case in `INTENT_CASES` that it does, and one where `readIntent` asks back, then `bun run bench:intent`.
4. **Doing it.** A step in `finishDraft` (`apps/server/src/assist.ts`) if it builds or changes something there, and what saving does in `/api/assist/save`. Any new draft field goes in `AssistDraft` (`packages/domain/src/assist.ts`). Props are layout: anything an op keeps (a state, a stat) goes on a Thing (`memory.fixtures`), and furniture is made one first (`promoteGroup`, `promoteBuiltIn`), as `add_state` does.
5. **The review.** What the panel says about it in `Brush.tsx`, and a suggestion when it fits the target.
6. **Check it end to end** with `bun run brush --around <group> "…"` (offline, in the demo). The brush's MCP server (`bun run mcp`) lists the ops from the same registries.

## Look before and after

These run in seconds and need no server. Their output goes to `out/` (ignored).

| When you change…                        | Run                                                                       | What it tells you                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a furniture model or template           | `bun run sheet` (`--only chair --zoom 6`, `--room office`)                | every template at every turn as one PNG you can open; time per model                                                                                                                 |
| a Thing's model, its look or a starter   | `bun run model <source>…` (`--against`, `--uv`, `--layers`, `--turns all`) | any fixture, draft, save, run, starter, stock model or JSON drawn as the app draws it, side by side; `--uv` shows which way paint runs |
| the sculpt prompt, or reading its answers | `bun run sculpt <run>` (`--answer n`)                                     | a stored "Model with AI" run's answers read again with this tree, scored then and now, each as JSON for `bun run model` |
| a starter's print, or the part it is on  | `bun scripts/starter-prints.ts`                                           | starters' prints set in type into `starter-decals.ts`; `tests/print.test.ts` fails until it runs after such a change |
| templates, `room-scan.ts`, the renderer | `bun run bench:room`                                                      | position, turn and size margins for rooms scanned by their corner camera                                                                                                             |
| the room, its camera or the demo        | `bun run room` (`--labels`, `--hfov 80 --height 270`)                     | the room as its corner camera sees it, the demo's frame, as a PNG                                                                                                                    |
| the item fitter or kernel               | `bun run bench:fit`                                                       | IoU and ΔE per crop; on real crops, shape against the real size, and how far views of one thing disagree                                                                             |
| how a typed request is read             | `bun run bench:intent` (`--live` asks Spark, billed)                      | each sample request's ops against those wanted                                                                                                                                       |
| the AI brush's build or check           | `bun run assist <run>` (`latest`, `--catalog`)                            | a stored brush request built and checked again offline, then and now                                                                                                                 |
| the AI brush, end to end                | `bun run brush --around desk "…"` (`--then`, `--save`, `--box`, `--live`) | the panel's target beside the request's, the steps, model, check and cost; `out/brush/<run>/overlay.png`                                                                             |
| selection, SAM's outline, targets       | `bun run bench:brush` (`--live` asks SAM again, billed)                   | on captured rooms' marked things: the target named, SAM kept or replaced, IoU, size                                                                                                  |
| the watcher or the local tracker        | `bun run bench:track` (`capture` records a clip first, `truth` marks it)  | cost per layer and per thing, and SAM asks, on the watched camera's own frames; on a marked clip, each thing's identity (switches, IDF1, sure of the wrong thing)                    |
| how cameras are read (ffmpeg, relay)    | `bun run bench:stream` (`--gop 0.2`, `--url` a real camera)               | time to the watcher's first frame and to a still: cold, running, shared; frame rate, gaps, CPU; the camera's keyframe interval                                                       |
| any of the above                        | `bun run bench:at HEAD room`                                              | the same bench at a commit, then this tree against it, with regressions flagged                                                                                                      |
| a measurement you're unsure of          | `bun run bench:room --set desk.topCm=3,4,5`                               | every combination, a per-variant summary, and which values sit in a narrow pocket                                                                                                    |
| one of the layout's numbers             | `bun run bench:rooms --set layout.pastTop=2,4,8` (also `bench:room`)      | the same sweep over `LAYOUT_TUNING` (`layout-tuning.ts`), on real rooms' marks                                                                                                       |
| a colour, material or tone              | `bun run sheet --turns 0 --audit`                                         | specks: pixels much lighter than a prop's own tones (a metal highlight gone cream)                                                                                                   |
| tones, to match a picture               | `bun run ref office`                                                      | each named region's colours and the tone that draws them; checks the boxes too                                                                                                       |
| the room's overall look                 | `bun run sheet --room office --against office`                            | the room beside the reference picture                                                                                                                                                |
| the room draft (layout, models)         | `bun run draft <run> --relayout` (`--compare`)                            | a stored draft laid out again with this tree, what moved, both over its frame (side by side)                                                                                         |
| the same, on real rooms                 | `bun run bench:rooms` (`--marks`, `--accept` to keep a change)            | captured real rooms judged by their marked points (each one's error with `--marks`); overlays                                                                                        |
| why a thing went where it did           | `bun run draft <run> --why desk` (`--trace`)                              | its near points, reach, open sides, top, slack and every overlap fix it was in, cheapest first                                                                                       |
| calibration against layout              | `bun run draft <run> --relayout --calibration <room\|run\|saved>`         | the same draft through another camera, to tell which one is off                                                                                                                      |
| where things really stand, by hand      | `bun run truth <room>` (`things`, `zoom x,y,w,h`, `add <thing> x,y`)      | a captured room's marks: a gridded zoom to read pixels, marks checked against its ids, each one's error                                                                              |
| SAM, or anything before the layout      | `bun scripts/experiments/evaluate.ts <run>`                               | each cached experiment's masks laid out and scored against the room's marked points                                                                                                  |
| a calibration                           | `bun run calib --grid` (`--run <id>`, `--room <name>`, `--diff <a> <b>`)  | height, lens, pitch, roll, principal point; each upright's lean drawn, fitted and level; room sizes the marks fit; two cameras' gap in pixels; marks, uprights and grid over a frame |
| what a live run did, or why it failed   | `bun run runs [<run>]`                                                    | the run log; one run's steps, assists and pictures saved to `out/runs/`                                                                                                              |
| model calls or their limits             | `bun run runs --calls` (`--days 7`)                                       | count, p50/max latency and output tokens against each call's limits, and failures by cause                                                                                           |
| browser tests (only when asked)         | `bun run browser` (`--at <ref>`, `-g <pattern>`)                          | Playwright in a clean worktree on free ports, with failure traces                                                                                                                    |
| a browser test that failed              | `bun run trace [<test>]`                                                  | a failed browser test's steps, `/api` calls, console errors, open dialogs and locator region                                                                                         |

- A live draft costs money and finds problems late. Try a change on stored drafts first (`bun run draft <run> --relayout`, `bun run bench:rooms`, both offline); run live only to capture a new frame, then `bun run draft capture <run> --name <room>`. Captured rooms stay local (`.data/rooms/`, ignored): they are photos of a real home.
- An accepted layout is only a snapshot. A captured room's `truth.json` marks by hand where things touch down in its frame (`bun run truth`, `scripts/lib/truth.ts`), and the rooms bench scores a marked room by them alone. Judge a placement change by that, not by mask measures: in `docs/plans/sam-experiments.md` masks changed a lot and placement didn't. Mark only what the frame shows, and look at the overlay first, since a point can mark another thing than the one Spark's id names.
- Unit tests don't cover every bench case. Run the bench before and after; a case that met its targets and no longer does is a regression even if `bun test` passes.
- A bench's own targets (`ROOM_TARGETS`, `FIT_TARGETS`) are shared with the tests; known gaps are listed in the bench with a reason.
- Golden sprites: `tests/golden/` (archetypes) and `tests/golden/props/` (templates). Accept a deliberate new look with `UPDATE_GOLDEN=1 bun test tests/model.test.ts tests/furniture.test.ts`, and look at the PNGs before committing them.
- Screenshots of the running app are downscaled and the browser zoom only crops: to judge a model's pixels, use the sheet. `--fit 320` gives small things like a jar a readable size; `--focus x0,y0,x1,y1` (shares) keeps one part.
- A failing golden writes `out/golden-diff/<name>.png` (golden, new, moved pixels): look at it before `UPDATE_GOLDEN=1`. Goldens allow 1% of pixels to move, so a few specks pass them: the audit is what catches those.
- Judge a change to a model's shape by `bench:fit`'s `shape`, `spread` and `fused shape` columns (real sizes in `testdata/items/*.json`), not IoU. The fitter bends a shape to match one outline, so a fit can score 0.95 and be 45% off; SAM 3D's right shapes score lower. Log: `docs/plans/sam3d-experiment.md`.
- SAM 3D (refining a turned fixture's shape) is experimental and off unless `SAM3D_ENABLED=true`. The bench's SAM 3D rows read `testdata/items/*.sam3d.json`; `bun scripts/experiments/sam3d.ts --local --lathe` writes them again (about 9 minutes a crop).
- Choose a measurement from a stable range, not a value that passes beside a miss: the sweep's stability lines say which. Narrow pockets broke twice after unrelated changes.
- Reference pictures live in `design/reference/` with a JSON of named regions (shares of the picture, the tone, the face). Check `out/ref-<name>-regions.png` after editing boxes: a box over an edge reads the wrong colour.

## Shell

The agent shell here may be fish. Put anything with loops or `set --` in a script and run it with `bash`, or use a Bun script.
