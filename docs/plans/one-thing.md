# Plan: the mug is a thing like any other

Status: not started. The detail of phase 2 of [things-and-stats.md](things-and-stats.md) ("One Thing"). Waits for two things: the November 4 submission, and [multi-tracking.md](multi-tracking.md)'s work in progress (`watch.ts`, `tracker.ts`, `assign.ts`, `desk.ts`, `watcher.ts`), which changes the same files.

## Why

The lab began as "follow one mug, switch a lamp when it enters a zone", and the mug still lives in fields of its own. Everything added since sits beside it:

|                  | Stored in                                                                           | Placed by                                         | Editable                                             |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| the mug          | `DeskMemory.object`, `observation`, `history`, `item`, `zone`, `placement`          | its last sighting, through the pin (`projectBox`) | model and zone only                                  |
| other objects    | `others[]` (`TrackedObject`)                                                        | the same                                          | the same                                             |
| fixtures         | `fixtures[]`, with an optional `track` once the camera follows one (`FixtureTrack`) | the person, or the camera once followed (`moved`) | everything: move, turn, type, model, control, delete |
| the main zone    | `DeskMemory.zone`, its state in `placement` and `lastDecision`                      |                                                   | its own panel, unlike every other rule               |
| every other zone | `rules[]` (`PlacementRule`)                                                         |                                                   | the rule builder                                     |

So the mug can't be renamed, retyped, given a control or deleted like a fixture, its zone is edited in a panel of its own, and three code paths (`objectById`, `modelTarget`, `setModel`, `withSighting` each branch three ways; `WatchKind` is `'mug' | 'object' | 'fixture'`) do one job. Fixtures already do what the mug needs: `FixtureTrack` is a followed fixture, and a `moved` one has its place follow the camera.

## Decisions

- **One `Thing`** (today's `Fixture`, renamed in phase 2c), in `memory.things`. The mug and each of `others` become things with `track` set, keeping their ids, so evidence, stats keyed by id and Home Assistant sources keep pointing at them.
- **`place: 'hand' | 'sightings'`.** A thing placed by sightings is drawn where it was last seen, through the pin, exactly as the mug is now (same `projectBox`, same `believableWidth`). A hand-placed thing keeps its spot. A followed fixture today is `'hand'` and stays so.
- **Editing a followed thing.** Everything a fixture's panel offers works on it: name, type, model, control, delete. Dragging it in the room is refused while the camera places it, with the reason on hover: "The camera places it. Stop following it to place it by hand." _Stop following_ keeps it where it was last drawn as a hand-placed thing; _Follow it_ (today's find) turns it back.
- **The main zone is an ordinary rule** with the id `main` (`MAIN_ZONE`, which exposed sources already name), on the first light, counting the mug, with its `look`, `offWhenEmpty`, `onSurface`, `placement` and `lastDecision`. It keeps the label "Main zone" and leads the rules list, but nothing else treats it apart.
- **Desk-level fields that stay:** `surface`, `camera`, `fixedCamera`, `scene`, and `lastDecision` as "the latest decision of any rule" (the activity line reads it).
- **No old routes kept.** The web and server ship together; old saves are handled by `upgradeMemory`, not by the API.

## Migration

