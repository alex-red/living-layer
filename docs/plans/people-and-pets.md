# Plan: people and pets

Status: phase 1 built (November 4; see _As built_ below). Phases 2 and 3 are planned.

The home has people and animals in it, not only furniture and mugs. A person wants to add the household once ("Robin", "Miso"), see each one in the room as a small figure, and later have the camera say where they are: who is on the sofa, whether the cat is on its tree, whether the dog is in the kitchen, and tell Home Assistant.

Phase 1 is models and adding them by hand, and it is what the demo needs. Following them with the camera comes after, and is a harder problem than following a mug (see _Why following is different_).

## What there is already

- **A cat Thing.** The `cat` starter (`STARTER_TEMPLATES`, `STARTER_META` in `fixture.ts`) builds `catItem` (`iso-archetypes.ts`): 9 parts (blob body, chest, head; lathe ears; rbox paws; tube tail), with `idle` (26 × 28 × 32 cm) and `sleeping` (28 × 26 × 18 cm) states seeded by `defaultFixtureStates` and rebuilt by `stateVariantModel`. The `cat-tree` starter, its `occupied` stat, `occupantOf` (`stats.ts`: `cat`, `dog`, `person` as the concept SAM is asked for), the coach's `cat` topic and the demo day's cat-on-tree spans all exist.
- **No person or dog.** `WORDS` sends `pet` to the cat, so a "dog" falls to `generic`. `person` appears only as an occupant concept and as "set by hand" (`StatNow.source`).
- **The kernel can draw a figure.** `MAX_ITEM_PARTS` (24) already names "a person" in its comment. But parts join by hard union (no blend) and can't be rotated, so limbs that lean must be `tube`s. A model with more than 12 parts is drawn twice as fine in the room (`roomSpriteLook`), and a tall thin one up to 3× (`detailResolution`).
- **Sitting on things.** `variantItem` (`thing-variant.ts`) already merges an occupant's parts into the thing it sits on (the cat on its tree), within 24 parts. A chair is a prop, so it has to be made a Thing first (`promoteGroup`, `promoteBuiltIn`), as `add_state` does.

## Decisions

