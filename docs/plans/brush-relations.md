# Plan: the brush, between things

Status: built in the demo on Things (November 3), see [As built](#as-built); Spark's reading of it not yet run live. Builds on [ai-brush.md](ai-brush.md) and [agent-tooling.md](agent-tooling.md).

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

Everything here follows [things-and-stats.md](things-and-stats.md#decisions): **props stay layout** and never carry stats or states, and **everything else is one Thing** (`memory.fixtures`): fixtures placed by hand, and the mug and other things placed by their sightings. A Thing's model is an item (`SavedItem`, at most 12 parts), and its named states each have a model of their own (`Fixture.states`), the way a cat has `idle` and `sleeping`.

### 1. What stands on what

`relatedTargets(scene, things, target)` (`selection.ts`) gives what the selected thing stands on (`holds`) and what stands on it (`on`), for every kind of Thing, from the room and not from pixels:

- **A thing on the layout** names its surface (`desk:top`), which belongs to a prop.
- **A thing on another thing** stands inside its footprint at its height (`standsOn`), since a thing has no surfaces of its own: a cat on a cat tree from the starters.
- **A thing placed by its sightings** stands where the camera sees its foot touch down: the foot through the calibrated camera, on the highest top the ray meets, whether a layout surface or a thing's box (`sightingBox`).

The picture names a sighted thing `object` and memory names it a fixture. `sameThing` treats the two as one, and a request names each by its ref (`prop:desk`, `fixture:<id>`, `object:<id>`).

### 2. One new intent op: `add_state`

`{ op: 'add_state'; subject; state; occupant }`, read by `readIntent` against the context's related things:

- **The subject** is the Thing that gets the variant: named, else what the selection stands on, else the selection.
- **The occupant** stands on it: named, else the selection when that stands on the subject. `occupied` needs one.
- **The state** is a short name. `on` and `off` stay with the thing's entity.
- **Recipe edits beside it are left out** with the reason: a variant is a thing's item model, and its card edits it once it is kept.

### 3. The variant's model

`variantItem` (`thing-variant.ts`) draws the occupant's current model (the cat asleep) into the subject's own model. It works in the subject's frame before its turns, at the scale the room draws both (one item unit to the box's width). The occupant settles onto the top of the subject's part under its middle (the tree's bed), not onto its box. It keeps at least its two biggest parts, and the subject keeps its biggest of the rest, within 12. The state is as tall as the occupant reaches.

### 4. Keeping it

`/api/assist/save` writes `states[state]` on the thing (and things linked to it) and leaves the state it shows alone. When the variant follows its occupied stat, saving turns the thing's `occupied` stat on, with SAM's concept from the occupant's name. The watcher shows the state while the stat is on and puts the thing back when it turns off (`followOccupied`). Only the `occupied` state is switched off that way, so a lamp's `on` stays.

**Furniture is made a thing first,** as _Make it a thing_ does: `promoteBuiltIn` on a preset room, `promoteGroup` on the person's own layout. This happens only when nothing placed by hand stands on its surfaces, because a thing has no surfaces and they would drop to the floor. Otherwise the request is refused with the reason. A sighted thing on it isn't stranded: it is placed by the camera each time, onto the new thing's top.

### 5. Review

The panel shows the variant's model (`useItemSprite`), what it is the state of, the occupant, and whether it follows Occupied. The button reads _Keep the state_, or _Make it a thing with this state_ for furniture. Selecting something that stands on something suggests _Make a variant of the … that's occupied_.

### 6. Checks

- `tests/brush-variant.test.ts`: relations for every kind of Thing; the variant drawn back where the cat was, turned or not; `followOccupied`; end to end in the demo, a sighted cat on a cat-tree Thing kept as the tree's occupied state, and furniture with a thing on it refused.
- `scripts/lib/intent-cases.ts`: the cat on the tree, said two ways, and the tree with nothing on it.
- `tests/mcp.test.ts`: the same through the MCP server.

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

## Open decisions

- **Things on things.** A thing has no surfaces, so one put on another by hand is drawn on the floor inside it. Giving a thing's model surfaces (its flat tops, as a recipe names them) would let the cat stand on the tree's bed, and let furniture with things on it be made a thing.
- **Hide the occupant while its variant shows?** Today both are drawn. Hiding it would need the watcher to say which thing filled the occupied state.
- **Occupant pose:** taken as the camera's thing shows it now. A follow-up can't change it yet, because recipe edits don't apply to item models.

## As built

Built as above in two steps. The first (36673a7) kept variants on props, with a `prop:<group>` stat, which broke the rule that props are layout. This replaces it: nothing of it is left in `IsoProp` or the stat runner.

- **Not run:** `bench:intent --live` on the new cases, and the browser suite (`bun run browser`) after the panel's change.
- **The occupant stays a Thing of its own.** While the variant shows, the followed cat is drawn too, where the camera sees it, which is nearly the same place.
- **A thing placed by hand on another thing** stands on the floor inside its footprint, because a thing has no surfaces. It counts as standing on it, but it is drawn at floor height. A sighted one is drawn on the top.
- **12 parts:** the occupant's smallest parts, then the subject's, give way (the cat tree's string toy).
- **Coverage:** `tests/op-coverage.test.ts` holds every op to an intent case or a `DEMO_GAPS` reason. `add_part`, `remove_part`, `rebase` and `match_photo` are listed there.
- **MCP:** `bun run mcp` (`scripts/mcp.ts`, `.mcp.json`), a stdio server written by hand (no SDK dependency). Its tools are `room_describe` (the layout, the Things with their states and stats, and what stands on what), `brush_ops`, `brush_run` (demo in process, or live and billed) and `demo_api`, which calls the in-process demo's API only. The demo lab lasts as long as the server, so a kept state is there for the next call.