`upgradeMemory` (domain, pure, run by `deskMemorySchema`'s preprocess on every read):

1. `object` + `observation` + `history` + `item` → a thing `{ id: object.id, label, type: 'mug', place: 'sightings', model: item ?? stock mug, control: none, track: { concept: 'mug', observation, history, status: 'seen' } }`. With no observation yet, `track` waits (`status: 'missing'`).
2. Each of `others` the same, with its own `concept`.
3. `zone` + `placement` + `lastDecision` → the rule `main`. With no zone, no rule.
4. `fixtures` → `things` unchanged, `place: 'hand'`.
5. The old fields are deleted. A memory already upgraded is returned as it is.

Session saves (`currentSave`, `/api/desk/restore`) and stored runs go through the same function. `tests/store-migrate.test.ts` gets cases from real shapes: a copy of today's demo and live `desk_memory` rows (anonymised: labels and boxes only), a memory with a zone and no observation, one with `others` and rules counting them, and one already upgraded.

## Where it changes

Found by grep on November 3 for the old fields, `WatchKind`, `MAX_OTHER_OBJECTS`, `MAX_FIXTURES` and the three-way helpers; recount before starting.

- **Domain** (`memory.ts`, `rules.ts`, `watch.ts`, `fixture.ts`, `expose.ts`, `requests.ts`, `place-fit.ts`, `iso-voxel.ts`): one `thingById` replaces `objectById`, `modelTarget`, `setModel` and `withSighting`'s branches; `WatchKind` goes; `MAX_THINGS` (16, the watcher's bound) replaces the two caps; rule evaluation loses its main-zone path. Exposed `zone_of` and `status` sources already take a thing id.
- **Server** (`desk.ts`, `watcher.ts`, `select.ts`, `item.ts`, `assist.ts`, `scene.ts`, `fixture/save.ts`, `fixture/scan.ts`): `/api/desk/zone` and `/zone/options` become `rules/save` on `main`; `/api/desk/track`, `/objects/track`, `/objects/select` and `/objects/forget` become thing routes (`things/follow`, `things/select`, `things/delete`), with `requests.ts`, `routes.ts` and `tests/routes.test.ts` updated together. The watcher follows one list.
- **Web** (`Outline.tsx`, `Inspector.tsx`, `IsoScene.tsx`, `IsoView.tsx`, `PhotoReview.tsx`, `IllustrationView.tsx`, `CanvasPanes.tsx`, `TrackingOverlay.tsx`, `ExposePanel.tsx`, `labels.ts`, `progress.ts`, `state/observation.ts`, `state/tracking.ts`, `state/helpers.ts`): the outline lists things once (objects and fixtures merge); the fixture panel serves every thing, with a _Followed by the camera_ row; `ObjectMarker` goes and every thing draws as a `FixtureMarker`; the main zone's panel becomes the rule builder. The onboarding steps ("find the mug") read "the first followed thing".
- **Tests** (`desk`, `item`, `photo`, `room-scan`, `scene`, `watch`, and the browser spec): they keep what they check. Ids in fixtures of tests stay; `data-object="tracked"` in the browser spec becomes the thing's id.

## Phases

Each phase lands on `main` with `bun run verify` passing, and is usable on its own.

- **2a. Read through one door.** `thingById` and friends in domain, reading today's fields. Every reader moves to them. No stored change. Small, safe, and it makes 2b a change in one place.
- **2b. Migrate.** `upgradeMemory` as above; the helpers read `things` and `rules` only; old fields deleted from `DeskMemory`. Server routes and the watcher follow.
- **2c. One panel.** The web: outline, panel, marker, rule builder, the stop-following and follow-again actions, the drag refusal. `Fixture` renamed `Thing` across the code.
- **2d. Tidy.** Delete what nothing reads (`bun run dead-exports`), update `docs/architecture.md` and AGENTS.md's notes on the mug.

## How to know it held

- `bun run verify`, `bun run browser`, `bun run bench:track` and `bun run bench:brush` before and after each phase: no regressions, the same SAM call counts.
- Home Assistant: with the bridge on, an exposed `in_zone` on `main`, a `zone_of` and a `status` on the mug keep their entity ids and states across the upgrade (`unique_id` is built from the exposed entity's own id, so it doesn't move).
- A copy of the real `.data` (both modes) starts, shows the mug where it was, keeps its zone, and switches the lamp as before. Done on a copy: the upgrade rewrites memory on its first save.
- The demo: `bun run reset demo`, then the demo's own walk-through (follow the mug, it enters the zone, the lamp turns on).

## Risks

- **Old saves.** A save from before the upgrade restored after it must upgrade too; covered by the restore path going through `upgradeMemory`, and by a test.
- **Two writers.** The watcher writes sightings every few frames: the upgrade runs on read, inside `store.updateMemory`, never across an `await`.
- **The mug's special cases.** Some code assumes "the mug" (the demo's moves, `concept: 'mug'`, the brush bench's targets, the onboarding). Each is found by the grep above and given a thing id instead; the demo's mug keeps the id it has.
- **Size.** About 35 files. 2a and 2b are mostly mechanical; 2c is where a person will notice, so it is checked in the running app, not only in tests.
