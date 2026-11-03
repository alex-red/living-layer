# Plan: things and their stats

Status: built (November 3; see _As built_ below). Phase 2, [one Thing](one-thing.md), is on the branch `one-thing`, not yet merged into `main`.

A person wants to know what the things in a room are doing, not only where they are: when the mug was last drunk from, whether the monitor is on, how much the mouse was used today, whether the cat is on its tree. Each of those is a **stat**: a small typed value about one thing, worked out from the camera or from Home Assistant, kept as a history, and shown on the thing's card, over it in the room, over the live camera and in Home Assistant.

## Decisions

- **Props stay layout.** A prop is a box a template draws; a scan may redraw it, and it has no identity beyond its group. It never carries stats.
- **Everything else is one thing.** Fixtures, the mug and the other remembered objects become one `Thing` with traits: placed, modelled, controllable, followed, stats. A prop can be promoted to a thing in one step, like a built-in lamp becomes a lamp fixture today.
- **Stats are switched on one at a time.** A thing's type ticks its usual ones when it is added (a monitor: power), and the person can change that. A thing with no stat on costs nothing. There is no separate "trackable" flag: a thing is tracked when it is followed or has a stat on.
- **Local first.** Detectors run on the watcher's own grey frames and on Home Assistant state, at no cost. A stat may ask SAM to settle a change only when tracking may call AI (`tracking_ai`), and at most once a minute per stat.
- **Shown once.** A vision stat learns its looks from the person: _It's off now_, _It's on now_, _It's empty now_, the way `learn-empty` does for zones. Until then it is unavailable, never guessed.
- **History**: each change is an event, kept as long as evidence (`EVIDENCE_RETENTION_DAYS`); a total per thing, stat and day is kept for good.

## Lightweight by design

The watcher reads 10 grey frames a second at 320 px and already follows up to 16 things. Stats must not change that budget in any way a person could notice.

- **No new frames.** Every vision detector reads the `LumaFrame` the watcher already has. No second ffmpeg, no colour decode, no extra stills.
- **A fixed, small sample per stat.** A detector samples its region onto a fixed grid (16 × 12 grey values, like `zoneSample`'s 32 × 24 but smaller) into a buffer allocated once when the stat starts. Nothing is allocated per frame or per pixel (the kernel's hot-loop rule applies).
- **Each stat has its own cadence.** It runs as often as its value can change, not on every frame: activity every frame (it reads the motion share the watcher already computed for that thing), power once a second, occupied every 3 s (`OCCUPANCY.everyMs`). A detector whose region didn't move since its last run (the watcher's motion check) skips its comparison and keeps its value.
- **Regions are worked out once.** A followed thing's region is its tracked box. A thing that isn't followed (a monitor, a promoted cat tree) gets its region by drawing its `propSolids` through the calibrated camera, never its box, cached until the thing, its model or the calibration changes.
- **Values change rarely, and only changes travel.** Each detector has hysteresis and a least dwell (a value must hold for 2 s before it counts), so it doesn't flicker. Only a change becomes an event, goes on the events stream, reaches the overlay and is published to Home Assistant. A still room sends nothing.
- **Writes are batched.** Events go into memory and are written in one transaction every 5 s and at shutdown. Day totals are added up in memory as events arrive and written with them, so reading a week means reading seven rows, never re-adding events.
- **Feature patches are shared.** The occupied stat may use the feature model, but only on the 3 s tick the zone `occupied` source already has, and all things that need patches on a tick share one embedding of the frame.
- **Budget.** All stats of 16 things, each on, add under 0.5 ms a frame on an M-series Mac, measured by `bench:track` (below). Over budget is a regression like any bench target.

## The model

In `packages/domain/src/stats.ts`, pure, no I/O:

```ts
/** A stat's definition: what it measures, how it's read and drawn. */
interface StatKind<V> {
  key: 'power' | 'lastUsed' | 'activity' | 'occupied';
  value: 'onOff' | 'time' | 'level';
  /** What it needs before it has a value: looks the person shows once. */
  learn: ('off' | 'on' | 'empty')[];
  /** How often it runs, ms; 0 for every frame. */
  everyMs: number;
  /** What it adds up per day: seconds on, uses, active seconds. */
  daily: 'onSeconds' | 'count';
  detect: Detector<V>;
}
/** One stat switched on for one thing, kept in desk memory on the thing. */
interface ThingStat {
  key: StatKind<unknown>['key'];
  /** Its learned looks, small grey samples; feature grids stay in settings like empty looks. */
  looks?: Partial<Record<'off' | 'on' | 'empty', Uint8Array>>;
  /** Where its value comes from first: Home Assistant when the thing switches an entity. */
  source?: 'camera' | 'entity';
  /** Opt-in, billed: ask SAM to confirm a change (needs `tracking_ai`). */
  samConfirm?: boolean;
}
/** One change of a stat's value, as stored. */
interface StatEvent {
  thingId: string;
  key: string;
  at: string;
  value: boolean | number | null; // null: unavailable (camera moved, not learned)
  source: 'camera' | 'entity' | 'sam';
  confidence: number;
}
```

