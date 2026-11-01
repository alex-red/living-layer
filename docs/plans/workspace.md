# Plan: a scene-first workspace

Status: built, see [As built](#as-built). Replaces the probe bench and the side tabs. Builds on the scene picker (commit `3010e02`) and [photo-scene.md](photo-scene.md).

## Goal

Someone opens the lab for the first time and knows what to do without reading anything:

1. Set up the **office**: photograph the room, or use the demo office.
2. Set up the **office desk**: a close photo or the live camera, pinned to the desk you just placed.
3. Pick the objects on the desk to remember.
4. Write a rule: _when the mug is in this zone, turn on the lamp_.
5. Watch it work.

Every control lives next to the thing it changes. Model names, prices and evidence are still one click away, but they no longer drive the layout.

## What's wrong today

The current screen has four navigation systems, and none of them says where you are:

| Where         | What it holds                                                                         | Organised by        |
| ------------- | ------------------------------------------------------------------------------------- | ------------------- |
| Probe bench   | Steps 00–04: scene, Discover, Segment, Remember & place, Test one light               | Which API is called |
| Stage toolbar | Photo / Iso, Office / Office desk, Surface, Guess scene, Pin surface, Clear pin, Mask | Mixed               |
| Iso tabs      | Room, Edit scene, Objects & rules, Model                                              | Editing mode        |
| Side tabs     | Runs, Inspect, Session, Setup                                                         | Developer tools     |

Specific problems:

- **Scene first in name only.** Step 00 picks a scene, but setting it up (photo, draft, pin) is buried in the iso view's _Edit scene_ tab and a _Pin surface_ button. The only hint is a footnote under the canvas: "Pin the desktop on a photo to place objects here."
- **Office and Office desk look like peers.** They sit side by side as tabs. Nothing says the desk is a close view inside the office, that it shares the office's desktop pin, or that the office should come first.
- **Steps follow the models, not the job.** "Discover (Spark)", "Find the shape (SAM 3.1)", "Remember & place (Zone)", "Test one light (HA)". A person wants _find the mug_, not _run SAM_.
- **Step 03 is a whole app.** Identity, freshness, Capture & track, Follow locally, a fixed-camera checkbox, Draw zone, a status line, Verify placement, a 13-row movement log and Reset desk memory, all in one card.
- **Raw state as prose.** "STALE: segment a new frame. · Segment and confirm the current frame to continue." and "LIVE · blocked · lamp none".
- **A price on every step.** Useful in live mode, noise everywhere else.
- **The right column opens on Runs**, the 200-row evidence tape, which is for judges and debugging, not for doing the task.
- **Fixture / Live sits at the top of the step list**, as if it were step zero.

## The new layout

Three columns and a drawer, the same model as a design tool: an outline of what exists, a canvas, and the properties of what's selected.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ◉ Living Layer   Office ▸ Office desk ▸ My mug     [Demo|Live]  ● $0.09/$1  ⋯ │  top bar
├──────────────┬──────────────────────────────────────────┬─────────────────────┤
│ SCENE        │  [Photo | Iso | Split]        Layers ▾   │ MY MUG              │
│ ▾ Office  ✓  │                                          │ ✓ Confirmed         │
│   ▾ Desk  ●  │                                          │ Seen 40 s ago  ◔    │
│     Desktop ✓│              canvas                      │                     │
│     ◆ My mug │                                          │ [ Capture & track ] │
│     ◆ Book   │                                          │ Follow locally  ○   │
│     ＋ Add   │                                          │                     │
│   Shelf      │                                          │ MODEL   ▣ fitted ›  │
│ RULES        │                                          │ HISTORY 13 ›        │
│  Mug → lamp  │                                          │                     │
│  ＋ Add rule │  ● camera   [Capture frame] [Stop]       │                     │
├──────────────┴──────────────────────────────────────────┴─────────────────────┤
│ ACTIVITY  ✓ segment · 12 masks · 0.8 s · $0.0025        200 runs · 1 failed ▴ │  drawer
└───────────────────────────────────────────────────────────────────────────────┘
```

### Top bar

- Product mark, then a **breadcrumb** of the selection (`Office ▸ Office desk ▸ My mug`). It's the "where am I" the screen lacks today.
- **Demo | Live** segmented control. Rename _Fixture_ to _Demo_ in the UI; the code and tests keep `fixture`.
- **Budget pill**: spend today against the limit, with a dot for Meta readiness. Clicking it opens the readiness popover (today's _Setup · 2/4_: models, Meta key, lamp, live proof, the text smoke test and the lamp test).
- **⋯ menu**: Save now, Export save, Import save, Undo, Redo, Shortcuts, Export evidence, Camera playground, Reset everything to demo. This empties the _Session_ tab.

### Left: the scene outline

A tree, top to bottom in the order you set things up. Each row has a status glyph (`✓` done, `●` current, `◌` needs something, dimmed when locked) so the outline doubles as the checklist.

```
SCENE
▾ Office                 ✓ room photo · layout · 4 props
  ▾ Office desk          ● close view · needs a pin
      Desktop (surface)  ◌ not pinned
      ◆ My mug           ✓ tracked
      ◆ Green book       ◌ suggested · Track
      ＋ Add object
    Bookshelf top (surface)
RULES
  My mug in zone → Desk lamp
  ＋ Add rule
```

- The office is the root. The office desk is indented inside it and stays locked (dimmed, with "Set up the office first") until the office has a layout. This makes the order visible instead of explained.
- Surfaces sit under the scene they belong to. Objects sit under the surface they stand on.
- Objects that Discover or the photo draft found but nobody confirmed show as **suggested** rows with a _Track_ button. This replaces the _Discovered objects_ grid under the canvas.
- Rules get their own section, since a rule can span surfaces.
- A scene switcher on the root row (`Office ▾`) holds the other rooms (Fridge) and the person's custom scene.

### Centre: the canvas

- **Photo | Iso | Split** view switch. Split puts the photo and the iso side by side, which is the moment the demo is about.
- **Layers ▾** menu: masks, zones, trail, pin corners. This replaces the lone _Mask overlay_ checkbox.
- The canvas shows the selected scene. Selecting a node frames it: a surface highlights its quad, an object highlights its mask and marker, a rule shows its zone.
- **Edit modes take over the canvas** with a small banner and Done / Cancel: pinning corners, drawing a zone, editing the layout, editing a model. Only one at a time. This replaces the iso tabs and _Cancel pin_.
- A **camera bar** along the bottom of the canvas: source (photo, camera, shared camera), privacy dot, Capture frame, Stop.
- Errors stay as the error card over the canvas.

### Right: the inspector

Properties and actions for whatever is selected. One primary button per panel, as [design.md](../design.md#components) already requires. Each panel has the same three parts: **status** (one sentence, plus a glyph), **the next action**, then **details** folded away.

| Selection        | Status line examples                                           | Primary action                     | Details                                                     |
| ---------------- | -------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Nothing / office | "Set up the office to begin."                                  | Set up the office (see onboarding) | Setup checklist                                             |
| Scene (room)     | "Drafted from your photo · 92% match"                          | Review layout                      | Source photo, grid, props, Guess scene, Draft with Spark    |
| Close view       | "Uses the office's desktop. Pin it on a close photo."          | Pin the desktop                    | Parent scene, shared pin, lens guessed or measured          |
| Surface          | "Pinned on a 1280×720 frame"                                   | Re-pin                             | Corners, elevation, Clear pin                               |
| Object           | "Confirmed · seen 40 s ago" / "Seen 6 min ago, may have moved" | Capture & track                    | Follow locally, fixed camera, model, history, forget        |
| Suggested object | "Spark thinks this is a green book."                           | Find its outline                   | Concept text, Test absent target                            |
| Rule             | "Blocked: the mug is outside the zone."                        | Verify placement · turn on lamp    | Object, zone (Draw), inside / outside, light, recent checks |

Writing rules for the status line:

- Plain sentences, never internal tokens. `STALE` becomes "Seen 6 min ago, may have moved". `LIVE · blocked · lamp none` becomes "Blocked: the mug is outside the zone."
- Freshness as a small ring that empties over the 5-minute expiry, with the time beside it.
- Prices appear only in live mode, as `≈ $0.0025` beside the button that spends it, never as a separate paragraph.
- The movement log becomes **History** in the object panel: a count, folded; open it for the rows.

### Bottom: the activity drawer

- Collapsed, it's one line: the latest call (kind, result, duration, cost) and the totals. It flashes nothing; new runs slide into the line.
- Open, it's today's Runs list with its filters, and the run inspector on its right. This is the _Runs_ and _Inspect_ tabs, unchanged inside.
- The status capsule keeps its job for operations in progress.

## Onboarding: scene first

When nothing is set up, the canvas shows a two-card choice instead of an empty frame. The scene picker's job moves here.

**Step 1 · Set up the office**

> **Your office, as a living map.** Start with the whole room. The desk comes next.
>
> [ Photograph your office ] — upload or capture a photo of the room. Spark lists what's in it, SAM outlines it, and you review the layout. _Live, ≈ 2 billed calls._
>
> [ Use the demo office ] — the illustrated office, no key or camera needed.

Choosing a photo runs the existing from-photo draft and opens its review (`PhotoReview`) in the canvas. Saving it marks the office `✓` and unlocks the desk.

**Step 2 · Set up the office desk**

> **Now get close to the desk.** Point the camera at the desktop, or take a close photo. This is the view the lamp rule watches.
>
> [ Use the camera ] [ Upload a close photo ] [ Use the demo desk ]

The draft auto-pins the desktop. The inspector shows the pin's four corners as handles to fix, then _Looks right_. Because the office desk shares the office's desktop pin, the desk in the office's iso view now shows objects too, and the outline says so ("Also shown in the Office").

**Step 3 · Objects** — the desk draft has already suggested objects. Tick _Track_ on the mug. _Add object_ covers anything it missed: type a name, find its outline, confirm the mask. That's today's Discover + Segment + confirm, in one flow.

**Step 4 · A rule** — _Add rule_ opens a sentence builder: `When [My mug ▾] is [inside ▾] [draw a zone] turn on [Desk lamp ▾]`. Drawing the zone uses the canvas edit mode.

**Step 5 · Run** — the rule's panel shows the live check and the lamp button.

After the first run the onboarding cards don't come back; the outline's status glyphs carry the same information. _Use the demo office_ is always available from the scene switcher, and _Reset everything to demo_ stays in the ⋯ menu.

## Where every current control goes

| Today                                              | New home                                                      |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Fixture / Live                                     | Top bar, _Demo / Live_                                        |
| 00 Choose the scene, scene picker                  | Onboarding cards, then the outline's scene switcher           |
| 01 Discover objects                                | Close view inspector, _Find objects_ (details), and the draft |
| 02 Object concept, Segment object                  | _Add object_ flow; suggested object's _Find its outline_      |
| 02 Test absent target                              | Suggested object details                                      |
| 03 Capture & track, Follow locally, fixed camera   | Object inspector                                              |
| 03 Draw / edit zone, Verify placement              | Rule inspector                                                |
| 03 Movement log                                    | Object inspector, _History_                                   |
| 03 Reset desk memory                               | Close view inspector details, and the ⋯ menu                  |
| 04 Turn on desk lamp, text smoke test              | Readiness popover from the budget pill                        |
| Photo / Iso                                        | Canvas view switch, plus Split                                |
| Office / Office desk tabs, Surface select          | The outline                                                   |
| Guess scene                                        | Scene inspector details                                       |
| Pin surface, Re-pin, Clear pin, Cancel pin         | Surface inspector; pinning is a canvas edit mode              |
| Mask overlay                                       | Canvas _Layers_ menu                                          |
| Iso tabs: Room                                     | The canvas's normal state                                     |
| Iso tabs: Edit scene                               | Scene inspector, _Edit layout_ (canvas edit mode)             |
| Iso tabs: Objects & rules                          | The outline's objects and rules                               |
| Iso tabs: Model                                    | Object inspector, _Model ›_ (canvas edit mode)                |
| Discovered objects grid                            | Suggested rows in the outline                                 |
| Runs, Inspect                                      | Activity drawer                                               |
| Session                                            | ⋯ menu                                                        |
| Setup · n/4                                        | Budget pill and readiness popover                             |
| Undo, Redo, Shortcuts, Export evidence, Playground | ⋯ menu (Undo and Redo also stay as icon buttons)              |

Nothing is dropped. Every API call and every saved field keeps working; only where you reach it changes.

## Mobile

Under 768 px, one column, as [design.md](../design.md#space-shape-and-layout) asks:

- The breadcrumb opens the outline as a full-height sheet.
- The canvas fills the width.
- The inspector is a bottom sheet with its primary action pinned in the sticky bottom bar. This closes the "sticky bottom action bar" item design.md lists as still to do.
- The activity drawer becomes a row in the ⋯ menu.

## Code

`App.tsx` is 2,471 lines and holds nearly all state. The rework is the moment to split it, or the new layout will make it worse.

- **Selection.** One `Selection` union (`scene | view | surface | object | suggested | rule | null`) in the URL hash, so a reload keeps your place and tests can deep-link.
- **State out of App.** Move into hooks next to the existing `session.ts`: `useDesk` (memory, undo, saves), `useCamera`, `useRuns`, `useBusy`. App becomes the shell.
- **New components** in `apps/web/src/workspace/`: `TopBar`, `Outline`, `Canvas`, `Inspector` (one file per selection kind), `ActivityDrawer`, `Onboarding`, `ReadinessPopover`.
- **Reuse as is:** `IsoScene`, `MaskOverlay`, `SurfacePin`, `PhotoReview`, `SceneEditor`, `ItemEditor`, `RulesPanel` (its rule form becomes the sentence builder), and the evidence table.
- **Setup status** as a pure function, `sceneProgress(memory, mode)`, returning each node's state and lock reason. It drives the outline glyphs, the onboarding and the breadcrumb, and gets unit tests.
- **Tests.** `tests/browser/lab.spec.ts` (8 tests) finds controls by role and name. Keep button names where the action is the same (_Segment object_ may become _Find its outline_; update the spec in the same commit). Add: onboarding with the demo office, the desk locked until the office is set up, selecting a node shows its inspector, and no horizontal scroll on mobile.

## Build order

Seven days to submission (Nov 4). Each step leaves the app working, and the cut line is after step 4.

1. **Extract state and add `Selection`.** No visible change. Specs stay green. _(day 1)_
2. **Shell:** top bar, outline, canvas, inspector, drawer. Move every control to its new home per the table, with today's wording. _(day 2)_
3. **Onboarding and setup order:** `sceneProgress`, the office-then-desk lock, the demo shortcuts, the two-step cards. _(day 3)_
4. **Inspectors rewritten:** plain status lines, freshness ring, live-only prices, Add object flow, suggested rows. **Cut line.** _(day 4)_
5. **Rule sentence builder** and Split view. _(day 5)_
6. **Mobile sheets** and the sticky action bar. _(day 6)_
7. Update design.md, the README screenshots and the demo video script. _(day 7)_

## Open decisions

- **Can someone skip the office?** The proposal: no in the guided flow, since the desk inherits its pin. _Use the demo office_ is one click, so the lock costs nothing. A desk-only setup stays possible through _Custom scene_.
- **Where does the fridge go?** The proposal: the scene switcher, as a second room with no close view. It isn't part of the demo.
- **Does _Find objects_ (Discover) stay a separate action?** The photo draft already lists objects. The proposal: keep it in the close view's details for a fresh frame, but don't feature it.
- **Split as the default view?** It shows the photo-to-iso link best, but it halves both. The proposal: default to Iso once the office is set up, Split during review.

## As built

The open decisions above went with the proposals: the office can't be skipped in the guided flow, the fridge lives in the room switcher, Discover stays in the Add an object panel's details, and Split is a third view rather than the default.

- **State.** Instead of four hooks, `App.tsx`'s state moved whole into one hook, `workspace/useLabState.ts`, and the panes read it through `LabContext`. Splitting it further is still worth doing, but one move kept every tracking, follow and undo path byte-for-byte.
- **Files.** `workspace/` holds `TopBar` (with the readiness popover and the ⋯ menu), `Outline`, `Canvas`, `Onboarding`, `Inspector` (with `panel.tsx`, `FixturePanel` from [fixtures.md](fixtures.md), and `ExposePanel` from [mqtt.md](mqtt.md)), `ActivityDrawer`, `ToolStrip` / `Brush` / `useBrush` / `AiTaskDialog` (from [ai-brush.md](ai-brush.md)), `ContextMenu`, `Popover`, `progress.ts` and `labels.ts`. `ScenePicker` and `RulesPanel` are gone: onboarding and the inspector replace them.
- **Progress.** `sceneProgress` in `workspace/progress.ts` is pure and tested in `tests/workspace.test.ts`, with the selection's URL hash. Only the desk waits for the room. Objects, the zone and the run are suggestions, never locks.
- **The desk / camera step.** Originally built around a close-photo desktop fitter (`Find the desktop`), then superseded by [corner-camera.md](corner-camera.md): Step 2 in `Onboarding.tsx` is now calibrating the fixed room camera (`POST /api/room/calibrate`), which automatically pins the desk through the calibrated room camera, with `Pin the desk by hand` as fallback. The demo comes calibrated and pinned. A room drafted from a photo gets an _Office desk_ close view too when it has a desk or table (`closeViewOf`: the biggest desktop and everything standing on it, moved to the grid's corner, surface ids kept). Fixtures in a photographed room go in the room, not its desk view.
- **IsoView** is controlled now: the canvas sets its panel (`room`, `scene`, `item`), surface, model target, Spark guess and rule draft. Its own toolbars and tabs are gone.
- **Selection on the canvas.** The selected object is ringed where it was last seen: a solid box on the photo when that is the current frame, dashed for an earlier frame of the same size, and a ring on the floor in the iso room. A selected rule's zone glows.
- **Layers.** A Layers menu over the canvas switches masks, the mug's trail, saved zones, tracking, the room picture and the corner grid, on the photo and in the room. A zone being drawn always shows.
- **Phones.** The outline is a sheet that slides up from the top-bar toggle button and closes when you pick a row or press Escape. The inspector and activity drawer stay in-flow in the single mobile column rather than becoming a bottom sheet or ⋯ menu item; the inspector's primary action button is pinned with `position: sticky; bottom: 12px`.
- **Tests.** `tests/browser/lab.spec.ts` is updated and passing against the workspace and corner-camera flow (commits `c885b88` / `248367f`).
- **Naming.** The rename from "Desk lab" to "Living Layer" across the UI, server and browser spec landed in commit `cf0c068` ([naming.md](naming.md)); `docs/media/workspace.png` and the demo video still await a fresh capture.
