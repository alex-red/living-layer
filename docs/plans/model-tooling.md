# Faster iteration on Things' models

What slowed down reworking how a Thing is modelled and drawn (prints, the `clean` finish, seating handles; aimed at a reference pixel-art mug), and the tooling that would have made each step a single command. Same shape as [agent-tooling.md](agent-tooling.md): blocks, principles, workstreams with files and "done", order, decisions.

## What went wrong, and what it cost

| #   | Stumbling block                                                                                                                                                                                                                                                       | Found by                         | Cost                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| 1   | **No way to look at one model.** `bun run sheet` draws templates, not a fixture's or item's model. I wrote five throwaway scripts (`mug-look`, `mug-zoom`, `mug-big`, `saved`, `final`) to render a model from memory, a JSON or a sculpt, at a size, beside a picture. | —                                | Rewritten five times                         |
| 2   | **Loading a stored model failed.** A fixture's `SavedItem` carries `source`, `fit`, `swatches`…, so `isoItemSchema.parse` refused it; every script hand-stripped fields. Reading desk memory meant raw SQL.                                                            | A ZodError                       | Repeated boilerplate                         |
| 3   | **Render size was guessed.** The first look rendered at one iso pixel per pixel (345 px wide), nothing like the app or the reference; the legibility of lettering hinges on pixel size, and nothing names the sizes the app draws at.                                  | Comparing by eye                 | Two misleading rounds                        |
| 4   | **Only eyes judged "closer to the reference".** No number for tone, outline or silhouette against the target, so each tweak was one screenshot and a guess.                                                                                                          | Reading PNGs                     | About ten render–look cycles                 |
| 5   | **Spark's answers are thrown away.** A sculpt run keeps only the winning model: not the three raw answers, not their notes. Testing a reader change (`seatHandles`) on Spark's real answer meant another billed run.                                                   | Re-running live                  | Three live runs (about $0.26) and two cycles |
| 6   | **No offline replay of a sculpt.** `assist <run>` replays a brush request; nothing replays a sculpt through the current `fromSculpt`, inks and seating.                                                                                                                | —                                | The same three live runs                     |
| 7   | **The picture Spark saw was buried.** It took digging in `.data/evidence/<run>/` to find that Spark had a broken 99×82 cut-out, the real cause of a poor model. `bun run runs` doesn't show a sculpt's picture or drafts.                                             | Reading the evidence folder      | The diagnosis came last, not first           |
| 8   | **Couldn't tell which prompt the server sent.** `promptVersion` is a fixed `fixture-v1`, so after editing the prompt I couldn't tell whether the dev server had reloaded it before a billed call.                                                                     | Guessing                         | A paid run on faith                          |
| 9   | **A new Spark field broke four builders.** Adding `prints` to the sculpt part made `promote.ts`, `recipe-sculpt.ts` and two tests fail to type, since each spells out every field.                                                                                    | Typecheck                        | Four hand edits                              |
| 10  | **The surface's `u` convention was a trap.** `u` grows to the viewer's left, so the first print came out mirrored, and only a 600 px render showed it.                                                                                                              | A mirrored logo                  | Two cycles                                   |
| 11  | **Fixing a saved model had no path.** Applying a domain fix to the saved mug meant a hand-written script reading SQLite and posting to `/api/item/save`.                                                                                                            | —                                | A one-off script                             |
| 12  | **Typesetting depends on the machine's fonts.** `print-ink.ts` asks for Brush Script MT and falls back to `cursive`, so a print sets differently elsewhere, and tests on it are only as stable as the fonts installed.                                              | Reading my own code              | A latent flake                               |
| 13  | **Unrelated failures looked like mine.** verify's format step failed on the untracked `.claude/settings.local.json`; the rooms bench's `office-c` miss needed `bench:at HEAD` to show it was already there.                                                          | verify                           | Two detours                                  |
| 14  | **The clean finish has no golden.** Goldens cover the `pixel` finish only; a later change to `cleanStep` or per-pixel decals would pass every test.                                                                                                                  | Reading the tests                | A gap, not yet a bug                         |

