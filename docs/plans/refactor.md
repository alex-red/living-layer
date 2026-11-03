# Refactor and speed-up · November 2, 2026

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

**A5. later: one test harness.** About 20 files repeat `mkdtemp`, `parseConfig`, `buildApp`, `post` and the cleanup. `tests/lib/app.ts` exports `testApp({ env, fetcher })` and cleans up after itself.

**A6. now: oxlint.** There is no linter, and 86 `useEffect`s have no hooks rules (`useLabState.ts:602` spreads its dependencies). Add oxlint with the react-hooks rules as a reported step in verify, and make it fail the run once it is clean.
_Landed:_ oxlint 1.90.0 (`bun run lint`, `.oxlintrc.json`: `rules-of-hooks` as error, `exhaustive-deps` as warning, nothing else). Today it reports 0 errors and 21 warnings, 10 of them in `useLabState.ts`. It does not fail verify yet; make it gate when the count reaches 0.

**A7. later: catch dead exports.** Add a verify step (knip, or a small script) that lists exports nothing imports. It would catch 7 in domain, 8 in web and about 30 in server today.
_Landed:_ `bun run dead-exports` (`scripts/dead-exports.ts`), a report step in verify. It reads imports with a regex, since the TypeScript 7 beta has no JS API, and follows `export *` through the domain index. Today it finds 216 unused exports: 32 in server, 27 in web, 157 in domain, in 60 files, in 0.03 s. The counts above are from before the merges; `IGNORE` in the script is empty.

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

_Landed:_ the lens falloff is a table kept per frame size (built with the same `Math.hypot`), pixels are written directly, and `drawnInset` borrows the depth and id buffers (`renderRoom`'s `scratch` option). Six presets' `renderRoom` 303–322 → 192 ms; pictures and layouts identical. `fitGroup` (`place-fit.ts`) is not in this tree, so it is untouched.

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

**C10. later: routes as plugins.** Register one Fastify plugin per resource, with its prefix. That moves the fixture routes out of `desk.ts` and puts the scene routes, now spread over three files, into one. The 240–310-line handlers (`fixture.ts:429`, `:668`, `:982`) become services, and `run()` moves into `runs.ts`.

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

**D4. later: sprites in a Worker.** An item sprite takes 31–71 ms on the main thread, and every item-editor edit misses the cache. Draw sprites in a Web Worker with OffscreenCanvas and serve object URLs. Give the cache least-recently-used eviction instead of oldest-first (`iso/sprites.ts:47`), and bound `viewOverlay`. A `useSprite` hook keeps the last image until the new one is ready, and `useDeferredValue` smooths the editor's draft. Measure again after B first.
_Landed:_ `iso/sprite.worker.ts` draws sprites (`sprite-draw.ts`, shared with the main-thread fallback) and returns PNG blobs via `OffscreenCanvas`; `sprites.ts` serves object URLs from an LRU cache bounded by 400 entries and 48 MB (also for `viewOverlay`), revoking evicted URLs after 30 s. `useItemSprite`, `usePropSprite` and `useViewOverlay` keep the last image until the next is ready; `IsoScene`, `IsoItem`, `ItemEditor`, `PropPicker` and `Brush` use them, and the editor draws from `useDeferredValue(draft)`. No Worker or OffscreenCanvas (and bun tests) draws on the main thread. Still synchronous: `itemSprite`, `propSprite` and `viewOverlay`, which `FixturePanel` calls (sizing needs pixels in the same tick); move it to the hooks when that file is free.

**D5. later: lazy chunks.** Lazy-load the Playground (`main.tsx:8`), `ItemEditor`, `SceneEditor`, `IllustrationView`, `RoomCalibrate`, `PhonePairing`, `CameraSetup` and `AIRichPreviewDialog`. Add `sideEffects: false` to domain's `package.json`.
_Done when:_ the first chunk is under 400 KB.

**D6. later: a typed API.**

- A route table in domain, sharing the server's request schemas.
- A `method` option and a blob variant for `api()`, replacing four raw `fetch`es (`useLabState.ts:1022`, `:2206`, `:2694`; `PhonePairing.tsx:42`).
- A `RunOutputs` map typed by kind, which removes 56 `as X` casts, 23 of them in `useLabState`.

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

_Landed:_ `satisfies z.ZodType<…>` on `isoPropSchema`, `isoSceneSchema`, `roomCameraSchema`; `ruleInputSchema` is checked against the fields `PlacementRule` shares with it (it takes `rect`, the rule stores `zone`). `deskMemorySchema` (in `memory.ts`) runs `upgradeMemory` as its preprocess step and checks the top level; nested parts are only checked for kind, since they have no schemas yet. _Follow-up:_ `store.ts` `memory()` should parse with `deskMemorySchema` instead of casting; it is not wired in.

**E5. `ItemPart` as a union by `shape`.** Convert the legacy shapes when parsing. This risks saved items and goldens, so check both.

_Skipped:_ the legacy shapes (`cylinder`, `box`, `cone`, `handle`, `lid`) are still written by `iso-item.ts` itself and drawn by their own branches in `iso-voxel.ts` and `item-sculpt.ts`. Converting them at parse time would change those drawings, so goldens would not stay as they are.

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
