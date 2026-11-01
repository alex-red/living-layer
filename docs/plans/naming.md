# Plan: call it Living Layer

Status: built, except `docs/media/workspace.png` still shows the old heading and `bun run test:browser` hasn't been run. The [scene-first workspace](workspace.md) is built, along with room-camera calibration, multi-object and fixture tracking, the AI brush, server-side watching and Home Assistant MQTT discovery. It's no longer a single-desk prototype or a probe bench, so what a person reads (the UI, server messages, the phone page, the docs) stops saying "Desk lab", "early local lab" or "probe". It says _Living Layer_ for the product and _the workspace_ for the main screen.

## What stays

- **Identifiers, routes and saved schemas**: `useLabState`, `LabContext`, `LabError`, `ProbeKind`, `isProbe`, `/api/desk/*`, `tests/browser/lab.spec.ts`. Renaming them would break saves, undo history or API contracts for no one's benefit.
- **The one-word `livinglayer` ids**: storage keys and the save's `app` field, `livinglayer.sqlite`, the mDNS service, MQTT topics and `unique_id`s, the certificate's CN, and the evidence export's `project: 'LivingLayer'`.
- **Code comments** that say "the lab's …". They name the `Lab*` state they sit next to. Only docstrings that describe the product change (below).
- **The text smoke prompt** in `meta.ts` (`Reply with exactly: LivingLayer connection ready.`). It's a model prompt, not a label.
- **`docs/specimen/quiet-neon.html`**, which keeps its "Probe bench". It's a record of the style as first drawn.

Each string below is quoted as it reads today, so it can be found with `git grep` even after the line numbers move.

## Web (`apps/web`)

- `index.html`: `Living Layer · Desk lab` → `Living Layer`.
- `workspace/TopBar.tsx`: the brand becomes the heading. Wrap the `.brand` link in the `<h1>`, with the `LIVE` tag after it, and remove the `Desk lab` `<h1 className="page-title">`. Its accessible name is then "Living Layer home" (the link's `aria-label`), plus "LIVE" in live mode, which the spec's substring match still finds.
- `styles.css`: drop the `.page-title` rules (and their mobile override) once nothing uses them. The header comment becomes "Living Layer in the Quiet Neon style".
- `App.tsx`: the docstring "The desk lab: an outline of the scene…" → "The workspace: …".
- `handoff.ts`: the docstring "to the desk lab" / "until the lab runs a live probe on it" → "to the workspace" / "until a live step runs on it".
- `playground/Playground.tsx`:
  - The back link `Desk lab <Glyph …/>` → `Workspace <Glyph …/>`.
  - Both `Open in desk lab` buttons → `Open in workspace`.
  - "the frame cannot move to the lab" → "to the workspace"; "In the lab, this would turn on the lamp" → "In the workspace, …"; "to the desk lab to run the full placement check" → "to the workspace …".
- `workspace/Canvas.tsx`: "Prepared locally · sent only on an explicit live probe" → "Prepared locally · sent only when you run a live step".
- `workspace/Onboarding.tsx`: "everything the lab watches is placed through it" → "everything Living Layer watches is placed through it".
- `workspace/ExposePanel.tsx`: "it does what the lab’s own control does" → "what the workspace’s own control does".
- `PhonePairing.tsx`: "the lab signs its own certificate" → "Living Layer signs its own certificate".
- `workspace/useLabState.ts`:
  - "Run a live probe on it." → "Run a live step on it."
  - "until you explicitly run a live probe" → "until you run a live step".
  - "Live probes send this image to Meta only when you press a probe button." → "Live steps send this image to Meta only when you press one."
  - `` `${…} ${kind} probe saved · …` `` → `` `… ${kind} run saved · …` ``, so the spec reads `Demo lamp run saved`.
  - `'Probe failed.'` → `'Call failed.'`
  - "Only probes can be repeated. Use the inspector for desk steps." → "Only model and lamp calls can be repeated. Use the inspector for scene steps."

## Server and phone page (`apps/server`, `scripts`)

- `index.ts`: `` `LivingLayer desk lab: http://…` `` → `` `Living Layer: http://…` ``, and "LivingLayer could not start" → "Living Layer could not start".
- `cameras.ts`: `camera_limit` "The lab keeps at most …" → "Living Layer keeps at most …".
- `fixture.ts`: "fixtures in the lab" → "in the workspace"; "not one of the lab’s runs" → "not one of the saved runs".
- `remote.ts`: `remote_stale` "The lab stopped waiting for this answer." → "Stopped waiting for this answer." (`tests/remote.test.ts` matches "stopped waiting", which is case-sensitive: lowercase the start or update the test.)
- `sam.ts`: `mask_limit` "too many masks for this desk probe" → "for this frame".
- `remote-page.ts`: `LivingLayer camera` → `Living Layer camera` in the `<title>` and header; "the lab" → "Living Layer" in each status line ("Streaming to Living Layer.", "Scan the new QR code in Living Layer.", "Lost Living Layer. Is it still running…").
- `scripts/doctor.ts`: "LivingLayer readiness" → "Living Layer readiness".

## Browser spec (`tests/browser/lab.spec.ts`)

- `getByRole('heading', { name: 'Desk lab' })` → `name: 'Living Layer'`. Keep the default substring match (no `exact: true`): the heading's name is "Living Layer home".
- `'Demo lamp probe saved'` → `'Demo lamp run saved'`, in the same commit as `useLabState.ts`.
- The test title "live probes stay disabled without setup…" → "live steps stay disabled…", and "the lab opens on…" in the comments → "the workspace opens on…".

## Docs

- `README.md`:
  - "It's an early local lab, not a product. One desk, one mug, one lamp." → one sentence on the real scope: a calibrated room camera, the room's isometric twin, several tracked objects and fixtures, the AI brush, watching on the server, and Home Assistant entities.
  - The screenshot's alt text "The desk lab: …" → "The workspace: …", and **retake `docs/media/workspace.png`**, which shows the old heading.
  - "the lab's spend pill" → "the spend pill"; "You can also run the probes from the command line" → "the smoke checks"; "in the live desk lab" → "in the live workspace".
- `docs/architecture.md`: "Following locally (prototype)" → "Following locally"; the `app.ts` row "Routes for the individual probes" → "Routes for the single model and lamp calls".
- `docs/design.md`: retire the "Probe steps" component (the outline's status glyphs replaced it); "The desk lab and the camera playground" → "The workspace and …"; "repeat a probe" → "repeat a call"; "to the desk lab through session storage" → "to the workspace …".

## Order

One commit, since every step is wording: `refactor: call it Living Layer, not desk lab`.

1. Web and server strings, with `tests/remote.test.ts` if it needs it.
2. The browser spec, in the same commit as the status wording it asserts.
3. The docs. The screenshot needs the app running, so it waits for a go-ahead.
4. `bun run verify`. `bun run test:browser` builds and starts the server (`bun run start`), so it also runs only on a go-ahead. The spec [hasn't been run against the current build](workspace.md#as-built), so a failure there may not come from this change.