## Principles

- **One model loader, many front ends.** Every script and test reads a model through one module that knows every source: a fixture or object in live or demo memory, a save, an evidence run, a starter, a JSON file. Nothing parses desk memory by hand again.
- **Render as the app renders.** Sizes come from named presets shared with the web (`room`, `panel`, `editor`), so a script's picture is the app's picture.
- **Keep what a model call answered.** Raw answers are evidence; anything derived from them can be replayed offline with the current tree, as `assist <run>` does for the brush.
- **A number beside every picture.** A look against a reference reports its scores, so an iteration is "did the number move", and the picture is for checking the number.
- **Add a field in one place.** A Spark-shaped part is built by one factory, so a new field is one edit plus its use.
- **Write through the app.** A change to a saved model goes through the server's own routes, or `buildApp` in process on a copy, never SQL.

## Workstreams

### A. See a model in one command (blocks 1–4, 10)

- **A1 `scripts/lib/models.ts`, the loader.** `loadModel(source)` → `{ item: IsoItem, label, size, origin }` for `fixture:<id|label>`, `object:<id>` (live or demo, `--mode`), `save:<name>:<fixture>`, `run:<id>` (a sculpt or fit run's model), `draft:<fixture>:<n>`, `starter:<template>`, a `.json` file of an item or a sculpt (inked and read by `fromSculpt`). It uses `storedItem()` (A2). Done: the five throwaway scripts can each be written as one call; tested on the demo's memory.
- **A2 `storedItem(saved)` in the domain** (`iso-item.ts`): the `IsoItem` inside a `SavedItem`, so callers stop stripping fields. Done: used by A1 and anywhere that strips today (grep `source:` / `fit:` spreads).
- **A3 Sprite presets** (`packages/domain/src/sprite-presets.ts`): `room`, `panel`, `editor` (resolution, scale, pixel, finish, shadow), read by `sprite-draw.ts` and the CLI. Done: the web's item requests take their numbers from it; no literals left in `IsoView`/panels.
- **A4 `bun run model <source>…`** (`scripts/model-view.ts`): renders one or more sources in a grid at `--preset` (or `--px`, `--res`, `--finish pixel|clean`), `--turns 0..3`, `--zoom`, `--against <reference>` beside it (`besideReference`), `--layers` (per part, the decal unwrapped flat, and a print's ink), `--uv` (draws a test decal reading "ABC↑" on every part, so orientation is checked at a glance). Writes `out/model/<name>.png`. Done: every picture in this session's log can be made by one command; row in AGENTS.md's table.
- **A5 Score against a reference** (`scripts/lib/model-score.ts`, `--score` on A4): the sprite and the reference scaled to one height and aligned by their silhouettes' boxes, then silhouette IoU, ΔE of the body's tone ramp (lightest, mid, darkest step), outline coverage (share of the edge that is dark), and how many colours each uses. The reference gets a JSON of named regions as `bun run ref` already reads (`design/reference/`). Done: the target mug is a reference; `bun run model starter:mug --against mug --score` prints the numbers; a `--set clean.steps=5,6,7`-style sweep of the finish's numbers (moved into a `CLEAN_FINISH` table like `LAYOUT_TUNING`) reports each variant's scores.

### B. Replay Spark offline (blocks 5–8)

- **B1 Keep every sculpt answer.** `bestSculpt` stores each draft's raw answer, note, IoU and render as assets of the run (`answers.json`, `draft-<n>.png`); the run's output lists them. Done: a sculpt run's folder has all three answers; tested with the mocked Meta API.
- **B2 `bun run sculpt <run>`** (`scripts/sculpt-replay.ts`, sharing `bestSculpt`'s reading step, which moves into a pure function): each stored answer read again with this tree (`fromSculpt`, inks, `seatHandles`), scored against the stored picture, and drawn beside the model kept then. `--answer <n>` picks one; `--save` writes the result to the fixture through the server (C1). Done: replaying today's mug runs shows the buried handle seated, with no call.
- **B3 `bun run runs <id>` for sculpts** shows the picture Spark got (and its size and how it was cut: mask, SAM, box), the current render, every draft with its score, and the cost. Done: the broken 99×82 cut-out is the first thing that run's report shows.
- **B4 Prompt versions that change.** `promptVersion` becomes `<kind>-<hash of the prompt template and format lines>`, computed where the prompt is built, so the run log says which prompt was sent; `GET /api/health` returns the loaded tree's commit and dirty hash. Done: editing `SCULPT_FORMAT` changes the next run's version; a script can check the server's tree before a billed call.

### C. Change safely (blocks 9, 11–14)

- **C1 `bun run model <source> --apply <step> --save`**: applies a named domain step (`seat`, `reink`, `recolor`…, a small registry) to a saved model and saves it through `/api/item/save` or `/api/fixtures/save`, keeping the old model in `drafts`. Done: today's handle fix is one command.
- **C2 `sculptPart(over)`**, one factory for a Spark-shaped part with every field null, used by `promote.ts`, `recipe-sculpt.ts` and the tests. Done: adding a field to `sculptPartSchema` needs no other edit to compile.
- **C3 A bundled font for prints.** An OFL script face and an OFL sans in `apps/server/assets/fonts/`, passed to librsvg through a fontconfig file, so typesetting is the same on every machine. Done: `inkPrints` sets identically here and in a clean worktree; a golden of the mug's ink.
- **C4 Goldens for the clean finish.** The stock mug, the printed starter mug and a `--uv` test part, drawn at the `panel` preset, in `tests/golden/clean/`. Done: changing `cleanStep` or the decal sampling fails a golden.
- **C5 verify reads baselines.** A bench below target that is also below at the merge base is reported as "already at HEAD", not as a new finding (cached per HEAD, as `bench:at` does); the format step skips `.claude/`. Done: verify on this session's tree is clean but for real findings.

## Order

1. **A1 + A2 → A3 → A4**: everything else renders through them.
2. **B1 → B2, B3, B4**: the next live sculpt is kept whole and replayable. B1 is small and can land with A.
3. **C2** any time (small); **C1** after A1 and B2; **C3 → C4** together; **C5** any time.
4. **A5** last of A: it needs the reference's regions, and its sweep needs the finish's numbers in one table.

A, B and C5 touch different files and can run as parallel sessions in their own worktrees; C1 waits for A1 and B2.

## Status (2026-11-03)

- **Done:** A1 (`scripts/lib/models.ts`), A2 (`storedItem`), A3 (`ITEM_SPRITES`), A4 (`bun run model`, with `--uv` and `--layers`); B1 (`answers.json` and drafts kept), B2 (`bun run sculpt`, its reading shared with the route as `readSculpt` and tested on a mocked run), B3 (`bun run runs` shows the picture's size and each answer), B4 (`promptVersion` is `sculpt-<hash>` for sculpts). The stock mug is the remodel, and the `tim-hortons-mug` starter carries its print (`STARTER_PRINTS`, set by `bun scripts/starter-prints.ts`).
- **Left of A and B:** `--score` (A5); the server's loaded tree in `GET /api/health` (the rest of B4); `--save` on `bun run sculpt` waits for C1.
- **Found on the way, for C:** **C6** a turned wall thinner than a voxel or two marks some inner-wall voxels as outside, so a print facing away from the viewer shows on the inside of the cup (11 pixels on the stock mug at resolution 48, in either finish). The lathe's `zone` decides by the voxel's normal; deciding by the nearer of the inner and outer surfaces, as the per-pixel paint now does, would fix it, checked against the goldens.

## Decisions
2026-11-03:

1. **Scope:** A and B first; C and A5 after.
2. **Fonts:** vendor one OFL script face and one OFL sans for prints (C3).
3. **First:** the remodelled mug becomes the stock mug (no print) and a printed starter of its own, and is the first subject for A.
4. **Where:** in one session, in order, verifying as it goes.
