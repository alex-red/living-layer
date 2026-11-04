# Demo-ready UI

Goal: every screen in the demo video's shots (`docs/demo-video.md`, 1440 × 900) looks deliberate, calm and of one piece, per Quiet Neon (`docs/design.md`). Nothing new to build; this is polish, consistency and cutting noise.

Found on 2026-11-03 by walking the running lab (Live, office desk, 1440 × 900 and 1280 × 720) and a static audit of `apps/web/src`. Demo mode, the first screen, photo review, the AI brush panel, zone actions and Your day were not walked yet (the camera was on, which locks the mode switch): phase 0 does that.

## What's already good

Colour, radius and z-index tokens are used almost everywhere (z-index 37/37, radius 130/168). `Button`/`IconButton` are used about 300 times against 65 raw buttons. There's a global `:focus-visible`, reduced-motion/transparency/contrast fallbacks, and dark-only by decision. So this is a tightening pass, not a redesign.

## What a viewer will notice (by shot)

**Everywhere**

- Text is small and dense. The design's scale has Body 15 / Callout 14, but the tokens stop at `--fs-13`, and 16 distinct sizes are in use (10px about 17 times, 9, 8.5, 7, 5.5). At video compression, 11–12px grey text on dark reads as noise.
- No spacing scale: 693 raw padding/margin/gap values (2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18…). Panels look slightly differently padded.
- Inspector and setup panels explain in paragraphs: "Watching Office camera · 19850 frames · local only, no SAM calls · 4 found by appearance. Nothing on this machine can see the Small purple mouse either. Looking again later." Three blocks of helper text under one button.
- Internal ids and jargon on screen: `OBJECT · MAIN`, zone lines `→ light.light_bulb_color_hue_1 · occupied`, `mqtt · off · 3 devices`, model ids in the readiness popover, "Run text smoke test", `.env`, `MQTT_URL and MQTT_LIVE_ENABLED`, SQLite/localStorage in the saves menu, "Copy JSON".
- Copy slips: "Working in the My office." (`progress.ts:139`), "Fixture Studio ↗" in Title Case, arrows used unevenly ("Edit model →", "← Setup").
- Glyphs: close is `×` or `✕`, rotate is `⟲⟳` or `↺↻`, failed is `×` or `✕`; one-offs `⚄ ☰ ❚❚`. `Glyph.tsx` has 4 icons; ~25 inline SVGs elsewhere.
- Capitals typed into source (~61, worst `ItemEditor.tsx`, `TopBar.tsx`) instead of the `.tiny` HUD style, so the HUD labels vary in size and tracking.

**Top bar (every shot)**

- At 1280 the breadcrumb truncates ("My desk m…") and the "Welcome back… restored from this browser" capsule crowds the bar. The capsule should fade after a few seconds.
- ⋯ menu: Fixture Studio and Camera playground links, "Reset everything to demo" in plain red text among other items.
- Readiness popover reads as a dev console (SPARK/SAM/META, `muse-spark-1.3`, "1934 calls today", "MQTT setup pending").
- `DevReload` toast ("Server code changed · apps/server/src/index.ts") will appear mid-take if anything is saved. Dev only, but the video is recorded on the dev server.

**Split view, cold open (0:00) and the end (2:45)**

- The camera frame doesn't fill its pane at 1440: a small picture floating with corner brackets far outside it; lots of empty pane above and below. The iso pane's top half is empty too.
- Layer chips (MASKS TRAIL ZONES STATS TRACKING ~~CORNER~~) sit on the picture's bottom edge; a struck-through chip reads as a bug.
- Iso callouts overlap in big pixel type ("USED 1 H 23 MIN AGO", "MY DESK MUG", "KEYBOARD" over each other) and the MONITOR card clips at the pane's left edge.
- "Placement is still decided on the photo. This view only shows it in the room." under the iso pane: a developer's note.
- The setup checklist takes a whole column when every step is done.