`STAT_KINDS` is the registry, and a type's defaults are a table (`TYPE_STATS`: `monitor → ['power']`, `lamp → ['power']`, `mug → ['lastUsed']`, `device → ['activity']`, `cat-tree → ['occupied']`). A new stat is one entry and one detector with its tests; nothing else changes.

A **detector** is a pure step: `(state, input) → { state, value?, confidence }`, where `input` is the frame's sample of its region, the thing's watch status and motion share, and the entity's last state. It keeps its own small state (dwell, hysteresis) in a typed object, so the watcher can run it and a test can replay it.

### The first four

| Stat     | Read from                                                                                                                                                                                                                                                                                                                     | Limits                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| power    | The region's mean grey and contrast against its learned `off` and `on` looks, as a ratio to the rest of the frame's mean, so the room's own lights going on don't count. Held while there is motion in the region (someone in front). For a thing that switches an entity, the entity's confirmed state wins (`noteControl`). | A screen showing a dark picture looks off: needs the contrast term and the dwell. A lamp turned on by hand outside Living Layer is only seen by the camera.                                        |
| lastUsed | The watcher's own story of the thing: it left its spot (lost, or moved past `FIXTURE_MOVED`) for at least 3 s and then came back still. Its time is when it came back. Counts per day. No pixels of its own.                                                                                                                  | "Used" means "picked up and put back", not "drunk from". A mug hidden by a hand for 3 s counts. Needs the mug followed.                                                                            |
| activity | The motion share the watcher already computes around the thing, over its own threshold, in seconds a minute. Free.                                                                                                                                                                                                            | A mouse is a few pixels across from the corner camera and a hand typing beside it moves them too: a rough signal, shown as a level, never on/off. A close camera of the desk makes it much better. |
| occupied | `occupancy.ts` on the thing's region against its `empty` look: feature patches with the model, else grey. With `samConfirm`, SAM is asked for `cat` (the thing's own concept, set by type) when it starts to look occupied.                                                                                                   | Without SAM a cushion moved looks occupied. The thresholds are `OCCUPANCY`'s first guesses.                                                                                                        |

A camera seen to move (`camera.moved`) makes every vision stat unavailable until it is calibrated again, like rules.

## Where it runs

- **`StatRunner`** (`apps/server/src/stats.ts`), one per mode, owned by the `Watcher` and fed after each `watchStep` with the frame and each thing's step result. It keeps each enabled stat's detector state, runs the ones whose tick is due, and hands changes to the store and the event stream. Synced like the watcher (`sync`) after every thing change. With watching off, only entity-sourced stats run, on `noteControl`.
- **Demo**: the `DemoSource` render already draws a lamp's glow by its state and moves the mug, so power and lastUsed run on it unchanged. Demo looks are learned from the render, and the demo's monitor gets a lit screen state so power has something to see.
- **Store**: two tables in `store.ts`, `stat_events (thing_id, key, at, payload)` indexed on `(thing_id, key, at)`, and `stat_days (day, thing_id, key, payload)`. Events are pruned with evidence; days are not. Neither lives in desk memory: memory holds only each thing's `stats` (which are on, their looks).

## Routes

In a new `things` plugin (or `fixtures` until phase 2), schemas in `requests.ts`, calls in `routes.ts`, paths in `tests/routes.test.ts`:

- `POST /api/things/stats`: switch a thing's stats on or off.
- `POST /api/things/learn`: keep the current frame's look of a thing's region as its `off`, `on` or `empty`.
- `GET /api/things/:id/stats?days=7`: current values, the last 24 h of events, and day totals.
- Changes go out on `GET /api/watch/:mode/events` as `stat` messages beside the boxes, so the overlay and badges need no stream of their own.

## Where it shows

