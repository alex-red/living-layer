# Faster iteration for agents

What slowed down building and checking the AI brush (plan in [ai-brush.md](ai-brush.md)), and the tooling that would have caught each problem sooner. The items are grouped by theme and ordered by what they unblock. Each one names the files it touches and what "done" means.

## What went wrong, and what it cost

| #   | Stumbling block                                                                                                                                                                                                                                                                                   | Found by                                    | Cost                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| 1   | **Shared checkout.** Another session committed my staged files into its own commit (88d2033). Later, another session's half-done renaming (24 files, uncommitted) got into my build, and the browser suite failed against a tree that was neither mine nor `main`.                                | A mixed commit; tests failing for no reason | A mixed history; one rerun; a worktree built by hand |
| 2   | **The browser suite isn't in `verify`.** Six tests had gone stale after earlier UI changes, and nobody noticed. It needs a build and its own server, and its data carried over from one run to the next.                                                                                          | Running it by hand at the very end          | A side session                                       |
| 3   | **Browser failures are hard to read.** I unzipped `trace.zip` and wrote Python to list actions, console and network, and added `console.log` and rebuilt twice to learn that a modal dialog made the panel inert.                                                                                 | Hand debugging                              | About 8 round trips                                  |
| 4   | **Demo and live disagreed on what was selected.** The panel resolved the selection through the room. The request resolved SAM's outline, or in the demo the fixed demo frame. The tests drew boxes with `around('desk')`, which agreed by construction, so they hid it.                           | Driving the app by hand, then a live run    | Two bugs found late                                  |
| 5   | **No way to send one brush request from the shell.** I drove the UI with screenshot coordinates (slow; synthetic pointer events didn't work), then wrote `fetch` calls in the page, then an ad-hoc `out/live-brush.ts` (snapshot, box from the room's drawing, post, print) and `out/overlay.ts`. | —                                           | Rebuilt three times                                  |
| 6   | **Model-call limits were guessed.** The refinement hit the 30 s timeout on every live call, then its 8,192-token limit. Neither shows up until a live run. The ledger has the usage, but nothing compares it with each call's limits.                                                             | Three live runs                             | About $0.06 and three cycles                         |
| 7   | **Intent bench cases can be wrong.** "Metal legs" asked about legs on a model that has none, and the bench didn't print the product it judged, so a miss was opaque. One live run can't tell Spark's inconsistency from a real miss.                                                              | Live runs                                   | Three live runs ($0.40)                              |
| 8   | **The dev server's demo data drifts.** My checks left a custom scene in the running server's demo memory (`ikea-alex-desk-2`, then a lost pin), and every later check started from that.                                                                                                          | Confusing state                             | Reasoning about stale state                          |
| 9   | **Silent drops.** A follow-up stopped by an old timer, and a refinement failure that sank the whole request, both showed nothing to the person or the log.                                                                                                                                        | Debugging                                   | Two bugs                                             |
| 10  | **Small things.** `bun run typecheck` prints nothing when it passes, so I couldn't tell clean from cut off. I formatted with Prettier out of habit after the move to oxfmt.                                                                                                                       | —                                           | Minor, but repeated                                  |

## Principles

- **Check a snapshot, not the shared checkout.** Anything that judges a change (verify, the browser suite, a bench baseline) should be able to run in a throwaway worktree at a commit, as `bench:at` already does.
- **In-process before servers.** Scripts build the app with `buildApp` and a temporary `DATA_DIR`, and call it with `app.inject`, as the tests do. That needs no running server, so the rule against starting one stays intact, and nothing touches the dev server's data. Live runs go to the running server only when they need its camera.
- **One harness, many front ends.** The brush CLI, the brush bench and the tests share one module that turns a selection into a request and a result. The same goes for browser helpers between specs and probes.
- **Make limits visible.** Every model call reports its use against its limits, and the bench says when a limit is close.

## Workstreams

### A. Clean snapshots (blocks 1, 2)

_Status: A1–A3 done (`scripts/lib/worktree.ts`, `verify --at`, `bun run commit` and `.githooks/pre-commit`)._

**A1. A shared worktree helper.** Move the worktree setup out of `scripts/bench-at.ts` into `scripts/lib/worktree.ts`: `withWorktree(ref, fn, { install, build })`. `ref` may be a commit or `--staged`, which is HEAD plus the staged diff applied, so a commit-to-be can be checked before committing. It always cleans up. `bench-at.ts` then uses it.
_Done when:_ `bench:at` behaves as before and the helper has a unit test for the `--staged` patch.

**A2. `bun run verify --at <ref|staged>`.** Runs the whole verify in a clean worktree from A1. The usual run stays in place and fast.
_Done when:_ `verify --at staged` passes on a clean commit and fails on a staged type error, whatever other sessions have left unstaged in the checkout.

