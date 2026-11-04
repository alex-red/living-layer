# Design guide

Living Layer is a thin layer of software over a real room. The look should feel like that: a desk at night with a quiet heads-up display floating over it, and one warm lamp.

We call the direction **Quiet Neon**. It takes its discipline from Apple's interface guidelines (clarity, deference, depth) and its mood from lo-fi cyberpunk (dusk colours, glass, grain, mono telemetry). Apple sets the rules and cyberpunk sets the atmosphere. When the two conflict, legibility wins.

## Logo

The **object-memory** mark is a cyan isometric cube held in a pink spatial cradle: a thing the camera sees, in a place you chose to remember. Its flat geometry follows the room's isometric view, with generous gaps that remain clear at favicon size. Keep the mark still, with no glow, gradient or extra frame in the UI.

`apps/web/public/logo.svg` is the source of truth. The workspace, studio and camera playground use it through `Logo`; the standalone phone camera embeds the same SVG so it needs no extra request. Adjacent text supplies the accessible name; the mark is decorative there.

Run `bun run brand` after editing the source to regenerate the dark favicon (SVG and multi-size ICO), Apple touch icon, 192/512 px home-screen icons and horizontal `logo-wordmark.svg`. The wordmark uses light text for dark backgrounds; its editable type follows the UI's Inter/system font stack. Use the transparent mark for other backgrounds, leave at least 7/64 of its width clear around the artwork, and keep it at least 16 px wide. The manifest names the app and supplies its home-screen icons.

The original generated concepts and prompts live in `design/logo-variants/`; production uses the clean vector redraw of the selected object-memory direction.

## Principles

