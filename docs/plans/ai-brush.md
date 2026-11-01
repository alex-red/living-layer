# Plan: the AI brush

Status: built, see [As built](#as-built); live calls tested against a mocked API only. Builds on [fixtures.md](fixtures.md), [iso-models.md](iso-models.md) and [corner-camera.md](corner-camera.md).

## Goal

A person draws on the camera's picture, a rectangle or a polygon, and says what they want in their own words:

- _"Turn this into its own fixture. It's an IKEA Alex desk."_
- _"Make this fixture green."_
- _"This lamp is 45 cm tall, not 30."_
- _"This is a light, `light.study`."_

The lab works out what the selection points at, what the sentence asks for, looks up what it needs (the product's real size, its parts, its colours), and builds or changes the model with the tools we already have. The person reviews the result before anything is saved.

The first three things are the tools underneath. The brush and the prompt box come last, once each tool works on its own and can be benched offline.

## The shape of it

```
brush (web) ─▶ Selection ─▶ resolve target ─▶ parse intent ─▶ gather facts ─▶ build / edit recipe ─▶ check ─▶ review ─▶ save
                 frame +        prop, fixture,     Spark,          web, catalog,     local, named parts     render vs      person
                 shape          object or new      EditIntent      photo             FixtureRecipe          mask, Spark
```

Every arrow is one tool with a zod schema in and out, run as one step of a job (`JobTracker`, shown in `AiTaskDialog`). A fixed pipeline calls them in order first. Because each is a tool with a typed contract, an agent loop (Spark choosing the next tool) can drive the same tools later without rewriting them.

## 1. Selection

`packages/domain/src/selection.ts` (built), `apps/server/src/select.ts` (built).

```ts
type SelectionShape =
  | { kind: 'rect'; box: { x1; y1; x2; y2 } } // thousandths of the frame
  | { kind: 'polygon'; points: { x; y }[] }; // thousandths, 3 to 64
```

- **Thousandths**, so zooming and panning the view (`ZoomPan`) don't change a selection. `selectionMask` fills one into a frame-sized mask; `selectionBox` is its bounding box in pixels, for SAM's box prompt.
- **Freeze the frame** (step 7). Starting a brush stroke on a live stream grabs one full-size frame on the server (`frames.ts` already takes a full picture for SAM) and stores it as an asset of the assist run. The selection is tied to that still, so the person draws on what SAM will see. The frame carries its crop, so `cx`, `cy` are not assumed to be its middle.
- **Mask it** (step 7). A rectangle goes to SAM as the box prompt, as "Box it on the desk photo" does today. A polygon goes as its bounding box, and the best detection is cut to the polygon (`clipMask`, built). A polygon that hugs the thing well enough is its own mask when SAM finds nothing.
- **Resolve the target** (`resolveSelection`, built). `roomLabels` renders the room's scene and its fixtures through the calibrated camera, labelled per pixel (`renderRoom` with `labels`), so what is in front hides what is behind. Each thing the selection touches gets two scores: how much of what the camera sees of it is inside the selection (`covered`), and how much of the selection it fills (`fills`). Among things at least 60% covered, the one filling the most wins. Tracked objects are scored by their last box. Floor and walls are never a target.
  - Why two scores: the demo desk fills only a third of its own bounding box (its monitor, lamp and keyboard are inside it), so IoU with the selection can't recognise a box around the desk. "Covered" says the desk is wholly in the box; "fills" says it is the biggest thing there.
  - The answer is a target (`prop`, `fixture` or `object`, with its id and name) or null when the selection is of something the room doesn't have yet, the runners-up with their scores, and `ambiguous` when a runner-up fills at least 60% as much.
  - In the demo: a box around the desk gives the desk (fills 0.23; the chair next best at 0.09), boxes around the monitor, chair, bookshelf and lamp give each of them, a box around the mug gives the tracked mug, and a small box on the bare desktop gives nothing (the desk only 0.08 covered).
- **`POST /api/select/resolve`** `{ mode, shape }` answers this with no model call, against the calibrated camera's frame. Uncalibrated rooms refuse with 409 `not_calibrated`, like every other camera path. Fixtures are drawn where the room's own view puts them (`inRoomView`).
- **Tested against `demoSegmentation`**: every selection in `tests/selection.test.ts` is drawn around the demo's own masks, not hand-picked pixels.

## 2. The recipe: one model format the AI can write and edit

Today a fixture's model is an `IsoItem` (at most 12 parts, a unit footprint) and furniture is a `PropForm` built in code from `FURNITURE_SPECS`. Neither is a good target for generation: an item is too small for a desk with a drawer unit, and a form needs a code change.

`packages/domain/src/recipe.ts` adds a **`FixtureRecipe`**: named parts in real centimetres, data rather than code.

```ts
export interface FixtureRecipe {
  label: string; // "IKEA Alex desk"
  sizeCm: { w: number; d: number; h: number };
  parts: RecipePart[]; // in cm, from the back-left-bottom corner, facing +y
  surfaces?: { part: string; label: string }[]; // tops things can stand on
  sources?: FactSource[]; // where the measurements came from
}
export interface RecipePart {
  name: string; // "top", "drawer-unit", "drawer-1", "panel-left"
  role?:
    | 'top'
    | 'leg'
    | 'rail'
    | 'panel'
    | 'drawer'
    | 'door'
    | 'shelf'
    | 'handle'
    | 'body'
    | 'shade'
    | 'base';
  shape: 'rbox' | 'lathe' | 'tube' | 'blob';
  atCm: Vec;
  sizeCm: Size;
  tone: IsoTone;
  color?: Hex;
  material?: ItemMaterial;
  // shape params as in PropPart: radius, profile, wall, path + tubeCm, rough
}
```

- **Compiles to `PropPart[]`** (`recipeModel` in `iso-furniture.ts`), the same parts the furniture builders return, scaled to the prop's box, so the voxel kernel draws it unchanged.
- **A prop carries its recipe** (`IsoProp.recipe`), and `propModel` draws it in place of a `form`. Camera silhouettes, the room camera's renderer, the room scan and synthetic photos all go through `propSolids` (AGENTS.md), so a generated desk is seen by the camera exactly as it is drawn. `placeRecipe` places one as a group, with a surface on each part it names.
- **Colours of its own.** A part's `color` replaces its tone's colour; the sprite's palette is the room's plus that colour's ramp, so "make it green" stays green instead of snapping to the nearest room tone.
- **Names are the edit handle.** _"Make the drawers white"_ is a selector over `role: 'drawer'`; _"make it green"_ is every part but metal handles. Edits never need the model to re-plan geometry.
- **Starting from a built-in form** keeps it grounded: an Alex desk is close to the desk form with its legs swapped for a drawer unit and a panel. The builder (step 6) will copy a form's parts into a recipe once (`recipeFromForm`, with roles added to the builders that need them) and edit from there, rather than keep a live `base` that later builder changes would move.
- **Look before and after:** `bun run sheet --recipe testdata/recipes/alex-desk.json` renders a recipe at every turn, like any template, and `--audit` runs on it.

**Fixture or furniture?** A recipe is only the model. Where it lives is a choice the review offers: a **fixture** (can be switched, tracked, a rule's target) or a **layout group** in the scene (furniture: `placeTemplate` with a recipe instead of a `TemplateId`, settles things on its top). See [open decisions](#open-decisions).

## 3. Edit operations: a small, closed vocabulary

Two layers. **Recipe ops** (`packages/domain/src/recipe-ops.ts`, built) change a recipe: each is a pure function `(recipe, op) → recipe`, checked by zod, listed in `RECIPE_OPS` with a line saying what it is for. **Intent ops** (step 5) are what a sentence can ask for beyond that: they create a recipe, change a fixture, or ask back. Spark can only pick from both, the same way `sceneDraftSchema` limits layouts to templates that exist.

| Op            | Layer  | Example sentence                    | Does                                                                                  |
| ------------- | ------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `recolor`     | recipe | "make this green", "white drawers"  | sets `color` on the parts a selector picks                                            |
| `rematerial`  | recipe | "the legs are metal"                | sets `material` on the parts picked                                                   |
| `resize`      | recipe | "it's 140 cm wide"                  | the whole model: each part end moves with the nearer edge; or the picked parts, in cm |
| `add_part`    | recipe | "it has a shelf under the top"      | adds one part in cm, inside the model, with a new name                                |
| `remove_part` | recipe | "there's no drawer on the left"     | removes the picked parts and their surfaces, never all of them                        |
| `rename`      | recipe | "call it the standing desk"         | label                                                                                 |
| `create`      | intent | "turn this into its own fixture"    | builds a new recipe (step 6) from the selection and the facts                         |
| `rebase`      | intent | "it's actually a table, not a desk" | builds again from another form (`recipeFromForm`), keeping colours by role            |
| `set_control` | intent | "this is a light, light.study"      | fixture control, checked against configured entities                                  |
| `clarify`     | intent | (anything ambiguous)                | asks one question back instead of guessing                                            |

- **Selectors** pick parts by names, roles and materials (every filter given must match), minus an `except`; an empty selector is the whole model. "Make it green but not the handles" is `{ except: { roles: ['handle'] } }`.
- **Resizing the whole model** keeps parts at their real sizes where it can: on each axis, each end of a part moves with the edge it is nearer, so a desktop stretches, the drawer unit at the right moves with the right edge at its own width, and the side panel stays as thick. If that would make a part end before it starts, that axis scales evenly instead.
- **`applyRecipeOps`** applies a list in order, checks the recipe after each, and stops at the first op that fails with its index and a reason (`No part of the model matches that.`, `top reaches outside the recipe's size.`). The parser can hand the reason back to Spark or to the person.

New abilities are a new op with its schema, apply function and tests. The parser's prompt lists the ops from the registry, so it never needs editing by hand.

## 4. Intent: what the sentence asks for

`packages/domain/src/intent.ts`, `MetaAdapter.intent` and `apps/server/src/demo-intent.ts` (built).

- **One Spark call** with a strict JSON schema, `sparkIntentSchema`: up to four ops in order, the product named (`"IKEA Alex desk"`) or null, what to look up (`needs`: size, parts, colors, materials) and `targetDisagrees`. No Spark schema in the lab uses unions, so each op is **flat**: an `op` name and every field (parts, color, material, sizeCm, part, label, form, as, control, question), null or empty where it doesn't apply.
- **The prompt is built from the registries**: `describeContext` gives the target, its recipe's parts (names, roles, sizes, colours) and the configured entities; `opCatalog` lists every recipe op's and intent op's line. A new op shows up in the prompt by itself.
- **`readIntent` decides what can be done**, not Spark. It turns the flat ops into typed ones (recipe ops through `recipeOpSchema`, the part to add through `recipePartSchema`), and leaves out with a reason anything it can't do: an edit with no model to edit, an entity that isn't configured, a control on something that isn't a fixture, an op missing what it needs. Edits after a `create` in the same request apply to the new model. A `clarify` stands alone, since the rest waits on its answer, and when nothing is doable the reasons become the question. `needs` is kept only when a model is being made.
- The target comes from `resolveSelection`, not from Spark. Spark may say the selection is something else (`targetDisagrees`), which the review shows rather than acting on.
- **Demo mode** reads with `demoIntent`, hand-written patterns for what the demo shows (its own fixture from a product, colours by name or hex with parts and "but not", materials, sizes in mm, cm or m, rename, a light or switch), answering in Spark's shape so it goes through `readIntent` too. Anything else is a question back.
- **`bun run bench:intent`** reads the cases in `scripts/lib/intent-cases.ts` (shared with `tests/intent.test.ts`) and prints each one's ops against those wanted; `--live` asks Spark instead, one billed call per case, spend kept in a throwaway store. Offline: 12/12. Live: not yet run.

## 5. Gathering facts

`packages/domain/src/facts.ts` and `apps/server/src/research.ts` (built). One interface, so sources can be swapped and mixed:

```ts
interface ProductFacts {
  query: string; // "IKEA Alex desk"
  name?: string; // the maker's own name
  sizeCm?: { w; d; h };
  parts?: { name; role?; sizeCm?; count? }[];
  colors?: { name; hex }[];
  materials?: ItemMaterial[];
  sources: FactSource[]; // { kind: 'web' | 'image' | 'catalog' | 'photo' | 'person', title, url? }
  confidence: number; // 0 to 1
}
interface Researcher {
  kind: FactSource['kind'];
  lookup(
    query,
    need: ('size' | 'parts' | 'colors' | 'materials')[],
    signal?,
  ): Promise<ProductFacts | null>;
}
```

`research(query, need, researchers, { given })` asks researchers most trusted first and **stops once nothing needed is missing**, so a product in the catalog never reaches the web. `mergeFacts` takes each field from the first set that has it and keeps where it came from (`origin`), the sources of the sets it used, and the lowest of their confidences. What no source answered comes back as `missing`.

Researchers, in order of trust:

1. **The person** (`personFacts`): "it's 140 cm wide" beats every lookup.
2. **Catalog** (`Catalog`): one JSON file per product, in `DATA_DIR/products/` (written when a person accepts a build, with the recipe they accepted) and the bundled `apps/server/catalog/` (never written). A request finds an entry when every word of its name or an alias is in it: "it's an Ikea Alex office desk" finds "IKEA ALEX desk"; "desk" alone finds nothing. The demo uses only this. The bundled Alex desk is hand-entered (the listed 131 × 60 × 76 cm; parts not checked) and says so in its source.
3. **Web** (`webResearcher`, `MetaAdapter.lookupProduct`): Spark with its `web_search` tool, answering in a strict JSON schema (`productLookupSchema`). Billed; live only.
4. **The photo**: the selection's mask through the calibrated camera gives a footprint and a height (step 6). It is the fallback, and the check on the others: `sizeDisagreement` flags any axis where a looked-up size and the camera's estimate differ by more than 25%. A web answer of 131 cm against a camera that sees 80 cm is likely another product, or the wrong thing selected, and the review says so rather than taking either.

**Sources are never the model's own words.** `citedSources` reads them from the response's `url_citation` annotations, then the search results it read; only `http(s)` URLs, no repeats, at most eight. Facts a lookup gives with no source have their confidence capped at 0.3.

### Spike: search on the Meta API (October 31, from the docs, not yet called live)

- **Web search exists for Spark.** [Search grounding](https://dev.meta.ai/docs/search-grounding): `tools: [{ "type": "web_search" }]` on the Responses API (not Chat Completions), with `muse-spark-1.3`. Options: `search_context_size` (`low`, `medium`, `high`), `user_location`, and `include: ["web_search_call.results"]` for every result read (title, URL, snippet). Answers carry `url_citation` annotations with offsets into the text. The model decides whether and how often to search, so a search isn't guaranteed; the docs say multi-hop research is less reliable.
- **Cost.** [Pricing](https://dev.meta.ai/docs/pricing-rate-limits): $2.50 per 1,000 search queries on top of tokens ($1.25 / $4.25 per million in and out). `lookupProduct` reserves for its tokens plus five searches (about $0.047 worst case) and records tokens plus $0.0025 for each `web_search_call` in the answer.
- **No image search for Spark.** Muse Image searches the web and images on its own while it draws, but returns only its own picture, so it can't fetch a product photo. A product photo would mean downloading an image the search cited, which needs its own safety rules (public hosts only, size and type limits). Left out for now; the camera's close-up stays the colour source.
- **Not yet known.** Whether `web_search` and a strict `json_schema` answer work together in one call, and how long a lookup takes (a third-party plugin reports 20–30 s; the timeout is 90 s). If they don't work together, the fallback is two calls: search for a cited text answer, then a second Spark call reading it into the schema. Both are for the first live run to settle. Until then `lookupProduct` is tested against a mocked API only.

## 6. Building and checking

`packages/domain/src/recipe-build.ts` and `apps/server/src/build.ts` (built). All local but the refiner.

1. **Start from a form** (`recipeFromForm`). A built-in form's model is copied into a recipe once, in centimetres, each part named by a role guessed from its shape (`guessRole`: a thin slab at the top is the top, a narrow post from the floor a leg, a thin slab lower down a shelf, a thin full-height board a panel, else body). The desk becomes `leg-1`…`leg-4` and `top`, and draws exactly as the form did.
2. **Shape it by the facts** (`assembleRecipe`), with recipe ops, locally. A drawer unit the facts name replaces the legs on the right (its width from the facts, else 28% of the desk, 30 to 45% bounds) with its drawers on the front (the facts' count, else three); a side panel replaces the legs on the left. The product's size, else the form's usual one. Colour: the photo's (`photoColor`, the largest OKLab cluster of the outline's pixels), else the product's first; its finish (a material that isn't metal) on everything that isn't metal. From the bundled catalog's facts this gives the same Alex desk as the hand-written recipe. No model call: Spark only refines.
3. **Size it from the camera** when the room has no group there (`photoBox`). The box standing on the floor, inside the room, whose silhouette best matches the outline's convex hull (the hull, so a desk's open underside counts as the box's): a coordinate search from a small box where the outline meets the floor, at a quarter of the frame's size, in about 25 ms. On the demo: the desk 154 × 71 × 75 cm (truly 160 × 80 × 72), the bookshelf 80 × 30 × 120 (exact). A chair partly hidden by the desk comes out short (66 cm tall for 98), and a thing on another thing (the lamp on the desk) gets no box. This is the camera's estimate `sizeDisagreement` checks a lookup against.
4. **Check it** (`checkRecipe`). The scene with the recipe standing where the selected group stood (`placeOfGroup`: same middle, same turn; that group left out) is drawn through the room camera, labelled per pixel, so what stands in front hides it as in the photo. Its pixels against the outline give IoU, the share of the outline missed, the share drawn outside it, and a plain report of where ("Most of the outline it misses is on its right."). The demo desk drawn from the desk form scores 0.99 against its own outline. Colour isn't scored: the room is drawn in the house palette, not the photo's colours.
5. **Refine it** (`refineRecipe`). Below `RECIPE_TARGET` (IoU 0.75), a refiner suggests ops from the check's report, the check runs again, at most twice, and the best round is kept, so a refinement that made it worse never comes back. Live, the refiner is Spark (`MetaAdapter.refineRecipe`, `sparkRefiner`): one call per round in the request's own schema, keeping only recipe ops. Tested against a mocked API only.
6. **Review** (step 8). Photo vs model, the sources, each change as a line ("drawer unit: W × D × H cm, from the product page"), any size the camera disagrees with, and the choice of fixture or furniture. Nothing is saved until the person saves it.

An edit (`recolor`, `resize`, …) skips 1–3, applies its op, and reruns the check only when geometry changed.

In the demo, the selected desk is the office's 160 × 80 cm desk, not an Alex: an Alex assembled from the catalog scores 0.55 against it, which is what the review should show (and a refiner resizing it to the desk improves it). The demo tells that story honestly rather than pretending the room's desk is an Alex.

## 7. Orchestration and cost

`POST /api/assist` (run kind `assist`, `apps/server/src/assist.ts`, built): `{ mode, prompt, shape?, imageDataUrl?, previous?, jobId? }` → an `assist` run whose output is the draft (`AssistDraft`). Nothing is saved to the room; the review (step 8) saves.

| Step                          | Demo                                            | Live                                                                                                            |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Hold the frame                | the demo camera's frame                         | the page's frame (a camera snapshot), refused (409 `not_calibrated`) if not the calibrated size                 |
| Find what you selected        | the render's pixels of the target, in the shape | SAM's box prompt from the shape's bounding box, cut to the shape (`clipMask`); the shape when SAM finds nothing |
| Read your request             | `demoIntent`                                    | `MetaAdapter.intent`, with the crop                                                                             |
| Look it up (a new model only) | the bundled catalog, then the camera            | `DATA_DIR/products`, the bundled catalog, the web when a product is named, then the camera                      |
| Build the model               | `assembleRecipe`, then the request's edits      | the same                                                                                                        |
| Check it against the camera   | `checkRecipe`, no refiner                       | `checkRecipe`, refined by Spark only for a new model with no size asked for                                     |

- **Kept with the run:** `frame.png`, `outline.png` (the selection's outline as a black and white mask), `crop.png`, SAM's raw answer live. The run's usage adds up every Spark call; the spend ledger has each call and search as it was billed.
- **A question back** (`clarify`) ends the request after reading it: `question` is set, the other steps say they wait for the answer, and the answer is sent as a follow-up.
- **Follow-ups** name the run before (`previous`) and may leave out the shape: they reuse its frame, outline, target, place, facts and model, and cost one reading. "Make the drawers green" changes the model and keeps its check (a colour isn't a shape); "it is 160 cm wide" checks again, and Spark never refines a model away from a size the person asked for.
- **Cost.** The worst case (reading with the crop, SAM, a lookup with five searches, two refinements: `assistCeiling`, about $0.18) is refused up front when today's limit can't cover it, before any call.
- **Replay** (`bun run assist <run>`, `scripts/assist-replay.ts`): a stored request run again with this tree, offline, through the same `finishDraft` the route uses (steps 4–6), with the stored frame, outline, reading and facts (`--catalog` looks the product up in the catalog again). Prints the size, parts and IoU then and now, and keeps the new model in `out/` for `bun run sheet --recipe`. Spark's refinements aren't replayed.

## 8. The brush (web)

`apps/web/src/workspace/useBrush.ts` and `Brush.tsx` (built), and `POST /api/assist/save`.

- **The tool.** **AI brush** (`B`) in the tool strip, over the camera's picture: drag for a box; click points for a polygon, closed by clicking the first point, a double-click or Enter, with Backspace taking the last point back; Esc clears. Choosing it shows the photo view. It is disabled until the room's camera is calibrated (the demo always is). Shapes are kept in shares of the frame, so zooming and panning don't change them.
- **On release** the selection is resolved (`/api/select/resolve`, free) and the panel opens beside the frame with what it is ("Desk · prop", or "or the chair?" when ambiguous). Live, the camera's frame is held when the selection is finished and shown over the video, so the request is about what was drawn on.
- **The panel** has the prompt (Enter sends) and suggestions for the target (_Make it its own fixture_, or for a model _Make it green · Make the drawers white · It is 140 cm wide_). Sending follows the job in `AiTaskDialog`, which closes itself a moment after it ends; the review is in the panel: the model drawn by the room's own kernel, its size and parts, how it matches the camera and where it missed, any size the camera disagrees with, where its facts came from (links for the web), anything left out of the request and why, or the question back. Follow-ups are typed in the same panel and list the requests before them.
- **Put in the room** (`POST /api/assist/save`) adds the model as furniture, in place of the group it was checked against: a preset room first becomes the person's own scene (`adoptPreset`: the copy, its calibration, pin, zones and fixtures naming `custom`), and is refused if they already have another scene of their own. What stood on the replaced thing settles onto the new top, fixtures and zones on its surface move to the new one, and the pin is found again through the camera. Live, a looked-up product is kept in `DATA_DIR/products` with its model. **Discard** drops the draft; nothing was saved.
- **Not built:** saving as a fixture (a fixture's model is an `IsoItem`, not a recipe), and showing SAM's outline on the frame.

## Build order

Each step lands with tests and leaves the app working.

1. ~~**Recipe and compile.** `recipe.ts`, recipes through `propModel` and `propSolids`, `sheet --recipe`, a hand-written Alex desk recipe as a golden. No AI.~~ Done: `IsoProp.recipe`, `recipeModel`, `placeRecipe`, `tests/recipe.test.ts`, golden `props/recipe-alex-desk`. Storing recipes in desk memory with versions waits for the route (step 7).
2. ~~**Ops.** `recipe-ops.ts` with every recipe op above as a pure function, tested on the Alex recipe.~~ Done: `RECIPE_OPS`, `selectParts`, `applyRecipeOps`, `tests/recipe-ops.test.ts`. Intent ops come with the parser (step 5).
3. ~~**Selection and target.** `selection.ts`, `clipMask`, `resolveSelection` against `demoSegmentation`.~~ Done, with `POST /api/select/resolve`. Freezing the frame and SAM's outline moved to the assist route (step 7), where the frame is stored as that run's asset.
4. ~~**Facts.** `Researcher` interface, the catalog researcher and the demo's bundled products. Spike: web and image search on the Meta API, its cost and output, written up here.~~ Done: `facts.ts`, `research.ts`, `MetaAdapter.lookupProduct`, `apps/server/catalog/ikea-alex-desk.json`, `tests/research.test.ts`, and the spike above. Not yet called live.
5. ~~**Intent.** `editIntentSchema`, `MetaAdapter.intent`, demo answers; a small bench of sentences → expected ops (`bun run bench:intent`).~~ Done: `intent.ts`, `demo-intent.ts`, `MetaAdapter.intent`, `tests/intent.test.ts`, `bench:intent` (12/12 offline; live not yet run).
6. ~~**Build and check.** `recipe-build.ts`, scoring through the room camera; extend `bench:fit` with recipe cases.~~ Done: `recipe-build.ts`, `build.ts`, `MetaAdapter.refineRecipe`, `tests/recipe-build.test.ts`. The cases are tests on the demo room, not `bench:fit` cases: the fit bench scores items against crops, a different measure.
7. ~~**Route and job.** `/api/assist`, replay script, cost reservation.~~ Done: `assist.ts` (`finishDraft` shared with the replay), `select.ts`'s `selectionRoom`, the `assist` run kind, `scripts/assist-replay.ts`, `tests/assist.test.ts` (demo, follow-ups, questions back, live against a mocked API, refusals). Saving a draft to the room comes with the review (step 8).
8. ~~**Brush, prompt and review** in the web, a browser test on the demo desk.~~ Done: `useBrush`, `Brush.tsx`, the tool and `B`, `POST /api/assist/save` with `adoptPreset`, and the browser test (written, not yet run).
9. ~~`docs/architecture.md` section; "As built" here.~~ Done.

Steps 1–3 need no model calls and can run in parallel with 4.

## Timing

[current.md](current.md) puts live validation and the submission (November 4, 7 PM Edmonton) ahead of new features. This plan is about a week of work. If it is to be in the video, the smallest convincing slice is steps 1–3 and 7–8 with the demo only: a rectangle on the demo desk, "make it its own fixture, it's an IKEA Alex desk" answered from the bundled catalog, then "make it green". Live research can follow.

## Open decisions

- **Fixture or furniture.** Should a generated desk become a `Fixture` (switchable, trackable), a layout group (furniture other things stand on), or should the review offer both? Recommended: offer both; default to furniture for things with a top, fixture otherwise.
- ~~**Web search provider.**~~ Spark's own `web_search` (see the spike in section 5). Product photos from the web stay open.
- **Polygon prompts.** Does SAM take point or polygon prompts, or only boxes? If only boxes, a polygon is a box plus a clip, as above.
- **Agent loop.** Keep the fixed pipeline, or let Spark choose tools once they exist? Recommended: fixed pipeline first; the tool contracts make the switch cheap later.
- **Recipes beside forms.** Should built-in forms (desk, chair) eventually become recipes too, so one format covers everything? Not needed for this feature.

## As built

Built in the order above, as one piece of work, with these differences:

- **A recipe is kept on its prop** (`IsoProp.recipe`), not by id in desk memory, so `propModel` needs nothing but the prop. Starting from a form is a one-time copy of its parts (`recipeFromForm`), not a live `base`.
- **Two layers of ops**: recipe ops change a model; intent ops make one, change a fixture or ask back. Spark answers in one flat schema for both.
- **Facts come from Spark's own web search**, with sources read from its citations. No product images: Spark has no image search.
- **Building is local**: `assembleRecipe` shapes a form by the facts, and Spark only refines. Colour is taken from the photo, not scored.
- **Selections are resolved by two scores** (how much of a thing is covered, how much of the selection it fills), not by IoU: a desk fills only a third of its own bounding box.
- **Saving is as furniture only.**

Not built, or not yet known:

- **Live has not been run against the real API**: reading a request, the product lookup (whether `web_search` and a strict schema work in one call, and how long it takes), and refining. `bun run bench:intent --live` is the first check.
- **The browser test** for the brush is written but hasn't been run.
- Fixtures from a recipe; SAM's outline shown on the frame; product photos from the web.
- `photoBox` sizes only things on the floor seen whole: a chair behind a desk comes out short, and something on a desk gets no box.