- **A name is all it takes.** Adding a member asks for a name and nothing else. Every other choice has a default: the kind comes from which menu item was picked (_Add a person_, or _Add a pet_, which is a cat, with a one-tap _Cat · Dog_ switch beside the name), the look is a default, the pose is `standing` (or `idle` for a cat), and the member stands where it is placed. There is no look editor in phase 1.
- **A member is a Thing.** People and pets are fixtures with a starter `type` (`person`, `cat`, `dog`). There's no new store and no separate list. Being one of these types makes it a **member** (`MEMBER_TYPES`, `isMember(thing)` in `fixture.ts`). The outline shows members first, as _Who's home_, and their panel puts the name first.
- **Default looks, varied by name.** Each kind has a handful of preset looks (a person: four of skin, hair and clothes; a cat: orange tabby, grey, black and white; a dog: golden, brown, black). The preset is picked from the name's hash when the member is made, and kept on the thing (`look`, the preset's key), so two people don't come out the same, renaming keeps the look, and a pose change rebuilds in the same look. The studio can still edit the model by hand; a hand-edited member keeps its own model across pose changes only where the poses share parts.
- **No model calls to make one.** A member is built by code, never sculpted or fitted to a photo, so no photo of a person goes to Spark or SAM to model them. A member's name stays on this machine and out of every prompt.
- **Poses are states.** A person is `standing` or `sitting`; a dog `standing` or `lying`; the cat keeps `idle` and `sleeping`. Phase 1 switches them by hand from the panel; later the camera does.
- **Seated means merged into the seat.** A person set on a chair, sofa or bed is drawn as part of that thing's model (`variantItem`), not as a figure beside it, so depth is always right. The seat is made a Thing if it isn't one, gets a state per member sitting on it, and the member is drawn by the seat while seated (`seatedOn`, the seat's id); standing up draws the member on its own again, in front of the seat.
- **Real sizes.** An adult is 170 cm, about 45 × 28 cm across: 1.5 × 1 tiles, 5.7 tall (as built, chibi figures stand about 150 cm: see _As built_). A medium dog is 70 × 30 × 55 cm. As with every template these are measurements, not values picked to fit the room.
- **Stylised, readable at room size.** An adult is a little chunky (head about a sixth of their height, slightly big hands and feet), so it reads at room scale, where thin parts vanish between voxels. They use the `clean` finish like every Thing. Judge them with `bun run model starter:person --preset room` beside the cat, not in a screenshot.
- **A child is its own build, not a small adult.** Same parts, other proportions: about 110 cm, head about a quarter of their height, shorter legs, rounder face. It comes after phase 1 as a look a member can be switched to from its panel (`child`), so adding one still takes only a name.

## Phase 1: the models, and adding a member by name

### 1a. Builders (domain)

In `iso-archetypes.ts` beside `catItem`, as standalone builders like `catTreeItem` and `floorLampItem`, not new archetypes. A photo is never fitted to a person, so `ARCHETYPES`, `defaultFit` and the fitter stay as they are.

- **`personItem(look, pose)`**, about 16 parts, facing +x/+y (towards the room's camera): legs as rboxes, shoes; hips and torso as rboxes with a small radius, shirt and trousers in their own colours; arms as `tube`s hanging a little out from the body; hands as small blobs; neck; a blob head; hair as a blob over the head's top and back. `sitting` bends at the hip and knee for a 45 cm seat, arms forward onto the lap, and its parts are what `variantItem` merges into the seat; it is never drawn on its own, so the panel only offers _Sit_ when a seat is under them.
- **`dogItem(look, pose)`**, about 12 parts: body blob, chest blob in the accent, a snout (a small rbox and a nose), head blob, floppy ears as small flat rboxes, four rbox legs, a tube tail. `lying` tucks the legs under the body like the sleeping cat.
- **`catItem`** takes `look` the same way (body, accent, and the `stripes` paint for a tabby).
- **Looks** (`MEMBER_LOOKS`): each kind's presets as plain colour sets, drawn from tones that sit with the room's palette, checked with the colour audit for specks. `lookFor(kind, name)` picks one by the name's hash.
- `WORDS`: `pet` stops meaning cat; `dog`/`puppy` names the dog. `fixtureType` recognises a person by its `hair` and `torso` parts and a dog by its `snout`, so `retypeFixture` and the panel's _Type_ work.
- **Seat parts budget.** A chair's parts plus a sitting person's must fit in 24 (`MAX_ITEM_PARTS`). Measure the chair's, sofa's and bed's promoted models first; if a sitting person doesn't fit, the seated parts are a reduced set (legs as one rbox each, no hands), about 10.

### 1b. Starters and the Thing

- `STARTER_TEMPLATES` and `STARTER_META` get `person` and `dog`. TypeScript then points at every place that lists starters: the panel's catalog, the studio's presets, `scripts/lib/models.ts`, `starter-prints.ts`. `defaultFixtureStates` seeds the poses with their sizes; `stateVariantModel` and `starterTemplateModel` get branches for them.
- `look` (the preset key) and `seatedOn` go on `fixtureInputSchema` (it's `.strict()`, and `deskMemorySchema` parses through it), both optional, so saved cats with neither still load and draw as they do.
- `TYPE_STATS`: none on by default for a member.

### 1c. Adding one in the lab

- The outline's **＋ Add** menu gets _Add a person_ and _Add a pet_ beside _Follow it with the camera_ and _Place a fixture by hand_. Each opens one field, the name, with the default model drawn beside it as it updates (the look follows the name as it's typed). Enter or _Place it_ hands over to the same ghost placement as a fixture: it follows the pointer onto the floor or the highest surface under it, until a click.
- Placing a person over a chair, sofa or bed seats them there (the seat is promoted, the variant made); anywhere else they stand.
- The member's panel is the fixture panel with the name first, then _Sit_ or _Stand_ (a pet's two poses), _Turn_, _Move_ and _Delete_. _Type_ and _Model_ stay further down, as for any thing.
- Members go first in the outline (_Who's home_, `sceneOutline.ts`), each with a small sprite at the `thumb` preset.
- **Server.** No new route: the panel saves through `POST /api/fixtures/save` with a starter draft (`starterFixtureDraft`), as the starter catalog does. Seating is a save of both things in one memory update (`store.updateMemory`), through one new request field or a small `POST /api/fixtures/seat` if the save can't carry two things; if it's a route, it goes in the fixtures plugin, `requests.ts`, `routes.ts` and `tests/routes.test.ts`.

### 1d. The demo

- The demo office gets a household in its fresh memory: a person (named "Robin") seated on the desk chair, and the cat ("Miso") `sleeping` by the bookshelf. They are things in desk memory, drawn in the iso room only. **The demo camera's frame stays as it is:** `demoFrame` renders the preset's solids and the mug, and putting a member there would change `demoSegmentation`, the goldens and the room bench at once. That's phase 3.
- `bun run reset demo` brings the household back. The seeding only adds the defaults when the demo has no member yet, so members someone added are kept.
- Optional, if it reads well: the day replay (`demoDay.ts`, `IsoView`'s `REPLAY_SPOTS`) moves the cat between its spot and the tree when `cat` is on, the way it moves the mug now. Replay only, no watcher.

### 1e. Checks

- Goldens in `tests/golden/people/`: `person` standing, `person` seated on the chair, `dog` in each pose, the cat in a second look, at the room's resolution, as `tests/model.test.ts` draws the floor lamp. Look at the PNGs before committing.
- Unit tests (`tests/members.test.ts`): a member made from a name alone has its real size in tiles, its default pose and a look picked from the name; the same name always picks the same look; renaming keeps it; changing pose keeps it; seating a person on a chair merges them into the chair's model within 24 parts and standing up draws them alone again; a saved cat with no `look` still loads; `retypeFixture` from a cat to a dog keeps the place.
- `bun run sheet --turns 0 --audit` on the new models (no specks), and `bun run model starter:person starter:person:sitting starter:dog starter:dog:lying starter:cat --preset room --turns all` side by side for the look.

### As built

- **Code.** The builders are in `member-models.ts` (`personItem`, `sittingParts`, `dogItem`), the kinds and looks in `members.ts` (`lookFor`, `memberItem`), sitting in `seating.ts` (`seatPerson`, `standUp`, `seatNear`, `drawnFixtures`), the starters and `memberDraft` / `memberInput` in `fixture.ts`. `POST /api/fixtures/seat` sits a person down (a chair of the layout is promoted first) or stands them up; deleting either one stands them up. Tests: `tests/members.test.ts`, goldens in `tests/golden/people/`.
- **Seating doesn't use `variantItem`.** It keeps the occupant's biggest few parts and the subject's rest, which suits a cat on a tree, not a person on a chair. `seatedModel` keeps every part of the person (about 11, no neck or hands) and the chair's biggest of the rest (it drops the casters). The seat's facing comes from its model: away from its tallest part.
- **The demo household is opt-in.** `bun run reset demo --household` (`POST /api/desk/demo/reset` with `household`) seats Robin in the office chair and puts Miso to sleep by the shelf. A plain reset stays as it was, so the demo video's shots, which start from one, don't change.
- **Chibi, not life-like.** A first, life-proportioned person read as a thin stick at room size. They are now chibi, in the spirit of classic isometric hotel-game avatars without copying any: a round head a third of their height with big dot eyes and rosy cheeks, a short round body, stubby arms, big shoes. That puts a standing person at about 150 cm, shorter than life. The dog has a big head and short legs, and the cat (the catalog's too, through `catParts`) sits up with a face, or curls up asleep with its tail round it.
- **No black coats.** The demo's floor is dark, so a black cat or dog read as a hole; the looks are ginger, grey and cream cats, and golden, brown and white dogs.
- **Not built:** the day replay moving the cat, sofas and beds as seats (there are no templates for them yet; a Thing named like one with a back is a seat).

## Why following is different

The watcher was built for a small rigid thing that sits still and is carried (`watch.ts`, `tracker.ts`). A person or a pet is large, bends and moves for long stretches, so most of its rules go wrong:

- **The template is rigid and doesn't scale.** NCC on a fixed grey template drops under 0.6 as soon as a person turns or sits or a cat curls up; appearance search tries the old box's size only.
- **Settling gates everything.** The room only moves a thing, and SAM is only asked, once its region has been still for about 0.4 s. A person crossing the room never settles in view.
- **Missing is normal.** People and pets leave the room. Three empty re-anchors mark a thing `missing`, which is an error state; for a member it should read _away_, and `device_tracker` should say `not_home` without anyone being lost.
- **Size clamps.** `projectBox` clamps to two tiles (60 cm) high; `believableWidth` has a cat but no person.
- **They disturb the rest.** A person walking past covers other things, starts their motion checks and can look like a moved camera (`cameraMoved` already notes someone close to the lens).
- **Privacy.** Following means frames with people in them go to SAM. That stays behind _Let tracking call AI_, like the rest of tracking, and nothing identifies a face: members are told apart by where they were and their clothes' colours, never by face recognition.

## Phase 2: where members are, from the camera

- **Presence first, not paths.** A member's **place** is the zone or the thing they're at (the sofa, the desk, the cat tree, _in view_, _away_), not a box followed from frame to frame. It comes from what exists: `occupied` on things and zones (local feature difference against the empty look, SAM for `person`/`cat`/`dog` once tracking may call AI), each stat crediting the member when there is only one of that kind at home, and asking _Who is this?_ on the card when there are two. A member credited to a seat is seated in it, which is the same variant as phase 1.
- **A `member` sighting path in the watcher** for when a box is wanted: the concept's SAM box (or the local outline) through the calibrated `RoomCamera`, foot at the box's bottom centre unprojected onto the floor (`unprojectRoom(camera, foot, 0)`, as `sightingBox` does), height from head to foot. A box whose bottom touches a seat is a member sitting there, not a floor point behind it. Its own constants: no stillness gate for moving the drawing, a much lower cadence for SAM (a member moving is expected, not a reason to look again), `away` after it leaves the frame through an edge, and other things' covered and motion checks ignoring the member's box.
- **Pose from the box:** tall and narrow standing, short and wide at a seat sitting, low and long lying; the state follows, `followStats` style.
- **Home Assistant:** each member can be shown as a `device_tracker` (its place, `home`, `not_home`) and an `event` (arrived, left); the `person.*` entities Home Assistant already has (phones) can be read as a second source of _home or away_ once `ha-live.ts` reads them (only `light`, `switch`, `fan`, `input_boolean` today).
- **Bench:** `bun run bench:track` on a captured clip of a person walking in and sitting down, marked with `truth` (where they sit, when they arrive and leave), scored as place and time, before any constant is tuned.

## Phase 3: members in the demo camera

- Members' parts as solids in `demoFrame` and `demoCloseUp`, the frame key widened from the mug's spot to the mug's spot plus each member's, `DEMO_CONCEPTS` learning `person`, `cat` and `dog`, and a `DemoSource` that walks them through scripted spots, so the demo shows phase 2 end to end without a network call. That changes the demo frame for every test that reads it: one change, with goldens, `bench:room` and `bench:track` run before and after.
- The brush: _"this is Miso, our cat"_ on a selection becomes a member (`create` with `as: 'member'`, the type from `occupantOf`), with its case in `INTENT_CASES` and its demo pattern, as the op checklist in `AGENTS.md` lays out.
- Scans: the inventory prompt lists people and pets apart (a `member` role) and the layout skips them, so a person on the sofa never becomes furniture and their feet aren't read as a near side.

## Later

- **Children** (see _Decisions_): the `child` build, switched to from the member's panel.
- **Choosing a look**: swatches for skin, hair and clothes, or coat and ears, for someone who wants their figure to look like them. The name-picked default stays the starting point.
- **Where is everyone, across rooms**: on the [roadmap](current.md#roadmap). A home today is one room and one camera per mode (`memory.scene`, `memory.camera`).
