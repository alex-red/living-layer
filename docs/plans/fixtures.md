# Plan: fixtures

Status: built, see [As built](#as-built). Builds on [workspace.md](workspace.md), [iso-models.md](iso-models.md) and [photo-scene.md](photo-scene.md).

## Goal

A person can add the things in a room that _do_ something, or that just belong there, as first-class parts of the scene:

1. **Start from a photo of the thing.** A computer mouse, a desk lamp, a wall switch. One photo in, a voxel model out.
2. **Put it in a room.** The office or the office desk, standing on the floor or on a surface.
3. **Say what it is.** A light, a switch, or nothing to control. A light or switch is tied to one Home Assistant entity, can be switched from the inspector, and can be the target of a rule.

**Objects move, fixtures stay.** Objects (the mug, the book) are followed by the camera and decide rules. Fixtures are placed once by hand, never tracked, and are what rules act on. That one sentence is the distinction the UI should teach.

## Naming

The offline mode used to be called `fixture` in code. It is now `demo` everywhere, matching the UI's **Demo | Live**: `modeSchema = ['demo', 'live']`, `DEMO_LIGHTS` (`light.demo_desk`, …), `apps/server/src/demo.ts`, and test data under `testdata/`. The SQLite store and browser saves migrate old `fixture` data on load. "Fixture" now means only the feature below.

## Data model (`packages/domain/src/fixture.ts`)

```ts
export const CONTROL_KINDS = ['none', 'light', 'switch'] as const;
export const entityIdSchema = z.string().regex(/^(light|switch)\.[a-z0-9_]+$/);
export const fixtureControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({ kind: z.literal('light'), entityId: z.string().regex(/^light\.[a-z0-9_]+$/) })
    .strict(),
  z
    .object({ kind: z.literal('switch'), entityId: z.string().regex(/^switch\.[a-z0-9_]+$/) })
    .strict(),
]);

export interface Fixture {
  id: string; // uuid
  label: string; // "Desk lamp", "Mouse"
  /** Which scene it lives in: the room (office) or the view (office desk). */
  room: 'room' | 'view';
  /** Tile space of that scene; `surfaceId` when it stands on one, else the floor. */
  at: { x: number; y: number };
  surfaceId: string | null;
  turns: 0 | 1 | 2 | 3;
  /** Footprint and height in tiles; the model is scaled to fit. */
  size: { w: number; d: number; h: number };
  model: SavedItem; // the same IsoItem the item editor edits
  /** The reference photo's run, so the editor's "Photo vs model" overlay works. */
  reference: { runId: string; asset: string } | null;
  control: FixtureControl;
  /** Last confirmed state, for drawing; never a verdict. */
  state?: 'on' | 'off' | null;
  createdAt: string;
}
```

- `DeskMemory.fixtures?: Fixture[]`, at most `MAX_FIXTURES = 12`. Reset keeps them, like the scene and the pin.
- `fixtureSchema` checks the fixture against its scene: inside the grid, and `surfaceId` (when set) is a surface of that scene. `POST /api/scene/save` re-settles fixtures whose surface moved and drops them to the floor when it's gone, the same way `settleGroup` treats tabletop templates.
- **Rules target entities, not just lights.** `PlacementRule.lightId` becomes `entityId` (light or switch), with `fixtureId?` when the target was picked as a fixture. Old rules load with `entityId = lightId`. `ruleInputSchema` accepts either; the outline shows `Mug → Desk lamp` instead of `→ light.desk`.
- **Lamp props.** A template lamp with `role: 'lamp'` stays as it is. The outline lists it under Fixtures as a built-in light (not editable as a model, but its light can be set), so a room shows every switchable thing in one list. Converting template lamps into fixtures is out of scope.

## Generating a fixture from a reference photo

`POST /api/fixtures/draft` (run kind `fixture`). Input: `mode`, an image (upload, live camera frame, or a box on the current scene photo), an optional name hint, `source: 'sampled' | 'spark'`. Nothing is saved; the draft comes back for review.

1. **Name it (Spark, 1 call, `fixtureClassSchema`).** The main thing in the photo: `label`, `archetype`, `material`, a loose `box` in thousandths, a suggested `control` kind (`light` for lamps and bulbs, `switch` for plugs, fans, wall switches, `none` for a mouse) and a typical real size in cm. Skipped for `sampled`: the hint names it and `archetypeOf` guesses.
2. **Mask it (SAM, 1 call).** `segmentBoxes` with Spark's box (or the person's box), labelled by the fixture's id. With no box, a concept prompt of the label. The biggest detection wins; none is a refusal: "Couldn't find the mouse in the photo. Try one thing, filling most of the frame."
3. **Model it (local).** `maskedCrop` → `fitItem`, exactly as `POST /api/item/draft` does. Extract the body of that handler into `draftModel(crop, label, archetype, material, elevation, meta?)` in `item.ts` so both routes share it, including the Spark render check (step 4 there, 1 more call).
4. **Size it.** Spark's real size → tiles via the room's scale (a desk is 4 tiles for ~120 cm); clamp to the template size range. The person can change it in review.