**Watcher line (2:20, it's in the script)**

- Always on: `WATCHER LAGGING 9.9 FPS · 21 MS · CPU 462% process starved: timers 292 ms late`. Keep it (the script opens it), but closed it should say one calm thing (● Watching · healthy) and the numbers belong in its popover. "Lagging"/"starved" should be plain words.

**Left rail**

- At 1280: "Small pu…", "Office camer", "used 1 h 2…" truncate; rows mix diamonds, circles and dots without a key.
- Zones show the Home Assistant entity id instead of the light's name.

## Plan

Each phase ends with a look at the same screens (and `bun run sheet --audit` where colour is touched). Commit per phase with `bun run commit`.

### 0. Walk the rest (half an hour, no code)

With the camera stopped by you: **Reset everything to demo**, then walk Demo and Live through every shot in `demo-video.md` at 1440 × 900, and once at 1280 × 720. Screenshot each into `out/demo-ui/<shot>.png` as the "before". Add what's found to this list.

### 1. Cut the noise (highest value, low risk)

1. Copy pass on demo-visible text: one short sentence per state, helper paragraphs folded behind a "Why?" disclosure or a title. Covers Inspector (object card, watching line), setup steps, iso pane note, zone and device rows.
2. Names, not ids: zone rows show the light's friendly name; inspector eyebrow says the kind ("Thing"), not `MAIN`.
3. Dev surfaces behind a "Developer" group in ⋯: Studio, Playground, smoke test, model ids, call counts, env-var hints, SQLite/localStorage, Copy JSON. Errors that name env vars keep them in the details, with a plain first line.
4. Watcher line: calm closed state, numbers and lag reasons inside its popover.
5. Welcome/status capsule fades after ~4 s; `DevReload` gets a `?nodev` (or env) off-switch for recording.
6. Fix the copy slips (`progress.ts:139`, Title Case, arrows: `→` only for "goes elsewhere", `←` only for back).

### 2. Type and spacing scale

1. Tokens: add `--fs-10` only where HUD needs it, plus `--fs-14`, `--fs-15`, `--fs-17`, `--fs-22` to match the design's scale; line heights alongside.
2. Raise body text in Inspector, setup and dialogs to 14 (callout) / 13 (metadata); keep 11 mono for HUD labels. Floor 11px: remove 10, 9, 8.5, 7, 5.5 (the iso sprite labels at `iso.css:1990-2001` are pixel-art and judged on the sheet, not here).
3. Spacing tokens `--s-1…--s-6` (2, 4, 6, 8, 12, 16, 24) and convert padding/gap; fold 3/5/7/9/14/18 onto the scale.
4. One HUD label style: replace typed capitals with `.tiny`.
5. Shadow tokens (2–3 levels) for popovers, menus, cards.

### 3. Layout of the hero views

1. Camera frame fills its pane (contain, centred), brackets hug the picture.
2. Layer chips: below the frame or in a toolbar, not on it; a hidden layer shows as off, not struck through.
3. Iso callouts: no overlaps (offset or one line per thing), clamp inside the pane.
4. Setup column collapses to a slim "✓ Set up" chip when complete; the canvas takes the width.
5. Left rail at 1280: wider rail or two-line rows; legend for ◆ ◇ ● ○ via titles.

### 4. One of each component

1. Dialogs: one `Dialog` on native `<dialog>` (traps focus), replacing `.keys-dialog`/`recipe-dialog`.
2. Menus: one `Menu` for `.context-menu`, `.za-menu`, `.layers-menu`.
3. One `Chip`/`Tag`, one `EmptyState`, one `ErrorNote` (plain line + details), one `Spinner` (the `breathe` dot), used where the shots go.
4. Glyphs: `×` close, `↺↻` rotate, `✕` nowhere; add the inline SVGs that repeat to `Glyph.tsx`.
5. Raw buttons in `RoomCalibrate`, `DayDock`, `Outline`, `ItemEditor` → `Button`/`IconButton`; hand-rolled busy labels → `busy`.
6. Hex/rgb strays → tokens (`#05060a` → `--void`, `#30d158` → `--ok`, re-typed glass → `--glass-*`).

### 5. Moments (only if 1–4 are done)

- Lamp ignition and room warm-up timing checked on video at 30 fps.
- Zone state change (EMPTY → OCCUPIED, MOTION) has one clear transition.
- Iso hover/selection outline on the selected thing in both panes.

## Checks

- Unit tests for any logic moved out (friendly zone names, capsule timing, callout layout).
- `bun run verify` per commit; `bun run sheet --turns 0 --audit` after colour changes; goldens only if sprites change.
- After each phase, the same screenshots as phase 0, side by side with the "before".
- Browser suite only if you ask for it.
