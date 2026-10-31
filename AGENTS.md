# Notes for coding agents

What isn't obvious from the code. [CONTRIBUTING.md](CONTRIBUTING.md) has setup, checks and commit style; [docs/architecture.md](docs/architecture.md) has how things fit together.

## Ground rules

- Don't start the dev server or run a build unless asked. If one is already running, use it to look.
- Stage files by explicit path, never `git add -A`: other sessions may leave files in this checkout.
- Commit summaries stay under about 60 characters (Conventional Commits); put the detail in the body.

## The isometric room

- One tile is 30 cm (`ISO_TILE_CM`, `cm()` in `packages/domain/src/iso-furniture.ts`). Template sizes and model parts are real measurements.
- A prop is a box (for placing, picking and draw order). Its `form` names the model drawn inside it, built from `FURNITURE_SPECS`, and turned by its `turns`.
- Anything that needs a prop's shape (camera silhouettes, photo textures, synthetic photos) must go through `propSolids`, never the prop's box: a desk's box is mostly air. Grep for `propSolids` to find every reader.
- Changing a measurement means editing `FURNITURE_SPECS`, not a literal in a builder. To try values without editing, use `withFurniture` or a `--set` flag (below).

## Look before and after

These run in seconds and need no server. Their output goes to `out/` (ignored).

| When you change…                        | Run                                                        | What it tells you                                                               |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| a furniture model or template           | `bun run sheet` (`--only chair --zoom 6`, `--room office`) | every template at every turn as one PNG you can open; time per model            |
| templates, `photo-scene.ts`, the kernel | `bun run bench:scene`                                      | pin, depth and position margins on synthetic photos                             |
| the item fitter or kernel               | `bun run bench:fit`                                        | IoU and ΔE margins per crop                                                     |
| any of the above                        | `bun run bench:at HEAD scene`                              | the same bench at a commit, then this tree against it, with regressions flagged |
| a measurement you're unsure of          | `bun run bench:scene --set desk.topCm=3,4,5`               | every combination, with a per-variant summary                                   |

- Unit tests don't cover every bench case. Run the bench before and after; a case that met its targets and no longer does is a regression even if `bun test` passes.
- A bench's own targets (`SCENE_TARGETS`, `FIT_TARGETS`) are shared with the tests; known gaps are listed in the bench with a reason.
- Golden sprites: `tests/golden/` (archetypes) and `tests/golden/props/` (templates). Accept a deliberate new look with `UPDATE_GOLDEN=1 bun test tests/model.test.ts tests/furniture.test.ts`, and look at the PNGs before committing them.
- Screenshots of the running app are downscaled and the browser zoom only crops: to judge a model's pixels, use the sheet.

## Shell

The agent shell here may be fish. Put anything with loops or `set --` in a script and run it with `bash`, or use a Bun script.