Worst case is three Spark calls and one SAM call; a draft today's spending limit can't cover is refused before any call, like `scene/from-photo`.

**The fitter needs one more archetype.** A mouse, a remote, a switch plate or a router is neither a lathe nor a book: it's a flat silhouette with a rounded top. Add `device` (family `box`, or a new `extrude` family built on the existing `extrude` part shape): the mask's top-down outline extruded to a measured height, edges rounded, colour clustered as today, a decal for buttons and logos. `archetypeOf` maps `mouse|remote|switch|plug|router|speaker|keyboard` to it. Add a `lamp` archetype too (lathe base, tube neck, cone shade) so a photographed lamp looks like one. `bun scripts/fit-bench.ts` gets synthetic mouse and lamp crops.

**Demo mode.** A bundled illustrated mouse (`apps/web/public/mouse.svg`) and lamp, each with a fixed `fixtureClass` and a mask drawn from the SVG's shapes, like the desk. No network calls. The demo's virtual entities grow to `light.demo_desk`, `light.demo_shelf`, `light.demo_fridge`, `switch.demo_fan`, `switch.demo_monitor`.

## Saving, moving, controlling

| Route                        | Does                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/fixtures/save`    | Create or update one fixture (model, room, place, size, control). Checks `fixtureSchema` against its scene and the entity against config. |
| `POST /api/fixtures/delete`  | Removes it; rules that targeted it keep their `entityId` and lose the `fixtureId`.                                                        |
| `POST /api/fixtures/control` | `{ id, action: 'on' \| 'off' }`. Light and switch only. Recorded as a `lamp` run (rename to `control`), same evidence shape.              |

- **Home Assistant.** `HA_SWITCH_ENTITY_IDS` beside `HA_EXTRA_ENTITY_IDS`. `LampAdapter` becomes `ControlAdapter`: the service domain comes from the entity prefix (`light/turn_on`, `switch/turn_on`, and `turn_off` for both), brightness/colour only for lights, the same state poll, and it still refuses any entity not in config. `LampResult` keeps `physicalEffectVerified: false`. `/api/status` lists configured lights and switches so the UI only offers real ones.
- **Rules** call the adapter with the rule's `entityId`. Nothing else in `ruleGate` changes.

## UI

### Outline

```
SCENE
▾ Office ✓
  ▾ Office desk ●
    Desktop ✓
    ◆ My mug
    ＋ Add object
  FIXTURES
    ◇ Desk lamp      light · on
    ◇ Mouse
    ＋ Add fixture
RULES
  Mug → Desk lamp