**A3. A commit helper, `bun run commit -m … -- <paths>`, and a hook.** The helper stages exactly those paths, refuses if anything else is already staged (another session's work), runs `verify --at staged` and commits in one step. It refuses `-A` and `.`. The pre-commit hook in `.githooks/` refuses a commit whose staged files differ from the list the helper recorded, so a plain `git commit` can't sweep in another session's staged files.
_Done when:_ the mixed-commit case from 88d2033 can't happen through it. AGENTS.md's ground rules point to it.

### B. The browser suite as a normal check (blocks 2, 3, 9)

**B1. `bun run browser [--at <ref>] [-g <pattern>]`.** Builds and runs Playwright in a worktree (A1). Its own build means a half-edited checkout can't leak in, and its data folder starts empty (now in the config). Prints the run's summary like verify does.
_Done when:_ it gives 11/11 on `main`, run from a checkout with unrelated edits.

**B2. `bun run trace [<test>]`, a failure summary.** For a failed test, from its `trace.zip` and `error-context.md`: the failing step and locator, the actions before it with their timing, `/api` requests with status and body size, console errors, open dialogs, and the page snapshot cut down to the region the locator points into. It goes in `scripts/lib/trace.ts` so B1 can print it under each failure.
_Done when:_ today's brush failure ("no second `/api/assist`, a modal `dialog` open while the panel was filled") reads off one screen.

**B3. Spec helpers for AI tasks.** `waitForAiTask(page, title)` waits for the steps dialog to finish and close, and `aiTaskFailed` reads its error. They go in `tests/browser/helpers.ts`, taken out of `lab.spec.ts`, so new specs don't type into an inert panel.
_Done when:_ the brush spec and the photo-draft spec use them.

**B4. The browser suite in `verify --browser`,** as a reported step (`!`, not failing). Plain verify prints a warning when `tests/browser` or `apps/web` changed since the suite last passed.

**B5. Say it when a result is dropped.** In development, `followAi` logs a `console.warn` when it drops a result because a newer task started or this one was stopped. `send` and `save` in `useBrush` tell the person when nothing came back. The timer pattern behind block 9 now goes through `closeAiTaskSoon` (done).

### C. Brush tooling (blocks 4, 5, 8)

**C1. A brush harness, `scripts/lib/brush.ts`.** `runBrush({ mode, select, prompt, follow?, save? })`. `select` is `{ box }`, `{ polygon }` or `{ around: '<group>' }`; `around` boxes a group's drawing through the room's camera, with padding. Demo mode runs in process (`buildApp`, temporary `DATA_DIR`, `app.inject`). Live mode posts to the running server with a camera snapshot. It returns the resolve answer, the run, its job's steps, and pictures: the frame with the selection, the outline, and the model drawn in place through the camera.
_Done when:_ `tests/assist.test.ts` uses its selection helpers instead of its own `around`.

**C2. `bun run brush`, the CLI.** For example `bun run brush --around desk "make it its own furniture" --then "make the drawers green" --save`, or `--live --box 105,385,655,995 "…"`. It prints the panel's target beside the request's target and flags any mismatch, the steps, the model, the check and the cost. It writes `out/brush/<run>/overlay.png`. This replaces `out/live-brush.ts`, `out/overlay.ts` and driving the UI by pixels.

**C3. Target agreement as an invariant.** One unit test per mode: for every group in the demo room and a box around it, `select/resolve` and `/api/assist` name the same target. A second set uses boxes that only partly cover a thing, which is how the keyboard case got through.

**C4. A brush bench on captured rooms, `bun run bench:brush`.** On each captured real room (`.data/rooms`, local): stored frames, stored SAM answers, boxes from its `truth.json` things. Per case it reports target agreement, whether SAM's outline was kept or fell back, IoU and the size gap, offline. `--live` captures new SAM answers, billed. The targets go in `BRUSH_TARGETS`, shared with the tests like the room bench's.

**C5. Resettable demo data.** `bun run reset demo` (or `POST /api/desk/demo/reset`, demo mode only) puts the dev server's demo memory back to the preset. Probes that need the dev server call it first; C1 never needs it.

### D. Model-call limits and the intent bench (blocks 6, 7)

**D1. Use per call kind.** `bun run runs --calls [--days 7]`: for each Spark and SAM call kind, the count, p50 and max latency, p50 and max output tokens, failures by cause, and the share of its timeout and token limit used. A kind that has used more than 80% of either is flagged. It reads the ledger the server already writes. This needs each call's kind and latency stored if they aren't already.
_Done when:_ the refinement's timeout and token overruns from this session show up flagged.

**D2. One table for each call's limits.** Put each call's token limit and timeout in one table in `meta.ts` (`SPARK_CALLS.refine = { tokens, timeoutMs }`), instead of `SPARK_BUDGET` plus separate `*_TIMEOUT_MS` constants and literals. D1 then compares against that table.

**D3. A stricter intent bench.**

- Check each case against its context offline: a part selector has to match a part of the context's recipe (this catches "legs").
- Print every field it judges: ops, product, needs.
- `--repeat N` runs live cases N times and reports a case as steady or flaky.
- `--only <name>` for one case.
- Cache live answers (by prompt hash) so a rerun after a change to `readIntent` costs nothing.

### E. Small ergonomics (block 10)

- `bun run typecheck` prints `types clean` and the time on success.
- AGENTS.md says to format with `bun run format` or `bunx oxfmt <files>`, and never Prettier.
- AGENTS.md's "Look before and after" table gets rows for `bun run brush`, `bun run browser`, `bun run trace`, `bench:brush` and `runs --calls`.
- AGENTS.md says to brief side sessions to work in a worktree and to verify merges with `verify --at`.

## Order

1. **A1 → A2 → A3**: everything else trusts its own checks only once they run on a snapshot.
2. **B1, B2, B3**: the suite becomes cheap to run and to read. **B5** is small and can come any time.
3. **C1 → C2 → C3**, then **C4** (it needs C1 and captured rooms). **C5** whenever the dev server is used.
4. **D2 → D1**, and **D3** alongside.
5. **E** as each piece lands.

A, B and D touch different files, so they can run as parallel sessions in their own worktrees. C builds on A1 for its live checks.

## Decisions (2026-11-01)

1. **Scope:** A–C first; D and E after.
2. **Browser suite in `verify`:** opt-in with `--browser` and reported, not failing. Plain verify warns when `apps/web` or `tests/browser` changed since the suite last passed.
3. **Commits:** the helper (`bun run commit`) plus a pre-commit hook that refuses when staged files include ones the committer didn't name.
4. **Live captures:** the brush bench may save frames and SAM answers from the office camera into `.data/rooms` (local, ignored), at about $0.01 per case.
