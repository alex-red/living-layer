# Plan: the brush, between things

Status: built in the demo (November 3), see [As built](#as-built); Spark's reading of it not yet run live. Builds on [ai-brush.md](ai-brush.md) and [agent-tooling.md](agent-tooling.md).

## Goal

Requests that are about two things and a moment, not one thing:

- _Selects the cat on the cat tree:_ "let's make a variant of the tree that's occupied", shaped by where the cat is sleeping now.
- "Show the chair taken when someone sits in it."
- "Put the mug on the top shelf instead."

Today the brush handles one target and edits its model (`recolor`, `resize`, `create`, …). Three things are missing:

1. **More than one thing.** `resolveSelection` returns one target. The cat is what was drawn on, but the sentence is about the tree, and the cat is the reference.
2. **States on a made model.** Fixtures already have named states, each with its own model (`Fixture.states`, `stateVariantModel`, the cat's `idle` and `sleeping`). No intent op writes one.
3. **Where one thing is on another.** The variant needs the cat's current spot as a place on the tree (a platform or surface), not as frame pixels.

Most of the rest exists: `occupied` is a stat whose SAM concept is `cat` for a cat tree (`stats.ts`, `occupantOf`), the watcher decides occupancy locally (`occupancy.ts`), and the room camera can turn a foot point into a place on a surface.

## Do we need Meta's classifier models?

No new model. What's missing is grounding and vocabulary, not recognition:

- **Telling what's selected** is already SAM 3.1 (box or concept prompt) and the room's own labels through the calibrated camera. "Cat" is a SAM concept already in use for occupancy.
- **Reading the sentence** stays one Spark call (Spark is Meta's recommended model for cost-sensitive classification). Spark sees the candidates and their relation, then picks ids and ops from closed lists.
- **Telling the occupant apart locally** is the existing appearance layer (DINOv3 patches).

A separate classifier would only pay off for something Spark and SAM can't do from one frame, for example telling two cats apart over time. That's identity tracking ([multi-tracking.md](multi-tracking.md)), not the brush.

## The design

### 1. Several targets with their relation

`resolveSelection` already scores every candidate. A new `relatedTargets(scene, target)` adds what the target stands on and what stands on it. It reads support from the scene's surfaces and the camera, not from pixel overlap. The cat is on `cat-tree`'s `platform-2` surface, at a point in that surface's own tiles.

`IntentContext` gets `related: { target, relation: 'on' | 'under' | 'beside', at }[]`. `describeContext` lists them with their ids, so Spark can say "the subject is `cat-tree`, the occupant is `fixture:cat`" without guessing ids. `readIntent` checks every id it gets back against the context, as it does for entities now.

### 2. One new intent op: `add_state`

```ts
{
  op: 'add_state';
  subject: string;
  state: string;
  occupant: string | null;
  from: 'now' | null;
}
```

- **Subject** is the thing that gets the variant. Its model is copied: a fixture's `SavedItem`, or a prop's `recipe`.
- **Occupant**, with `from: 'now'`, is drawn into the copy where the camera sees it now: the occupant's current state's model (the cat's `sleeping`), placed at its `at` on the subject's surface. It's a part of the variant, not a fixture of its own, so the variant is one model.
- Saved to `states[state]` on the subject. A prop's recipe gets states the way fixtures have them (`IsoProp.states`, the same shape). This is the one schema change.
- **`occupied` links itself:** when the subject has the `occupied` stat, its state follows the stat (occupied ⇒ `occupied`, clear ⇒ the base). That's one line in the place that applies stat changes, not a rule the person has to write.

`readIntent` refuses it with a reason when the occupant isn't on the subject, when there's no subject model to copy, or when the state name is taken. Asking back (`clarify`) covers "which tree?".

### 3. Review

The panel shows the base and the variant side by side, drawn by the room's kernel. It also shows "follows Occupied (cat)" when the stat links it. Saving writes the state, and nothing else in the room moves.

### 4. Checks

- `scripts/lib/intent-cases.ts`: the cat case and "the chair taken", plus a case that should ask back: a selection on the cat with "make it occupied" and two cat trees in the room.
- `demoIntent` gets the pattern ("variant … occupied", "… taken", "with the cat"), so the demo answers without Spark.
- `tests/assist.test.ts`: a demo request through `/api/assist` that ends with `states.occupied` holding a part from the cat's model above the platform's top.
- `bench:intent --live --only occupied --repeat 3` once, about $0.05, to see whether Spark picks the subject consistently.

## Demo slice before the submission

The demo office has no cat tree. The smallest version that shows the idea is a brush-made cat tree (the existing `create` path) and the demo cat fixture placed on it, then the `add_state` request through `demoIntent`. That's 1, 2 and 4 without the live bench. Skip it if the live checks in [current.md](current.md) aren't done.

## Tools and MCP

There are two questions here:

**Inside the lab (Spark driving the brush).** Keep the fixed pipeline. Each op is already a typed tool with a zod schema, and the prompt lists them from the registries (`opCatalog`). Adding `add_state` is the same move as every op before it. A Spark tool loop helps only when a request needs a result to decide its next step ("find the cat, then …"). Relations in the context cover this case without one.

**Outside it (Claude Code and other agents editing the room).** A small MCP server is worth having after the submission. It shouldn't be a second implementation, just a front end on what scripts already share:

| Tool            | Backed by                                                                           |
| --------------- | ----------------------------------------------------------------------------------- |
| `room.describe` | the scene, fixtures, stats and `relatedTargets`: what `describeContext` gives Spark |
| `brush.run`     | `runBrush` in `scripts/lib/brush.ts` (demo in process, live against the server)     |
| `brush.ops`     | `RECIPE_OPS` and the intent ops with their JSON schemas (from zod)                  |
| `room.render`   | `bun run room` / the brush overlay, as an image                                     |
| `bench.*`       | `bench:intent`, `bench:brush`, `bench:room` summaries                               |

The schemas come from the same registries, so a new op shows up in MCP, in Spark's prompt and in the CLI from one definition. Demo mode needs no server, which keeps the rule against starting one.

## How agents learn to make edits here

The repo already does what works: AGENTS.md lists only what isn't in the code, plus the "look before and after" table, and the registries describe themselves. Three things would close the gaps the brush work hit:

1. **A "new op" checklist in AGENTS.md**: the files an op touches (`recipe-ops.ts` or `intent.ts`, `demo-intent.ts`, `intent-cases.ts`, `assist.ts` if it needs a step, the review in `Brush.tsx`) and the check that proves it (`bench:intent`, `bun run brush`). Today that list has to be rebuilt from git history.
2. **One test that every op is reachable**: each op in the registries has an intent case and a `demoIntent` pattern, so a new op can't land with only half of it.
3. **The MCP above**, for agents that don't read the repo. Agents that do should keep using `bun run brush` and the benches: they're the same calls, and their output lands in `out/` for review.

## Order

1. `relatedTargets` and `IntentContext.related`, with tests on the demo room.
2. `add_state` in `intent.ts`, `readIntent`'s checks, `IsoProp.states`, the variant build.
3. `demoIntent` pattern, intent cases, assist test. **Demo slice ends here.**
4. Review panel, linking the `occupied` stat, one live intent bench run.
5. AGENTS.md checklist and the reachability test.
6. MCP server over `scripts/lib/brush.ts` and the registries.

## Open decisions

- **Prop states or fixture only?** A cat tree made by the brush is furniture (a recipe on a prop). Recommended: give props `states` in the fixture shape, rather than forcing the tree to be a fixture, since furniture is what the cat stands on.
- **Occupant pose:** take the occupant's current state model as it is, or ask for one ("sleeping curled up")? Recommended: as it is, with a follow-up able to change it.
- **Auto-link to `occupied`,** or leave it to a rule? Recommended: automatic, shown in the review, with the option to turn it off.

## As built

All six steps, with these differences and gaps:

- **Variants are on furniture only.** `add_state` refuses a fixture as its subject, with a reason. A fixture's states are `SavedItem` models, not recipes, so drawing an occupant into one is separate work.
- **Where they live:** the group's recipe prop keeps `states` (its own model as `base`), `state` (the one drawn) and `follows`. Switching swaps `recipe` and scales the box's height (`showVariant`), so every reader of the scene draws the variant without knowing about it. A group drawn from a form is rebuilt from `recipeFromForm` in place first, keeping its group id and surface ids (`withVariant`).
- **The occupant** is two blobs (body, head) in its model's colours, at the fixture's place in the furniture's own centimetres, through the group's turns (`variantRecipe`). The model grows taller when it lies on the top.
- **Occupied:** saving a followed variant adds the `occupied` stat to `prop:<group>`, with SAM's concept from the occupant's name. Furniture that follows a stat is a stat thing, its region where the calibrated camera sees it (`groupRegion`). The watcher swaps the variant when the stat changes (`followStats`).
- **Saving replaces a variant of the same name.** A later brush edit that rebuilds the furniture (`create`, `rebase`) drops its variants.
- **Coverage:** `tests/op-coverage.test.ts` holds every op to an intent case or a `DEMO_GAPS` reason. `add_part`, `remove_part`, `rebase` and `match_photo` are listed there.
- **MCP:** `bun run mcp` (`scripts/mcp.ts`, `.mcp.json`), a stdio server written by hand (no SDK dependency). Its tools are `room_describe`, `brush_ops`, `brush_run` (demo in process, or live and billed) and `demo_api`, which calls the in-process demo's API only. The demo lab lasts as long as the server, so a saved variant is there for the next call.
- **Not run:** `bench:intent --live` on the new cases, and the browser suite (`bun run browser`) after the panel's change.