```

Fixtures are grouped under the room they belong to, with a hollow glyph (`◇`) so they read differently from tracked objects (`◆`). Selections gain `{ kind: 'fixture', id }` and `{ kind: 'new-fixture', room }`, with hashes like the others.

### Add fixture: photo first

The inspector for `new-fixture` opens on one big drop zone, not a form:

> **Start from a photo of the thing.**
> One thing, filling most of the frame, on a plain background. A mouse, a lamp, a wall switch.
> [ Take a photo ] [ Upload ] · or paste an image
> _or_ Box it on the desk photo · Start from a template

- **Take a photo** uses the live camera the canvas already has (`useCamera`), one frame.
- **Box it on the desk photo** lets you drag a box over the current scene photo, for things already in view. That box goes straight to SAM, skipping Spark's box.
- **Start from a template** is the fallback, kept small: a lamp, a switch plate, a box.
- In demo mode, the drop zone shows the illustrated mouse and lamp as the photos to pick.

While it runs, the steps show in plain words with the activity drawer underneath: _Naming it… Finding its outline… Modelling…_

### Review

Reference photo beside the model render (the item editor's `Photo vs model` overlay), then, in order:

1. **Name**, prefilled from Spark.
2. **What is it?** A segmented control: **Light · Switch · Just a thing**, preselected from Spark's suggestion with a line saying so ("Looks like a light"). Light and Switch reveal an entity picker of configured entities only; with none configured, "Add a switch entity in Setup" and the save still works as Just a thing.
3. **Room**: Office or Office desk, default the one selected.
4. **Place it**: the canvas switches to that scene with a ghost of the model following the pointer; click to drop (snaps onto a surface under it, else the floor), `R` turns it. `Edit model` opens the existing item editor on the fixture's model.

### Inspector for a fixture

Name, room, control kind and entity (editable), size, `Edit model`, `Move`, and for lights and switches a **Turn on / Turn off** button with the last result (accepted, state confirmed). In live mode that button is gated by `HA_LIVE_ENABLED` like the lamp test.

### Canvas

Fixtures draw as voxel sprites in the iso scene, depth-sorted with the props (one box per fixture). A light fixture warms amber only once an action on its entity is confirmed, the existing rule for lamps. A switch shows a small on/off pip in the label, never amber. Dragging a selected fixture moves it, and it settles onto surfaces like tabletop templates.

### Rule editor

The target picker lists fixtures with controls first (by name), then any other configured entity.

## Code

- `packages/domain/src/fixture.ts`: schemas, `MAX_FIXTURES`, `settleFixture`, `fixtureBox` for depth sorting, the rule migration.
- `packages/domain/src/iso-archetypes.ts`, `item-fit.ts`: `device` and `lamp` archetypes.
- `apps/server/src/fixture.ts`: draft, save, delete, control routes. `item.ts`: extract `draftModel`. `lamp.ts` → `control.ts`. `meta.ts`: `fixtureClass`. `config.ts`: `HA_SWITCH_ENTITY_IDS`.
- `apps/web/src/workspace`: outline group, `FixtureInspector` (split out of `Inspector.tsx`, already 1200 lines), selection kinds, `useLabState` actions. `apps/web/src/iso`: draw and drag fixtures in `IsoScene`, place mode in `IsoView`.
- `session.ts`: fixtures are part of the saved session and undo.

## Build order

1. ~~Rename the demo mode.~~ Done: tests green, no behaviour change.
2. ~~Domain: `Fixture`, control kinds, `entityId` on rules with migration.~~ Done: `packages/domain/src/fixture.ts`, `upgradeMemory` on every load, reset keeps fixtures, scene saves settle them, `tests/fixture.test.ts`. Rules accept a switch entity, but the server still only allows configured lights until step 3.
3. ~~Control adapter with switches; `/api/fixtures/control`; status lists entities. Tests with a fake HA.~~ Done, with `/api/fixtures/save` and `/delete` too. The run kind stays `lamp` and the result type `LampResult`, now with an `action`, so stored evidence and the activity filters are unchanged.
4. ~~`draftModel` extraction (no behaviour change, `tests/item.test.ts` green), then `/api/fixtures/draft` in demo mode with the illustrated mouse.~~ Done. The mouse is modelled as a `box` until step 7 adds `device`. Live drafts answer 501 until step 6. The demo lamp picture waits for the `lamp` archetype in step 7.
5. ~~Outline, add-fixture flow, review, place, inspector, canvas drawing.~~ Done, and tried by hand in the running lab: draft the demo mouse, place it on the office desk, make it a switch, turn it on, turn it, delete it. The browser test covers drafting and placing the mouse; the lamp and the rule wait for the demo lamp picture (step 7). `Edit model` for fixtures isn't built: the item editor still only edits objects. Seen from above, the box fitter makes the mouse far too tall; step 7's `device` shape should take its height from the real size.
6. ~~Live: Spark `fixtureClass`, SAM box prompt, the cost refusal.~~ Done, tested against a mocked Meta API; not yet tried against the real one. "Box it on the desk photo" isn't built: drafts come from a photo of the thing only.
7. ~~`device` and `lamp` archetypes and fit-bench cases.~~ Done. The mouse fits at IoU 0.94; lamps reach about 0.85 and are a known gap in the bench.
8. ~~`docs/architecture.md`: a Fixtures section; "As built" here.~~ Done.

## As built

Built as planned, in eight steps, with these differences:

- **Naming.** The demo mode is `demo` in code; old `fixture` data in SQLite and browser saves is migrated on load.
- **Run kind.** Switching a fixture is recorded as a `lamp` run with an `action`, not a new `control` kind, so stored evidence and the activity filters didn't change. Drafting one is a `fixture` run.
- **Routes.** Save and delete came with the control step (3), so control could be tested against saved fixtures. `GET /api/fixtures/reference` serves a draft's photo for review.
- **Shapes.** A `device` is a new `flat` family scored from above, not a `box`: the fitter's camera looks from the iso corner and would see a top-down photo turned 45°. A lamp reads its camera angle from its base, and rim angles now use only rows up to the widest point (the fit bench moved only for the tapered cup, 0.961 → 0.952).
- **The demo lamp** is drawn from a little above, so its rims show as ellipses as in a real photo; a flat side view lost the base.

Added after the first build:

- **Box it on the desk photo.** `POST /api/fixtures/draft` takes a `box` in thousandths. Live, the desk photo goes with it: Spark sees only the boxed part (with a 15% margin) and SAM outlines the thing from the person's box on the whole photo; the review shows the boxed part. The model is fitted at the pinned camera's angle. In demo mode the box picks the illustrated desk's mug, book or bottle it overlaps most, with no model call.
- **Edit model.** `modelTarget` and `setModel` find fixtures too, so the item editor's save, refit (keeping a flat model's height) and photo overlay work on a fixture. Drafting from a sighting is refused for one: its model comes from its photo.
- **Built-in lamps.** Lamps that are part of a room's layout are listed under Fixtures (once, though the office desk's lamp is in both the office and its close view), and can be switched: `POST /api/fixtures/control` takes an `entityId` instead of a fixture. Lamps glow by each light's newest confirmed state, from a switch, a rule or the mug's zone (`lightStates`).

Not built:

- Lamps fit at about 0.85 IoU, under the 0.9 target.
- In demo mode, a box on the desk is matched against the mug where the illustration first draws it, not where it was moved to.
- Live drafting is tested against a mocked Meta API only, and the browser test for drafting and placing the mouse hasn't been run.

## Open decisions

- Control kinds: just light and switch for now? Fans, covers and media players would each need their own actions.
- Should a fixture be trackable later (a mouse does move), or stay strictly placed by hand?
- Fridge scene: a room fixtures can go in too, or office and office desk only?