- **Thing card** (the thing's panel): each stat's value and how long it has been so ("On · 2 h 10 min", "Last used 12 min ago"), a 24 h ribbon drawn from the events, a 7-day sparkline from the day totals, and _It's off now_ / _It's on now_ buttons until it has learned. A stat with low confidence says so.
- **Room badges**: a small mark over each thing in the iso room, drawn from the store, not React state per frame. Amber stays reserved for lamps whose light is confirmed: a lamp seen on by the camera only gets a neutral mark.
- **Camera overlay**: a toggle in the live capture bar. Each followed thing's box gets a chip with its stats, and an unfollowed thing's chip sits at its projected region. Drawn on a canvas over the video from the same `stat` messages, redrawn only when one arrives or a box moves.
- **Home Assistant**: a new expose source `stat` (`{ thingId, key }`): power and occupied as `binary_sensor`, lastUsed as a `sensor` with `device_class: timestamp`, activity as a `sensor` in minutes today. `evaluateExposed` reads the runner's current values; the exposer's diffing does the rest.
- State in the web goes in a slice under `apps/web/src/workspace/state/` (`stats.ts`), with live values in the store (`state/store.ts`), since they change while watching.

## Phases

### Phase 1: stats on what exists

Stats keyed by thing id (a fixture's id, the mug's `object.id`, an object's id), with no migration yet, so the mug's lastUsed works from day one.

- `stats.ts` (registry, the four detectors), `StatRunner`, the two tables, the three routes, the thing card.
- Tests: `tests/stats.test.ts` replays each detector over made-up frames (a region brightening, motion beside a mouse, a mug lifted and put back, a hand passing in front of a monitor). The demo end to end: learn the lamp's looks, switch it, see one power event and one day total.
- `bench:track` gets a stats column: cost per stat per frame, and on a marked clip, each stat's intervals against a `<clip>.stats.json` marked by hand (first: a monitor switched on and off, a mug lifted three times).

### Phase 2: one Thing

In detail: [one-thing.md](one-thing.md).

- `Fixture` becomes `Thing`; the mug and `others` become things with `place: 'sightings'` (drawn from where they were seen, as now) instead of a hand-placed spot. `upgradeMemory` moves `object`, `observation`, `history`, `item` and `others` into `things`, keeping ids, so stat history needs no change.
- The main zone becomes an ordinary rule on the main light, with the same `look` and `offWhenEmpty`. Its tests move with it and must pass unchanged in what they check.
- `WatchKind` collapses to one kind. `MAX_FIXTURES` and `MAX_OTHER_OBJECTS` become one `MAX_THINGS` (16, the watcher's bound).
- Run before and after: `bun run bench:track`, `bun run bench:rooms`, `bun run browser`.

### Phase 3: promote a prop

- _Make it a thing_ on a selected prop's panel: the group becomes a thing with the prop's `form` or `recipe` as its model, at the same place, and leaves the layout (`sceneForSave`'s rule for tracked things). A later scan keeps it rather than drawing the prop again.
- Cat tree gets a template (a real measurement in `FURNITURE_SPECS`) and `TYPE_STATS` default `occupied`.

### Phase 4: everywhere

- Room badges, the camera overlay, the `stat` expose source.

## As built

Where it differs from the above, and what is left:

- **Looks live in `settings`**, not in desk memory: `look:<mode>:<thing>:<stat>:<look>`, a power look as its mean and contrast, an empty look as the zones' empty looks are kept (`lookText`, `readLook`, shared with the watcher). Memory keeps only `thingStats`, each thing's switched-on stats (`thingStatSchema`: key, `samConfirm`, `concept`).
- **Regions.** A followed thing's is its tracked box. An unfollowed fixture's is `fixtureInFrame` (its last sighting, else its box through the pin), not `propSolids` through the room camera; the mug and other objects use their last sighting. The overlay gets an unfollowed thing's region as `StatNow.region`.
- **Feature patches aren't shared**: occupied embeds its own region on its 3 s tick, as the zones' occupancy does.
- **Activity** is a running average over about a minute, not a share of a kept window: a minute of steady motion reads about two thirds.
- **The history route** is `GET /api/things/:mode/:id/stats?days=7`. Stat values ride on the watch stream as `WatchView.stats`, and on `ExposeWatch.stats` for Home Assistant.
- **Stale.** While nobody watches, a camera stat keeps its last value marked `stale`, and isn't counted towards today; an entity's is.
- **Promoting a prop** (`promoteGroup`, `promote.ts`; _Make it a thing_ in the layout editor) converts the layout's model to item parts through the sculpt format, keeping the 12 biggest: a bookcase keeps its frame and few of its books. A later scan doesn't yet know the thing replaced its prop, and may draw the prop again.
- **The cat tree** is a fixture starter (`catTreeItem`, 50 × 50 × 120 cm), not a `FURNITURE_SPECS` template: what keeps stats is a thing, so a starter is what it needs.
- **One Thing (phase 2)** keeps the name `Fixture` and `memory.fixtures`: the mug and other objects are fixtures with `place: 'sightings'`, and the main zone is the rule `main`. `WatchKind` and the two limits stay as they were. See [one-thing.md](one-thing.md#as-built).
- **Not done:** `bench:track`'s stats column and marked `<clip>.stats.json` intervals; the demo monitor's lit screen; room badges on the room's picture (`IllustrationView`), which draw on the model view only; checking the card, badges and overlay in the running app and in `bun run browser`.

## Open questions

- **Activity at room scale.** Is a rough mouse level worth showing, or should activity wait for a close desk camera? Measure on a marked clip before shipping its badge.
- **Learned looks drift.** Daylight changes a monitor's surround over a day. The ratio to the frame's mean may be enough; if not, let a confident entity state or a person's correction relearn the look.
- **Sips, not lifts.** Telling "drank" from "moved" needs the mug's height in the frame while held, which the corner camera can't resolve. Leave it as "used".
