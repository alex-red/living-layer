# Refactor and speed-up · November 2, 2026

_Status: done, on `main` since November 3. Each item's `_Landed:_` note says what was measured and what was left as it was, and why._

Where the code is slow, fragile or hard to work in, and what to do about each, in the order that pays. Measured at `faedf5c` on a 12-core Mac. The kernel timings come from patched copies in a scratch folder, not from the tree, so re-measure each one as it lands.

Submission is November 4 at 7 PM Edmonton time ([current.md](current.md)). Everything marked **now** changes no behaviour (or fixes a bug), is small, and has a check that says whether it held. Everything marked **later** reshapes code or changes what a model sees, and waits until after the submission.

## What was measured

| Where             | Finding                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run verify`  | 103 s, all of it on one core (104 s CPU). Tests take 68 s; the benches and the audit take 35 s more, one after another. Format 0.2 s, types 0.3 s.                      |
| `bun test`        | 65 s over 39 files, run serially. `fixture-scan.test.ts` alone takes 16 s. One `api-client` test waits 6 s in real time (`BACK_WITHIN_MS`).                             |
| The kernel        | Building the office's 13 prop sprites takes about 0.8 s. `fitItem` takes 0.2–0.9 s a crop, and 20–25 of its 48 renders voxelize a shape it already voxelized.           |
| The server        | `fitItem` runs on the request path, up to 8 times a scan: seconds of frozen event loop, which stalls the watcher, SSE and MJPEG. `renderRoom` takes about 80 ms a call. |
| The server's data | `/api/status` parses every live run on each call (899 rows, 11.9 MB, 14 ms, growing). Every boot rewrites 77 evidence rows. Evidence is never pruned (586 MB).          |
| The web           | One 803 KB JS chunk (252 KB gzipped) with no lazy imports. A 1 Hz tick, the 10 Hz follow and the 350 ms AI-task poll re-render the whole workspace.                     |
| Errors            | The server logs nothing (`logger: false`) and reports a local `TypeError` as a Meta `upstream_failure`.                                                                 |

## Principles

- **Same output first.** A kernel change must leave the pixels as they were: goldens pass without `UPDATE_GOLDEN`, and `bun run bench:at HEAD room`, `bench:fit`, `bench:rooms` and `sheet --turns 0 --audit` report what they did before.
- **Numbers before and after.** Record each item's timing here when it lands.
- **One workstream per session.** A, B, C and D touch separate files and can run at once, each in a worktree from the latest `main`.
- **Behaviour changes wait.** Changing the frame format, deleting data and splitting the lab's state are after the submission, and the first two need a decision.

## A. Faster checks (`scripts/`, `tests/`)

**A1. now: no real waits in tests.** `api()` waits up to 6 s for the server to come back (`apps/web/src/api.ts:58-76`). Make the wait and the poll interval options, so the test at `tests/api-client.test.ts:24` runs in milliseconds.
_Done when:_ that test takes under 100 ms.
_Landed:_ `serverWait` in `api.ts` holds the wait and poll (6 s and 1 s in production); the test sets 30 ms and 5 ms. The file runs in 40 ms, from 6 s.

**A2. now: verify runs its steps at once.** Every step is its own process, and none needs another's output. Run them in a pool of about half the cores, and print the summary in the same order. First check that the benches write separate files in `out/`.
_Done when:_ verify takes about as long as its slowest step.
_Landed:_ a pool of half the cores (6 here). The benches write different files (`rooms-<name>*.png`, `prop-sheet.png`, nothing), so none run serially. `verify` took 98 s and takes 22 s, set by the rooms bench (about 18 s once the other steps share the cores).

**A3. now: tests in shards.** Split `bun test` into four processes by the files' last recorded times, and add up their pass and fail counts for verify's line. `ci` and the pre-push hook use the same split.
_Done when:_ the tests take under 25 s and still count 576 passing.
_Landed:_ `scripts/test-shards.ts` (`bun run test:fast`, used by `ci` and verify) deals the files over 4 processes by their last times (`out/test-times.json`, else the checked-in `scripts/test-times.json`; `--record` refreshes it). A failing shard prints its whole output. The tests went from 62 s to 19–22 s with 575 passing (576 in the plan was from before the files changed). `fixture-scan.test.ts`, 15 s on its own, now bounds the wall time.

**A4. now: share the demo scan in `fixture-scan.test.ts`.** Tests that only read a scan's result share one scan (`beforeAll`). Measure again after B.
_Done when:_ the file takes under 6 s.
_Landed:_ the demo's first scan runs once in `beforeAll` and six tests copy that store. The file went from 14.1 s to 10.3 s, not under 6 s: the rest are scans each test needs for itself (about 0.85 s each, 12 of them). Measure again after B.

_Landed (A4 remainder):_ measured again after B and the workers: 8.5–11 s on a loaded machine (load about 9; 10.4 s of CPU), still over 6 s, and not cut further. What is left is the seed scan (about 1 s) and nine tests that each scan a state of their own (a fixture saved first, a drafted room, live with a mocked Meta API, a second scan after an edit): sharing those would change what they test. `scripts/test-times.json` was refreshed with `bun run test:fast --record` (fixture-scan 8.48 s).
Split instead, so the shards balance: `fixture-scan.test.ts` 3.8 s (38 tests), `fixture-scan-desk.test.ts` 4.9 s (8 tests, the seeded demo-desk scans), 46 tests as before; the helpers are in `tests/lib/fixture-scan.ts`. Full suite 52 s in one process, 18 s under `test:fast` (4 shards); 602 tests, 0 fail, 1 skip.

**A5. later: one test harness.** About 20 files repeat `mkdtemp`, `parseConfig`, `buildApp`, `post` and the cleanup. `tests/lib/app.ts` exports `testApp({ env, fetcher })` and cleans up after itself.

_Landed:_ `tests/lib/app.ts` exports `testApp({ env, name, from, fetcher, …buildApp options })`, returning `{ app, post, get, memory, dataDir, config, fetcher }` on a fresh folder with a mocked fetcher and no web files; it closes the app and removes the folder after each test. `tempDir(name)` is the same folder without an app. Twenty files use it (assist, cameras, desk, expose, fixture, fixture-scan, iso, item, jobs, photo, place-fit, remote, room-scan, routes, scene, selection, store-migrate, store-prune, streams, watch); the test count and assertions are unchanged. `core.test.ts` (one `config()` shared by many apps) and `brush.test.ts` (apps built once in `beforeAll`) keep their own setup, as does the seed folder in `fixture-scan.test.ts`.

**A6. now: oxlint.** There is no linter, and 86 `useEffect`s have no hooks rules (`useLabState.ts:602` spreads its dependencies). Add oxlint with the react-hooks rules as a reported step in verify, and make it fail the run once it is clean.
_Landed:_ oxlint 1.90.0 (`bun run lint`, `.oxlintrc.json`: `rules-of-hooks` as error, `exhaustive-deps` as warning, nothing else). Today it reports 0 errors and 21 warnings, 10 of them in `useLabState.ts`. It does not fail verify yet; make it gate when the count reaches 0.

_Landed (A6 gate):_ the last nine warnings are fixed (`PhonePairing` keys its poll on a boolean; the effects that watch fewer values than they read carry a comment saying why). `lint` is `oxlint --deny-warnings`, a gate in `verify`, and part of `ci`.

**A7. later: catch dead exports.** Add a verify step (knip, or a small script) that lists exports nothing imports. It would catch 7 in domain, 8 in web and about 30 in server today.
_Landed:_ `bun run dead-exports` (`scripts/dead-exports.ts`), a report step in verify. It reads imports with a regex, since the TypeScript 7 beta has no JS API, and follows `export *` through the domain index. It found 216 at first (a type-only namespace import, `import type * as R`, was missed, which hid the use of every `requests.ts` type by `routes.ts`); after fixing that and un-exporting the names only their own file uses, it finds 0, and `IGNORE` is empty.

**A8. now: docs that drifted.** `architecture.md`'s server table names `lamp.ts`, which is gone, and leaves out `fixture.ts`, `assist.ts`, `watcher.ts`, `jobs.ts`, `photo.ts` and `illustration.ts`. `current.md` says `bun run check`; the script is `bun run ci`.
_Landed:_ both fixed.

## B. The rendering kernel (`packages/domain`), with identical output

**B1. now: no arrays in the ray cast.** `cast` builds five arrays with `.map` for every ray (`iso-voxel.ts:661-694`). `renderSprite` and `renderView` make a closure and tuples per pixel (`:808-856`, `:972-993`). Use plain numbers. Probe: `renderSprite` 14.2 → 6.4 ms, `renderView` 24.5 → 7.7 ms, pixel-identical.

_Landed:_ `cast` is plain numbers and `renderSprite`/`renderView` share one visit closure; `renderView` on a mug 15.8 → 5.5 ms, `renderSprite` 10.7 → 7.5 ms. Hashes of every sprite, view and grid unchanged.

**B2. now: `Math.sqrt` for `Math.hypot`.** In Bun, `hypot` is about 12 times slower. It is in the distance functions (`:58`, `:135`, `:177`, `:250`), the normals and AO passes, and `deltaE` (`color.ts:55`). Probe: `voxelize` 25–30% faster.

_Landed:_ `Math.hypot` of three is `sqrt(a*a+b*b+c*c)` in the SDFs, normals, AO and `deltaE`: Bun gives the same bits for the three-argument form (checked on 10⁶ random triples). The two-argument form rounds differently (1.2% of inputs differ), so those calls, and `renderRoom`'s lens, stay `Math.hypot`; switching them moved the stored normals.

**B3. now: test each voxel only against the parts near it.** Today every voxel tests every part (`iso-voxel.ts:460-494`). Loop part by part over its padded bounds instead, and keep the best distance in a `Float64Array` so ties fall as they do now. Probe, with B2: the office's forms 675 → 415 ms, with identical occupancy and normals.

_Landed:_ part by part over its padded bounds, with the reach test kept exact inside. Office forms voxelize 784 → 577 ms before B7; occupancy and owners identical.

**B4. now: `refineFit` voxelizes each shape once.** Cache the grid by the fit's numbers inside one refine (`item-fit.ts:919`, `:1070-1093`). The elevation knob only moves the camera.

_Landed:_ `scoreItem` takes an optional grid cache keyed by the parts and resolution, made once per `refineFit`. `fitItem` on the synthetic mug 898–1024 → 413–516 ms, tall mug 454 → 242 ms in `bench:fit`; the fits are byte-identical.

**B5. now: `renderRoom`'s colour pass.** Plain arithmetic and direct writes (`room-render.ts:238-248`), probe 84 → 46 ms. Reuse the full-frame depth and id buffers that `drawnInset` (`room-scan.ts:123-140`) and `fitGroup` (`place-fit.ts:44`, `:86`) allocate for every search.

_Landed:_ the lens falloff is a table kept per frame size (built with the same `Math.hypot`), pixels are written directly, and `drawnInset` borrows the depth and id buffers (`renderRoom`'s `scratch` option). Six presets' `renderRoom` 303–322 → 192 ms; pictures and layouts identical. `fitGroup`'s per-candidate picture borrows the same buffers (the room it is compared with is allocated once and kept); the demo desk search 317 → 295 ms, same fit, `bench:at main room` unchanged.

**B6. now: one grid for the lit and unlit sprite.** `renderPropSprite` voxelizes the same parts twice (`iso-prop-sprite.ts:112-122`).

_Landed:_ `renderPropSprite` keeps the last four grids, keyed by the parts and density it sampled (not `propSpriteKey`, which ignores `withFurniture`). All presets' props, lit and unlit: 2.2–2.4 s → 1.3–1.5 s.

**B7. later: parts per block for normals.** After B3, the normals pass is most of the shelf's time (78 of 116 ms). Keep a list of parts per 8³ block.

_Landed:_ done now, since it stays identical: a list of parts per 8³ block, grown by a voxel and a half, keeps the reach test and order. Office forms 963 → 461 ms (shelf 329 → 93, chair 108 → 25); `bun run sheet` total about 4.3 s → 2.3 s. Timings are noisy while other sessions run.

_Done when:_ the checks in the principles report what they did before, and `bun run sheet` and `bench:fit` timings are recorded here. Faster tests (A4), scans (C7) and sprites (D4) follow from this.

## C. The server (`apps/server`)

**C1. now: log what goes wrong.** Log the stack of any error that isn't a `LabError` (`app.ts:97`, `:175-196`; `index.ts:47` drops the cause). Report only SDK and network errors as `upstream_failure`, and everything else as `internal` (`errors.ts:96-101`). The live checks in [current.md](current.md) need this.
_Landed:_ errors that aren't a `LabError` are logged with their stack (`logError`, in `safeError` and the error handler); only SDK, network and timeout errors stay `upstream_failure`, the rest is `internal` with a generic message. `index.ts` logs the startup cause.

**C2. now: no desk memory held across an await.** `verifyRules` reads memory (`desk.ts:253`), waits up to 3 s on `turnOn` (`:307`), then saves what it read (`:323`). Anything another route, the exposer or `watcher.checkCamera` (`watcher.ts:651-656`) saved meanwhile is lost. Add `store.updateMemory(mode, fn)`, which reads again and applies the change in one synchronous step.
_Done when:_ a test that saves a fixture during a slow `turnOn` keeps it.
_Landed:_ `store.updateMemory(mode, fn)`; `verify`, `verifyRules` and `watcher.checkCamera` use it, and `tests/desk.test.ts` keeps a rule saved during a slow `turnOn`. `verify` (the main zone) had the same stale save and is fixed too.

**C3. now: migrations once.** `renameDemoMode` runs on every boot (`store.ts:54-66`). Its `LIKE '%fixture%'` now matches every fixture run, and it would also rewrite a future `"source":"fixture"`. Gate migrations by `PRAGMA user_version`, and set `busy_timeout` and `synchronous = NORMAL`.
_Landed:_ migrations run once by `PRAGMA user_version`; `busy_timeout` 5000 and `synchronous = NORMAL` (WAL was already on). `tests/store-migrate.test.ts`.

**C4. now: stop calls nobody is waiting for.** Add a `requestSignal(request)` helper that aborts when the client goes away, and pass it through `run()`. Give `segment()` a signal too, so the watcher's SAM asks stop with it (`app.ts:482`), and give `pictureFind` the job's signal (`illustration.ts:400`).
_Landed:_ `requestSignal(request)` (`request-signal.ts`) aborts on client disconnect and is threaded through `run()` to `/api/segment` and `/api/item/draft`; the watcher aborts its SAM asks when it stops or restarts. `pictureFind` already took `job.signal`.

**C5. now: ask SAM for a mug's two parts at once** (`item.ts:187-191`), which saves one round trip.
_Landed:_ `draftModel` asks a mug's part masks with `Promise.all`.

**C6. now: jobs per app.** `jobs` is a module singleton that every `buildApp` rebinds (`app.ts:326`). Its `trackers` map is never pruned (`jobs.ts:56`, `:74-77`), and each job keeps its step pictures for the life of the process. Make one `Jobs` per app, prune finished trackers, and move the job routes out of `fixture.ts:1622-1633` into `jobs.ts`.
_Landed:_ one `Jobs` per `buildApp`, passed to the routes that start jobs; stale jobs are pruned with their trackers; `/api/jobs/:id` and its stop route live in `jobs.ts`. `tests/jobs.test.ts`.

**C7. later: fitting and rendering off the event loop.** After B, measure a scan again. If one still holds the loop for more than about 200 ms, run `fitItem` and `renderRoom` in a small Bun Worker pool: domain is pure, and the RGBA buffers can be transferred.

_Landed:_ measured on the demo: `fitItem` held the loop 150–300 ms per thing (the scan's longest stretch 213 ms warm-ish, 300 ms under load); `renderRoom` 70–150 ms. `apps/server/src/workers/compute.ts` runs both in a pool of up to 2 Bun Workers (`COMPUTE_WORKERS=<n>`; 0, and the default under `bun test`, runs in place), with rendered buffers transferred. The longest block of a demo scan is now 1–5 ms; results are byte-identical (`tests/compute-workers.test.ts`). A failed worker falls back to running in place.

**C8. later: one Spark call in `meta.ts`.** Thirteen methods repeat the same 45 lines (`meta.ts:400-1091`). Replace them with one `structured(kind, …)` that takes its tokens and effort from `SPARK_CALLS`. Today `reasoningOf` is applied for only three kinds, so an effort set for any other kind does nothing. `lookupProduct` should use the same reserve and settle, and `SPARK_BUDGET` should be derived. Check with `tests/calls.test.ts` and `bench:intent`.
_Landed:_ `meta.ts` went from 1304 to 965 lines. One private `structured()` serves every Spark method, and `lookupProduct` shares its reserve and settle. `SPARK_BUDGET` is derived, and `classifyCause` uses `isTimeout` from `errors.ts`. `tests/meta-requests.test.ts` snapshots every kind's request, taken before the change and unchanged after. No effort setting was dead: only `fixtureScan` and `productLookup` set one, and both were applied.

**C9. later: route helpers.** Five small helpers would replace about 60 repeated blocks:

- `liveImage()` for the 14 `demo_image` guards
- `meta.mustAfford()` for the 11 spend checks
- `requireFrame()` for the 14 `not_calibrated` checks
- `pngUrl()` for about 16 data URLs
- `addUsage` in domain for 4 usage summers

_Landed:_ `liveImage(mode, imageDataUrl, message?)` (`errors.ts`) replaces the demo-mode upload guards; `meta.mustAfford(usd, what, message?)` the spend-limit blocks (a few sites keep their own wording through `message`); `requireFrame(image, frame, message?)` (`images.ts`) the frame-size checks; `toDataUrl` (already in `images.ts`) the inline data-URL builders, JPEG ones included, since it reads the type from the bytes; `addUsage` is in domain's `api.ts`. Left as they were because they differ: the `demo_image` checks with their own condition (`fixture.ts` draft and photo), and the bare `!calibration` throws, which are one line each.

_Landed (C9 remainder):_ `requireCalibration(memory, message?)` and `NOT_CALIBRATED` are in `errors.ts` and replace the bare `not_calibrated` throws in assist, photo (two), pin, select and illustration; `modeImage(mode, imageDataUrl, { live, demo })` replaces the fixture photo's check. Left as they are: the fixture draft's `demo_image` rule (it also reads `reference` and `box`), the illustration's desk-view check (live only, no upload involved), `scene-fit` (the camera is the demo constant or the saved one) and `room.ts` (reads `memory.camera` and says its own thing).
**C10. later: routes as plugins.** Register one Fastify plugin per resource, with its prefix. That moves the fixture routes out of `desk.ts` and puts the scene routes, now spread over three files, into one. The 240–310-line handlers (`fixture.ts:429`, `:668`, `:982`) become services, and `run()` moves into `runs.ts`.

_Landed:_ `runs.ts` holds `createRunner(store)` and the `Runner` type; `route-deps.ts` holds `RouteDeps`, and each plugin takes `Pick<RouteDeps, …>`. Plugins registered with their prefix in `app.ts`: assist, expose, fixtures, ha, item, jobs, room, scene, select, streams, watch, cameras (under `/api`, since `streams/crop` is there), and `pin` (under `/api/desk`). `scene.ts` is the one `/api/scene` plugin: it holds draft, classify, photo and texture (taken from `app.ts`, `fixture.ts` and `desk.ts`) and registers `photo.ts`, `scene-fit.ts` and `illustration.ts`. The two `onResponse` hooks that sync the watchers and the exposers moved to the root, since a hook added inside a plugin covers only that plugin. `tests/routes.test.ts` pins the full route list (method and path), taken before the change. `draftFixture`, `scanFixtures` and `sculptFixture` are top-level functions that take their deps and a parsed request. Not done: `deskRoutes` is not a plugin (it returns the tracking functions the watcher needs, and its handlers share one busy set with `scene/save` and `scene/from-photo/save`, so those two and `fixtures/anchor|untrack` and `item/save` stay in `desk.ts`); `cameras.ts` could not take `streams/crop` out; the three services are still 200–300 lines each, now callable without a route but not yet split into steps; the settings, text, discover, segment and lamp routes stay in `app.ts`.

_Landed (C10 remainder):_ `createDesk(store, turnOn)` (`desk.ts`) holds the busy set and the tracking steps and is made once in `buildApp`; it goes through `RouteDeps.desk` to the routes that change a desk, and to the watcher as `tracking`. `deskRoutes` is a plugin under `/api/desk`. `scene/save` and `scene/from-photo/save` are in `scene.ts`, `fixtures/anchor` and `untrack` in the fixtures plugin, `item/save` in `item.ts`. The settings, text, discover, segment (`createSegment` also serves the watcher) and lamp routes have their own files (`settings.ts`, `text.ts`, `discover.ts`, `segment.ts`, `lamp.ts`). `draftFixture` calls `fixtureSource`; `scanFixtures` calls `fitOutlines` and `saveScanned`; `sculptFixture` calls `sculptPicture` and `bestSculpt`. `app.ts` went from 649 to 540 lines and `desk.ts` from 1115 to 872; `fixture.ts` grew from 1967 to 2129 (anchor and untrack, and the named steps' signatures). `tests/routes.test.ts` is unchanged. _Landed (C10 last gaps):_ `scanFixtures`, `sculptFixture` and `scene/from-photo/save` are sequences of named steps (`scanTarget`, `scanList`, `scanOutline`, `scanMap`, `scanRun`; `sculptLookup`, `sculptCurrent`, `sculptDraft`, `sculptKeep`, `sculptSave`; `photoDraftOf`, `applyPhotoScene`, `photoFixtures`, `rememberPicked`), none over about 60 lines. `cameras.ts` is registered under `/api/cameras` and `streams/crop` is served by the streams plugin (`streamCrop`), so each plugin owns one prefix; `tests/routes.test.ts` is unchanged.

**C11. later, needs a decision: hot reads and retention.** `/api/status` (`store.ts:237`) and `/api/jobs` (`jobs.ts:208`) each parse about 11 MB per call. Index mode, kind and status as generated columns, and strip job pictures in SQL. A retention rule for old evidence deletes data, so agree on it first.

_Landed:_ migration 2 adds generated `mode`, `kind`, `status` columns and an index; `latestSegment`, `liveEvidence` and the cost estimates read those instead of parsing every run; `/api/jobs` drops pictures with `json_remove` (7 ms for 200 jobs either way: SQLite still parses the JSON, the gain is not building the pictures in JS). Retention: `EVIDENCE_RETENTION_DAYS` (default 30, 0 off) prunes runs, jobs and `evidence/<run>` at startup and daily, keeping any run named in desk memory, settings or a newer run (and what those name). `.data/rooms` is never touched. `tests/store-prune.test.ts`.

**C12. later, needs a decision: JPEG frames.** Every upload is stored and sent as PNG (`images.ts:33`). For a 1280 × 960 frame, PNG is 1.76 MB and 36 ms; JPEG at q92 is 228 KB and 8 ms. That is 7.7 times fewer bytes to Spark and SAM, but it changes the pixels SAM sees. Check with `bench:rooms`, `bench:brush` and one billed live comparison.

_Landed:_ stored uploads are lossless WebP (`source.webp`; `FRAME_FORMAT=png` reverts), old `source.png` still read. On a 1280 × 960 frame: PNG 1876 KB / 40 ms, lossless WebP effort 1 1316 KB / 373 ms (effort 0: 1564 KB / 120 ms), lossy q90 46 KB / 51 ms (not used: it changes pixels). Spark is sent WebP (documented as accepted); SAM and Muse Image are sent PNG converted at send time, since their docs don't name WebP. The zone key is still a SHA-256 of the stored bytes, so zones saved before keep their keys; a new upload of an image first uploaded as PNG gets a different key.

**C13. later: dead code.** `webResearcher` (`research.ts:116`) and `/api/fixtures/track` (`desk.ts:670`) are unused, and `convexHull` (`layers.ts:28`) duplicates `photo-scene.ts:273`.
_Landed:_ `webResearcher`, `/api/fixtures/track` and `layers.ts`'s hull are gone (the domain's `convexHull` gives the same outline). Done early, with the C items.

## D. The web (`apps/web`)

**D1. now: timers re-render only what shows them.** `useLabState` holds a 1 Hz `now` (`useLabState.ts:347-351`) that only `FixturePanel.tsx:1294` and `:1613` read. Replace it with a local `useNow()`, and move the fps readout (`Canvas.tsx:183`) into a leaf component. `unsaved` (`useLabState.ts:668`) reads a ref during render, so check that it still updates. Check with `bun run browser`.

_Landed:_ a01abff. `useNow()` now ticks in the four components that show time (no 1 Hz state in `useLabState`); the fps readout is a leaf; `unsaved` was left as it was (its edit counter is always paired with a state update). `bun run browser` 13/14: the one failure is the same on main.

**D2. later: fast state outside React's tree.** Move the follow view (10 Hz), its stats and the AI task's progress into small stores read with `useSyncExternalStore`, as `activity.ts` does. Send job progress over the existing event stream instead of polling every 350 ms.

_Landed:_ the follow view and its tally (`state/follow-store.ts`) and the AI task with its job (`state/ai-task-store.ts`) are `useSyncExternalStore` stores; only the follow overlay, the inspector's tally, the AI dialog and the Steps button read them. Job progress was still polled at that point (see the stream note below).

_Landed (D2 stream):_ `GET /api/jobs/:id/events` (`jobs.ts`) sends the job as server-sent events: its state on connect, again after every change a `JobTracker` makes (`listen`/`Jobs.watch`), then ends with the job (an ended or unknown job answers once, or 404). A ping every 20 s keeps it open and the listener is removed when the reader leaves. The web follows with `followJob` (`state/follow-job.ts`, `EventSource`), and polls every 350 ms only if the stream errors before the job ends. `tests/jobs.test.ts` reads it over a real listen on port 0; `tests/routes.test.ts` pins the route. The fixture refine loop (2 s poll inside its own request) is left as it was.

**D3. later: split `useLabState`.** It has 34 `useState`s, 15 `useEffect`s and about 218 fields, and its type is inferred. Split it into slices, each with its own interface:

- preferences and view
- desk memory, undo and saves
- camera and streams
- follow, watch and expose
- fixtures
- calibration and pin
- AI tasks
- the run log

Keep `useLab()` as a facade, and move consumers over one pane at a time. Then `IsoView` reads its slice instead of taking 46 props, and `IsoScene` is memoized.

_Landed:_ `useLabState` is now fourteen slice hooks in `apps/web/src/workspace/state/` (view, feedback, run log, desk, follow state, camera, observation, tracking, navigation, AI, fixtures, calibration, probes, saves), each with an explicit interface and reading only the slices before it. `LabProvider` runs them once and gives each its own context; `useLab()` still merges all of them. Slices return through `useStableSlice`, so a slice keeps its identity until a value in it changes. Every pane but `Canvas` now names the slices it reads with `useLabParts`. Still on the facade: `Canvas`, which reads nearly every slice. Warnings from `bun run lint` in the web app: 21 to 9. `IsoView`'s 46 props and the memoised `IsoScene` are not done.

_Landed (D3 remainder):_ `IsoView` takes two props (`hand`, and `onFixtureMenu`, whose menu the canvas owns) and reads the rest from ten slices with `useLabParts`; its objects, zones, fixtures, placing and handlers are memoised, and `IsoScene` is wrapped in `memo`. `Canvas` still reads 13 of the 14 slices (only `saves` went): it uses fields from nearly all of them, so narrowing further means splitting the canvas into panes, which is not done.

_Landed (D3, Canvas panes):_ `Canvas` now only lays out: it reads the view and camera slices (the stage mode, the hand tool, the calibrate slot) and holds the fixture menu's state. The rest is in `CanvasPanes.tsx`, one component per region, each naming its slices with `useLabParts`: `SceneToolbar`, `StageTools`, `PhotoStage` (with `Media` and the trail, mask, zone, draw, brush, focus, follow and calibration layers), `FixtureMenu`, `SceneBottom`, `PhotoInput` and `IssueCard`; `BrushDock` is in `Canvas.tsx`. Markup, class names and DOM order are unchanged. Every pane now reads slices; the facade has no reader left in the workspace.

**D4. later: sprites in a Worker.** An item sprite takes 31–71 ms on the main thread, and every item-editor edit misses the cache. Draw sprites in a Web Worker with OffscreenCanvas and serve object URLs. Give the cache least-recently-used eviction instead of oldest-first (`iso/sprites.ts:47`), and bound `viewOverlay`. A `useSprite` hook keeps the last image until the new one is ready, and `useDeferredValue` smooths the editor's draft. Measure again after B first.
_Landed:_ `iso/sprite.worker.ts` draws sprites (`sprite-draw.ts`, shared with the main-thread fallback) and returns PNG blobs via `OffscreenCanvas`; `sprites.ts` serves object URLs from an LRU cache bounded by 400 entries and 48 MB (also for `viewOverlay`), revoking evicted URLs after 30 s. `useItemSprite`, `usePropSprite` and `useViewOverlay` keep the last image until the next is ready; `IsoScene`, `IsoItem`, `ItemEditor`, `PropPicker` and `Brush` use them, and the editor draws from `useDeferredValue(draft)`. No Worker or OffscreenCanvas (and bun tests) draws on the main thread. Still synchronous: `itemSprite`, `propSprite` and `viewOverlay`, which `FixturePanel` calls (sizing needs pixels in the same tick); move it to the hooks when that file is free.

_Landed (D4 FixturePanel):_ `ModelPreview` and a new `StarterCard` use `useItemSprite`; the synchronous `itemSprite`, `propSprite` and `viewOverlay` are gone, nothing else called them.

**D5. later: lazy chunks.** Lazy-load the Playground (`main.tsx:8`), `ItemEditor`, `SceneEditor`, `IllustrationView`, `RoomCalibrate`, `PhonePairing`, `CameraSetup` and `AIRichPreviewDialog`. Add `sideEffects: false` to domain's `package.json`.
_Done when:_ the first chunk is under 400 KB.

_Landed (D5):_ the Playground, `ItemEditor`, `SceneEditor`, `IllustrationView`, `RoomCalibrate`, `PhonePairing`, `CameraSetup` and `AIRichPreviewDialog` are `React.lazy` behind `Later` (a quiet 'Loading…' line); `LayerButtons` moved out of `SceneEditor.tsx` so `FixturePanel` does not pull the editor in; React has its own chunk (`vite.config.ts`). `bunx vite build` into a scratch directory: the main chunk was 837.17 KB raw / 265.58 KB gzip and is 296.51 KB / 95.07 KB, with React 218.78 KB / 68.26 KB and the domain package 216.98 KB / 71.85 KB beside it (the first load is about 732 KB raw, from 837). _Not done:_ `sideEffects: false` in `packages/domain/package.json` (off limits to this pass; it would let the bundler drop unused domain exports from that 217 KB chunk). `KeysDialog` is small and stays. `FixturePanel`, `ExposePanel` and `DevicesPanel` could be lazy too, but `Inspector` and `Outline` import `ScanFixtures`, `ChooseDevicesLink`, `removeFromLayout` and `stateLabel` from them as values.

_Landed (D5 sideEffects):_ `"sideEffects": false` in `packages/domain/package.json`. No domain module runs anything at import: top-level statements are declarations, plus a few `Set`s and memo `Map`s (`demo-room.ts` frames, `iso-prop-sprite.ts` recent grids) that fill when called. `bunx vite build` before/after: the 223 KB domain chunk is gone, its used parts now split as `iso` 128 KB, `fixture` 40 KB and `iso-presets` 2 KB, with the main chunk at 297.5 to 328.7 KB (95.6 to 107.2 KB gzip) as the rest merged in; the first load (main, React and those) was 739 KB raw and is 717 KB (-3%). The sprite worker, which bundles the same domain, went from 167.6 KB to 134.6 KB (-20%).

_Landed (D5 panels):_ `FixturePanel`, `ExposePanel` and `DevicesPanel` are `React.lazy` behind `Later` in `Inspector.tsx` (the fixture, new-fixture, lamp and built-in panes, the entity and new-entity panes, and Home Assistant). The values `Inspector` and `Outline` took from them moved to modules of their own: `ScanFixtures.tsx` (with `fixture-scenes.ts`, the `WorkScene` type and `useScenes` it shares with `NewFixturePanel`), `ChooseDevicesLink.tsx`, `removeFromLayout.ts` and `stateLabel.ts`. None of the three imports a stylesheet, so the cascade is unchanged. `bunx vite build` into a scratch directory: the main chunk was 334.72 KB raw / 109.46 KB gzip and is 258.21 KB / 85.23 KB (-23% raw, -22% gzip); the panels are chunks of 31.06 KB / 10.21 KB (fixture), 15.50 KB / 5.27 KB (expose) and 10.25 KB / 3.90 KB (devices).

**D6. later: a typed API.**

- A route table in domain, sharing the server's request schemas.
- A `method` option and a blob variant for `api()`, replacing four raw `fetch`es (`useLabState.ts:1022`, `:2206`, `:2694`; `PhonePairing.tsx:42`).
- A `RunOutputs` map typed by kind, which removes 56 `as X` casts, 23 of them in `useLabState`.

_Landed (server half):_ the routes' 63 inline `z.object` schemas are in `packages/domain/src/requests.ts`, hoisted to module level, named after their route (`fixturesDraftBodySchema`, `jobsQuerySchema`; the ones several routes share are `modeOnlySchema`, `idOnlySchema`, `modeIdSchema`, `modeImageSchema`, `cameraIdOnlySchema`). Each has a `z.input` type beside it (`FixturesDraftBody`, `ModeOnly`…) for the web to send. `NetworkStream` moved to domain's `camera.ts`; both `streams.ts` files re-export it. Not done: a route table, the web's `api()` change and `RunOutputs`, and response types (the server returns inferred shapes, not named ones, except `EvidenceRun`/`Segmentation` and friends already in domain).

_Landed (D6 web half):_ `ApiRoutes` (`packages/domain/src/routes.ts`) maps the 48 routes the web calls to a request body (the `requests.ts` input types) and a response (named domain types where there are some, else the shape lifted from the call site, such as `HaEntity` and `PairingView`). `api(path, body?, { signal, method })` is typed by it; `apiAt<T>` serves the few paths built at run time (the probe kinds, `desk/${path}`, the panels' generic `done`); `apiBlob` serves files (the camera snapshot, the room photo). 57 inline response generics are gone. The job stop, phone unpair, camera snapshot and room photo fetches go through it, so they get its error handling; the stop retry loop still reads the finished job's 200 body. Raw fetches left on purpose: `DevReload` (a dev endpoint, not `/api`) and `streams.ts` (WHEP to a camera's own URL). The schemas check a scene or desk as the stored `custom` one while the page holds the wider `IsoScene`/`DeskMemory`, so `desk/restore`, `scene/fit` and `scene/from-photo/save` widen that field (`Wide`); the server would still refuse a preset scene there. `RunOutputs` (`run-outputs.ts`) maps a run kind to its output (the fixture kind is a union told apart by `in`), with `isRun` and `runOutput`: the web's `output as X` casts went from 28 to 1 (a failed run's error). _Landed (D6 server half):_ the server files and scripts read a run's output through `runOutput`, `fixtureOutput` (draft, scan, sculpt, fuse, refine) and `runFailure` (a failed run's error); `RunOutputs` gained `illustration`, and the sculpt, fuse and refine shapes now match what the server stores. 31 of the 33 casts are gone. _Last casts:_ `run()` is generic over the kind (`RunKindOutput<K>`, read from `RunOutputs`), the status checks in `runs.ts` narrow with `isRun`, and `runFailure` checks for an `error` field; the only `as` left is `RunFailure['error']` there. No `.output as` is left in `apps/` or `scripts/` (one in `tests/watch.test.ts`). Not done: response types for the routes the web does not call.

**D7. later: CSS.**

- Add type, z-index and radius scales to `tokens.css`; today `12px` appears 67 times.
- Merge duplicate keyframes: `rise-in` and `aip-rise`, `breathe` and `aip-pulse`.
- Move `styles.css`'s sections next to their components.
- Drop these unused classes:
  - `.rules-*`
  - `.iso-surface-pick`
  - `.section-label`
  - `.table-head`
  - `.model-tag`
  - `.object-number`
  - `.object-category`
  - `.row-arrow`
  - `.playground-link`
  - `.divider`

_Landed:_ `tokens.css` has `--fs-11`/`--fs-12`/`--fs-13` and the 2px radius uses `--r-chip`; the ten dead rule groups and the two duplicate keyframe pairs are gone (`breathe` and `rise-in` kept). The z-index and `styles.css` section moves are not done.

_Landed (D7 remainder):_ `tokens.css` has a `--z-*` scale (the same numbers, named by what they stack: `--z-tag`, `--z-topbar`, `--z-popover`, `--z-sheet`, `--z-menu`, `--z-dev`…) and no raw `z-index` is left. `styles.css` went from 1804 to 1119 lines: type and glass surfaces (`ui/surfaces.css`, imported after the controls in `main.tsx`), the top bar (`workspace/top-bar.css`), the run log (`workspace/evidence-log.css`), the inspector (`workspace/inspector.css`), provider calls (`provider-ui.css`) and zoom-pan (`zoom-pan.css`) now sit beside their components. The built sheet has the same 942 rules; the order of every pair that moved relative to each other was checked for shared selectors and properties, and the one same-specificity pair that would have flipped (`.topbar-links` gap, whose media rule in `workspace.css` was losing to the base) is kept by `TopBar.tsx` importing `workspace.css` before `top-bar.css`. Left in `styles.css`: the shell, scene frame, detections, discovered objects, checklist, preferences, session, spending limit and the phone layout, which share selectors across sections.

## E. Domain structure (later)

**E1. `index.ts` down to re-exports.** It holds about 950 lines of its own: wire types, pricing, desk memory, rules and `upgradeMemory`. Move them into `api.ts`, `cost.ts`, `memory.ts` and `rules.ts`. That breaks the package's only runtime import cycle (`expose.ts` ↔ `index.ts`).

_Landed:_ `index.ts` is re-exports. Code went to `api.ts` (wire types, limits, `DEMO_ID`), `cost.ts` (prices), `memory.ts` (zones, calibration, `DeskMemory`, `upgradeMemory`) and `rules.ts` (placement rules and gates). `expose.ts` imports from `rules.ts`, so the cycle is gone. The `iso.ts` nested re-exports moved to `index.ts`.

**E2. One `math.ts`.** It takes the duplicated helpers:

- `Vec3`, defined 4 times
- `clamp`, 4 times
- `quantile`, 3 times
- Bézier, twice
- point-in-polygon, twice

Use one key light for `iso-voxel.ts:697` and `room-render.ts:35`, which must agree.

_Landed:_ `math.ts` (not re-exported from the index) holds `Vec3` and its ops, `clamp`, `quantile`/`median`, `bezier`, `pointInPolygon` and `KEY_LIGHT`. Left alone because they differ in behaviour: `item-sculpt.ts` `clamp` (maps NaN to the low bound) and `splat.ts` `quantile` (index by `q·(n−1)`, 0 when empty).

**E3. Bench cases out of `room-scan.ts`.** Lines 823–1126 move into `room-cases.ts`.

_Landed:_ `room-cases.ts`, re-exported from the index.

**E4. Types tied to their schemas.** Add `satisfies z.ZodType<T>` where a hand-written type sits beside a schema: `IsoProp`, `IsoScene`, `RoomCamera` and `PlacementRule`. Give desk memory a schema, and run `upgradeMemory` as its preprocess step; `store.ts:96` casts parsed JSON today.

_Landed:_ `satisfies z.ZodType<…>` on `isoPropSchema`, `isoSceneSchema`, `roomCameraSchema`; `ruleInputSchema` is checked against the fields `PlacementRule` shares with it (it takes `rect`, the rule stores `zone`). `deskMemorySchema` (in `memory.ts`) runs `upgradeMemory` as its preprocess step and checks the top level; nested parts are only checked for kind, since they have no schemas yet. _Store half landed:_ `store.ts` `memory()` parses with `deskMemorySchema`. Memory that no longer fits is logged once per mode and kept as saved (upgraded if the upgrade can run), so nothing is lost; `tests/store-migrate.test.ts` has an old-format case and a failing one.

**E5. `ItemPart` as a union by `shape`.** Convert the legacy shapes when parsing. This risks saved items and goldens, so check both.

_Landed:_ the type half. `ItemPart` and `PropPart` are unions by `shape`, each variant with only the fields it draws (`lathe`: `profile`, `wall`, `inside`; `tube`: `path`, `radius`; `extrude`: `outline`, `radius`; `rbox`: `radius`; `blob`: `rough`; `cylinder`: `wall`, `inside`), and the legacy shapes are members of their own, so nothing is converted and nothing draws differently. `partPrims` narrows instead of `p.outline ?? []` and `p.path ?? []`. `itemPartSchema` is that union behind a preprocess that drops fields a shape does not use, so saved items parse as before (a fuller superset: a blob with a stray `profile` used to fail). The editor keeps a loose `ItemPartDraft`/`IsoItemDraft` and draws it through `previewItem`, which fills in what a half-edited part lacks. Goldens pass without `UPDATE_GOLDEN`; `bench:fit` unchanged. _Not done:_ converting the legacy shapes at parse time, which would still change their drawing.

**E6. Tidying.** Tests import `@livinglayer/domain`; 11 of them reach into `../packages/domain/src` today. Un-export the 7 unused names and the 85 used only in their own file, so `noUnusedLocals` catches dead code.

_Landed:_ the 10 tests that reached into `../packages/domain/src` now import `@livinglayer/domain`. 90 exports used nowhere else were un-exported, which includes the 7 unused ones; `noUnusedLocals` then found 7 dead declarations, which were deleted. Names the other sessions start using from the package (e.g. `SpriteOptions`, `ItemView`) need exporting again.

## Order

Before the submission, four sessions can run at once, each landing its own commits:

1. **A1–A4, A6, A8**: `scripts/`, `tests/`, `apps/web/src/api.ts`, docs.
2. **B1–B6**: `iso-voxel.ts`, `item-fit.ts`, `room-render.ts`, `room-scan.ts`, `place-fit.ts`, `iso-prop-sprite.ts`, `color.ts`.
3. **C1–C6**: `apps/server/src`.
4. **D1**: `useLabState.ts`, `FixturePanel.tsx`, `Canvas.tsx`.

After the submission:

- C7 follows B.
- D2, D3 and D4 go in that order.
- C8–C10 go with D6 and E1, since they share the request schemas.
- C11 and C12 wait for a decision.