1. **The one warm light.** The interface is cool and dim. Amber (2700 K, the lamp's own colour temperature) is reserved for things that change the physical world. If something glows warm, a real light is involved.
2. **Colour means a source.** Cyan is what the model sees. Magenta is what you decided. Amber is what happened in the room. Nothing else gets these colours. The one exception is a zone: one whose steps set a light's colour is drawn in that colour, and a motion zone is cyan, because the camera decides it (see [Zone](#components)).
3. **Never grade the evidence.** Photos and masks show true colour. Atmosphere (grain, vignette, scanlines) goes around the content, never on top of the pixels a decision was based on. A camera filter is the person's own choice, off by default, and only for their eyes: it is CSS or a canvas over the `<video>`, and scans, SAM and the tracker read the plain frames.
4. **Defer to the scene.** The camera frame is the hero. The UI around it is glass and type, not decoration.
5. **Telemetry whispers, sentences speak.** Mono uppercase HUD labels add flavour in small doses. Anything a person has to understand is written in plain sentence case.
6. **Calm by default.** No constant flicker, glitch or pulsing. Motion happens because something changed. The exceptions say something is still going on: a recording's blinking dot, the live camera's privacy dot, a dot or shimmer while waiting on AI or other work, a prop still being drawn, and a tracker that has stalled. Each stops when that does. Animated camera filters move too, but only when the person picks one.

## Colour

Dark is the default and, for now, the only theme. See [open decisions](#open-decisions).

### Surfaces

| Token           | Value                    | Use                                      |
| --------------- | ------------------------ | ---------------------------------------- |
| `--void`        | `#0A0C12`                | Page background                          |
| `--stage`       | `#05060A`                | Behind the camera picture and the room   |
| `--surface-1`   | `#11141D`                | Panels                                   |
| `--surface-2`   | `#181C28`                | Cards, inputs                            |
| `--surface-3`   | `#212637`                | Raised controls, hover                   |
| `--line`        | `rgb(170 185 255 / 10%)` | Hairline dividers                        |
| `--line-strong` | `rgb(170 185 255 / 18%)` | Control borders, focus-adjacent outlines |

### Text

| Token      | Value     | Contrast on `--surface-1` | Use                                                   |
| ---------- | --------- | ------------------------- | ----------------------------------------------------- |
| `--text`   | `#ECE9F2` | 15.3:1                    | Primary text                                          |
| `--text-2` | `#A9AEC2` | 8.3:1                     | Secondary text, labels                                |
| `--text-3` | `#7C8299` | 4.8:1                     | Timestamps and hints. Never on `--surface-3` (3.9:1). |

### Signals

Each signal has a solid value for text and icons and a `-wash` (the same colour at 10%) for fills. `--seen`, `--chosen`, `--warm` and `--ok` also have a `-glow` (at 25%) for halos; `--unsure` and `--blocked` don't glow.

| Token       | Value     | Contrast on `--surface-1` | Meaning                                             |
| ----------- | --------- | ------------------------- | --------------------------------------------------- |
| `--seen`    | `#6FD3E0` | 10.6:1                    | Perception: discovered objects, masks, model output |
| `--chosen`  | `#E68CC4` | 7.8:1                     | Your intent: confirmed identity, zones you drew     |
| `--warm`    | `#FFB866` | 10.8:1                    | Physical effect: lamp actions, live hardware        |
| `--ok`      | `#86D9AA` | 11.0:1                    | Confirmed state, passing checks                     |
| `--unsure`  | `#AE9BF5` | 7.7:1                     | Stale, unconfirmed, or uncertain outcomes           |
| `--blocked` | `#F27C83` | 7.0:1                     | Errors, blocked decisions, destructive actions      |

Rules:

- Text on a filled signal button uses `--void` (11:1 or better on cyan and amber).
- Never show a signal by colour alone. Pair it with a glyph or a word (`✓ confirmed`, `◌ stale`).
- Amber appears only for the lamp. A "warning" that isn't about the room uses `--unsure`.
- Saturation stays where it is. Lo-fi means the neon has been through a few nights of rain; don't push it brighter.

### Ambient light

The page background is a very soft radial gradient centred behind the scene: `--seen` at about 6% opacity fading into `--void`. When a lamp action is confirmed, it crossfades over 1.2 s to `--warm` at about 8%, so the whole room seems to warm up. It fades back when you reset or start a new observation. This is the signature moment of the demo.

## Typography

No external font requests. The app has to run offline, and the browser tests fail on any outside request.

| Role | Stack                                                                                       |
| ---- | ------------------------------------------------------------------------------------------- |
| UI   | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", system-ui, sans-serif` |
| Mono | `ui-monospace, "SF Mono", "JetBrains Mono Variable", Menlo, monospace`                      |

Apple devices get San Francisco from the system; we can't bundle it, because its licence only covers Apple platforms. Everyone else gets Inter and JetBrains Mono, both under the OFL, self-hosted through `@fontsource-variable` so they ship in the bundle. Use tabular figures (`font-variant-numeric: tabular-nums`) for every number that updates.

The scale follows Apple's text styles, slightly tightened for a dense tool:

| Style       | Size / line height | Weight | Use                                 |
| ----------- | ------------------ | ------ | ----------------------------------- |
| Large title | 34 / 41            | 700    | Page hero, at most one per page     |
| Title 2     | 22 / 28            | 600    | Section headings                    |
| Headline    | 17 / 22            | 600    | Card and step titles                |
| Body        | 15 / 22            | 400    | Default text                        |
| Callout     | 14 / 20            | 400    | Helper text under controls          |
| Footnote    | 13 / 18            | 400    | Metadata                            |
| HUD label   | 11 / 14, mono      | 500    | Uppercase, `letter-spacing: 0.08em` |
| HUD value   | 13 / 16, mono      | 500    | IDs, durations, coordinates, scores |

**11 px is the floor.** Each size is a token (`--fs-11` … `--fs-34`); write `font: 500 var(--fs-11) / 14px var(--mono)`, never a raw size. Labels drawn inside the isometric room are in scene units and scale with its zoom, so they're exempt.

Spacing sits on one scale: 2, 4, 6, 8, 10, 12, 16, 24 px (and 32, 48 for page-level gaps).

Display flourish: the large title and big numerals (such as the `0 / 4` checklist) can carry a 1 px chromatic split, with `text-shadow: -1px 0 var(--seen-glow), 1px 0 var(--chosen-glow)`. Use it nowhere else.

## Space, shape, and layout

- **Grid:** spacing stays on the one scale under [Typography](#typography): 2, 4, 6, 8, 10, 12, 16, 24 px, with 32 and 48 for page-level gaps.
- **Radii:** nearly square. 2 for chips, inputs and buttons, 3 for cards, 4 for panels and the scene frame. Only status dots, checklist rings and the shutter stay round.
- **HUD brackets:** detections and the scene frame get corner ticks (four L-shaped 12 px strokes) instead of full boxes. Brackets are our "cyberpunk" shape. Cut, chamfered panel corners are not; see [originality](#originality).
- **Density:** the labs are dense tools. Buttons, inputs, selects and segmented controls are 28 px tall (`--control-h`), 24 px in dense rows and toolbars (`--control-h-sm`); control and body text is 13 px, helper text 12 px. Take heights from the tokens, never a literal.
- **Desktop:** content max width 1440 px, 12 columns, 24 px gutters. The scene outline sits on the left, the canvas in the middle and the inspector on the right. The activity drawer (the evidence log) sits full width below. See [plans/workspace.md](plans/workspace.md).
- **Mobile (under 768 px):** a single column with the scene first. The current step's primary action sits in a sticky bottom bar within thumb reach. There must be no horizontal scroll; a browser test already checks this.

## Materials and texture

**Glass** (Apple's materials, at night):

| Material | Background           | Blur | Use                             |
| -------- | -------------------- | ---- | ------------------------------- |
| Thin     | `--surface-1` at 55% | 12px | Overlays on the scene, tooltips |
| Regular  | `--surface-1` at 72% | 20px | Outline, inspector, top bar     |
| Thick    | `--surface-2` at 88% | 28px | Sheets, the status capsule      |

Every glass layer gets `backdrop-filter: blur() saturate(140%)`, a `--line` border, and a 1 px inner top highlight: `inset 0 1px 0 rgb(255 255 255 / 6%)`. Under `prefers-reduced-transparency`, glass becomes the solid surface colour.

**Lo-fi texture** applies to the page and the frame around the scene, never inside the image area:

- **Grain:** an SVG `feTurbulence` noise layer, fixed to the page, at 3–4% opacity with `mix-blend-mode: overlay`.
- **Scanlines:** 1 px lines every 3 px at 3% opacity, only on the scene frame's border area.
- **Vignette:** a soft inner shadow on the scene frame's edge.
- **Glow:** `box-shadow: 0 0 24px var(--signal-glow)` on active signal elements. Use one glow at a time per region.

## Motion

| Token        | Value                                      | Use                                                |
| ------------ | ------------------------------------------ | -------------------------------------------------- |
| `--t-fast`   | 150 ms                                     | Hover, press                                       |
| `--t-base`   | 250 ms                                     | Panels, state changes                              |
| `--t-slow`   | 400 ms                                     | Masks appearing, layout shifts                     |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)`           | Default                                            |
| `--spring`   | a `linear()` curve with a slight overshoot | The segmented-control thumb and the status capsule |

Key moments:

- **Mask arrives:** a cyan scan line sweeps once across the detection box (400 ms), then the mask fills in.
- **Lamp on:** the verify button and ambient light "ignite". Amber brightens with two brief dips over about 300 ms, then holds. That's the only flicker anywhere. It stays under three flashes a second, so it's safe for photosensitive users. Each step lasts whole frames at 30 fps (100 ms, then 67 ms), so a recording keeps both dips; the room's lamp glow uses the same keyframes, and a virtual lamp ignites at half strength.
- **Something enters a zone:** the zone's own colour grows stronger, its line heavier, and it glows, over `--t-base`. The same on the camera and in the room, for every zone.
- **Selected:** the thing's box on the camera turns solid and heavier, with a glow in its tone, and the other boxes step back to 45%. In the room the thing's model gets a `--chosen` outline over its floor ring; under the pointer, a fainter one.
- **Busy:** a thin progress shimmer runs along the top of the acting card. No spinners in the middle of the scene.

Under `prefers-reduced-motion`, every sweep, ignition and shimmer becomes a 150 ms opacity fade, and the ambient light changes instantly.

## Components

**Status capsule.** A floating glass pill, top centre, inspired by the Dynamic Island. It shows the current operation ("Discovering objects", "Lamp on · confirmed") with a signal dot, and replaces today's feedback bar. A settled message folds to its dot after 6 s (`MESSAGE_SHOWN_MS` in `TopBar.tsx`), so the top bar stays calm; work in progress and errors stay open. It's also the `aria-live` region.

**Readiness.** The pill in the top bar shows today's spend against its limit and the live proof count (`n/4`). It opens a popover with the session strip (Spark and SAM models, Meta, spend, the lamp, live proof), the live checklist and the connection tests.

**Record.** _Record_ in the top bar (or ⌘⇧E) records the tab to a video that downloads when it stops. While recording, the button gives way to a blinking `--blocked` dot, the take's time in tabular mono and _Stop_ (`Recorder.tsx`).

**Segmented control.** One of a few, with a sliding thumb (`<Segmented>`): the mode switch (`Demo | Live`; the code calls demo mode `demo`), the stage view, an item's views. In Live mode, a small `LIVE` HUD tag appears in the top bar.

**Privacy dots.** While the camera is streaming, a green dot shows next to the camera button, and in the status capsule, following Apple's camera indicator. Users already know this pattern; don't restyle it.

**Buttons.**

| Kind        | Look                                          | Example                          |
| ----------- | --------------------------------------------- | -------------------------------- |
| Primary     | Filled `--seen`, `--void` text                | Discover objects, Segment object |
| Physical    | Filled `--warm`, `--void` text, glow on hover | Verify placement · turn on lamp  |
| Secondary   | Faint fill and line, `--text`                 | Confirm mug mask, Save zone      |
| Ghost       | No frame until hovered, `--text-2`            | Toolbar and row actions          |
| Tertiary    | Text only, `--text-2`, underline on hover     | Test absent target, Draw zone    |
| Destructive | Text only, `--blocked`                        | Reset desk memory                |

Only one primary or physical button is visible per step. Icon-only actions are `<IconButton>`: square, quiet, and named by their label for the tooltip and screen readers.

**Controls in code.** Use the components in `apps/web/src/ui/controls.tsx` (`Button`, `IconButton`, `Field`, `Select`, `NumberInput`, `Check`, `Segmented`, `Toolbar`); their look lives in `ui/controls.css`, loaded before every screen's styles so a screen can still set a width or a place. A screen never sets a control's height, padding or font.

**Detections.** HUD brackets in `--seen` around the box, the mask at 24% `--seen-wash` with a 1 px contour, and a mono tag above it: `MUG · #7 · 0.94`. A confirmed detection switches its brackets to `--chosen`.

**Zone.** Every zone, saved or being drawn, is a dashed outline over a faint wash (`--chosen-wash` or 12% of its colour). On the camera the line is 1.5 px, 2.5 px with a glow while something is inside, and the fill goes to 28%; in the room it is 1.25, then 2 (`iso.css`, `saved-zones.css`, `scene.css`). Its colour is `--chosen`, or its light's colour when its steps set one, or `--seen` for a motion zone. A zone turned off is a faint `--text-3` dotted line with no wash. A mono name shows only while you draw it, hover over it or select it: the main zone's `ZN-01` tag (with live W×H percentages while drawing), another zone's name and state (`DESK · OCCUPIED`, `OFF`).

**Zone menu and steps.** Right-clicking a zone, on the photo, the camera, the room or the outline, opens a small menu: _Open_, and _Turn off_ or _Turn on_ (`ZoneMenu.tsx`). An off zone stays where it is drawn but isn't judged and runs nothing. Its steps are edited as two plain-sentence branches, "When the mug enters" and "When it empties" (or when motion starts and stops), each a short list of steps: turn a light on or off in its own colour, warm white or a colour; wait; ask `if` something is inside or the time; show a banner or open a page on a desktop (`ZoneActions.tsx`).

**Outline rows.** The scene outline doubles as the checklist: each row has a status glyph (`✓` done, `●` current, `◌` needs something). A row you can't use yet is dimmed, with a one-line reason ("Set up the office first").

**Evidence log.** A tape of mono rows: time, kind, mode, status glyph, and duration. New rows slide in from the top. The inspector opens as a thick-glass sheet from the right on desktop and from the bottom on mobile.

**Live checklist.** Four rows, each with a ring that fills in `--ok` once it's done. The big `n / 4` numeral uses the chromatic split.

**Camera filters.** The _Filter_ layer chip lays a look over the live camera: a still look (mono, sepia, night…), an animated one, or a privacy filter that blurs the frame or redraws it in blocks over the hidden video (`cameraFilter.ts`, `CameraFilterLayer.tsx`). It's off by default, remembered with the session, and its hint says scans and tracking read the plain frames. Under reduced motion, a privacy filter holds still.

**Stat cards.** A thing's stats (`ThingStats.tsx`) are one card each on `--surface-2`, with a 2 px left edge in its source's colour: `--seen` for what the camera says, `--ok` for what a device reports, `--warm` only for a lamp's confirmed light, `--unsure` when the value is unknown and `--text-3` when it reads off or zero. Each shows its value and since when, today's total, a ribbon of the last 24 hours and the last week as small bars.

**Health bars.** Two kinds. A tracker's (`HealthBar.tsx`) is a mono chip under the camera: a dot, who is tracking and one word (`healthy`, `busy`, `behind`, `stalled`) in `--ok`, `--unsure` or `--blocked`; it opens to the reason, its numbers and recent frames' work against the frame interval, and only a stall says why without opening. A food's is ten cells over it in the room, each a tenth of its keeping time, `--ok` while it keeps, `--unsure` within two days of its use-by, `--blocked` once past it or empty.

**Food cards.** A food thing's card (`FoodCard.tsx`) holds what the person sets, not what the camera sees: its use-by day, when it was opened and how much is left. Its status line reads in words ("Expires tomorrow · half left") in the same three tones.

**Day dock and nudges.** Under the canvas, the day replay plays a sample day on the room with each change and nudge on its track, each kind of thing keeping its dot's colour, and _Ask your room_ beside it (`DayDock.tsx`, `day.css`). An answer card leads with its number large and its units small, then the sentence, a chart and what it rests on; a card asking back is washed in `--unsure`, and a cited time is marked on the track. Room coach nudges arrive as phone-style notifications in thick glass over the room's top right, newest first, three at once, each with a dot for its topic.

**Studio.** `/studio` is the model editor on a page of its own: every thing in the room on the left, the editor on the right, under the same top bar (`studio/Studio.tsx`). A model sits on a mid-grey backdrop (`--studio-1` to `--studio-3`), so black and white things both read. The onion skin compares the model with _Before this edit_, its base or another state, as an overlay or a wipe; _Photo vs model_ and _All states_ sit beside it.

## Icons

Line icons on a 24 px grid with a 1.5 px stroke and round caps, matching the existing `Glyph` component. SF Symbols are off limits, since their licence is Apple-platform-only. If we need more icons than we want to draw, use Lucide (ISC licence), since it has the same stroke style.

## Voice

Write like Apple: short, plain, and in the second person. "Draw a zone around the mug." "The lamp is on. Check that it actually lit up."

Cyberpunk flavour lives only in HUD labels and IDs (`OBS-0142`, `ZN-01`, `SIG 0.94`, `T+212ms`). Never put invented jargon in a sentence a person needs to act on, and never make a result sound more certain than it is.

## Accessibility

- Text contrast is 4.5:1 or better (all the tokens above pass on panels), and UI parts are at least 3:1.
- Every interactive element gets a visible focus ring: 2 px `--seen` with a 2 px `--void` gap, using `:focus-visible`.
- Controls are at least 28 px tall, and text is never smaller than 11 px.
- Honour `prefers-reduced-motion`, `prefers-reduced-transparency`, and `prefers-contrast: more`. Under high contrast, lines go to 40% and grain is turned off.
- Masks and zones carry text labels as well as colour. The mask overlay toggle stays available.
- Nothing flashes more than three times a second.

## Originality

The mood is "lo-fi cyberpunk". The look must not be Cyberpunk 2077's. This is a public hackathon entry, and the rules disqualify assets we don't have the rights to. So:

- No CD Projekt logos, typefaces, UI screenshots, sound, or name in the product.
- Don't make yellow-on-black the main scheme, and don't use chamfered or cut-corner panels, glitch-sliced type, or the game's HUD layouts. Our shapes are near-square panels with soft 2–4 px corners, plus our own HUD brackets.
- No Apple assets either: no SF Symbols, no bundled SF fonts, and no copied system UI artwork. Patterns like the Dynamic Island or privacy dots are fine as interaction ideas, drawn our own way.

## Implementation status

The workspace and the camera playground both use Quiet Neon. Tokens live in `apps/web/src/tokens.css`, and Inter and JetBrains Mono are self-hosted through `@fontsource-variable`. In place:

- The void background, ambient light, grain, and the glass top bar, outline and inspector.
- Frame and detection brackets, the scan-line sweep, cyan masks that turn magenta once confirmed, and dashed zones that fill while something is inside.
- The status capsule (it replaces the old feedback bar), the segmented mode switch, the `LIVE` tag, and _Record_ in the top bar.
- The lamp ignition and ambient warm-up. A virtual lamp warms the room at half strength and shows a `VIRTUAL` tag, which settles the open decision below.
- The evidence log with status glyphs, filters and summary stats; the inspector as a sticky side panel that can repeat a call or put its result back on the scene; and the checklist rings.
- The session strip (models, Meta calls, spend, lamp state and live proof) and the live proof checklist, in the top bar's readiness popover.
- The Studio (`/studio`), on its mid-grey model backdrop.
- Frames move from the camera playground to the workspace through session storage, never through the server.
- Reduced-motion, reduced-transparency and high-contrast fallbacks.

Still to do:

- On mobile, the inspector as a sheet that slides up from the bottom. It currently sits inline under the canvas, with its main action sticky at the bottom.
- A browser test that checks reduced motion turns the animations off.

The demo frame is rendered directly from the isometric office through `DEMO_CAMERA` in `demo-room.ts`. Its perspective frames, desktop pin, and synthetic SAM masks are generated from the room renderer, so the demo frame and synthetic masks match by construction.

## Open decisions

- **Light theme.** Apple's guidelines expect light and dark. We start dark-only to keep the build small. A "Daylight" theme would reuse the same signal colours, darkened for contrast on paper backgrounds.
- **Sound.** A soft click on lamp confirmation would add to the moment, but it needs a mute control, and autoplay rules make it fiddly. Leave it out for now.
