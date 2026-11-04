# Making the demo video

How to turn `docs/demo-video.md` into a three-minute video that looks made rather than screen-grabbed, and stays cheap to re-take while the UI is still changing (`docs/plans/demo-ui.md`). Written 2026-11-03, with a working proof of one section (below).

## The script, reviewed

What holds up: it opens on the result, names each Meta model as it acts (Meta tooling is 25% of the score), burns in captions, and plans for failure. Judges are often told to stop at 3:00, so the budget is hard.

What to change:

1. **Two rows are broken.** 0:15–0:35 and 1:05–1:15 have an extra empty cell, so their narration renders in a fourth column with no header. Delete the empty `|  |`.
2. **16:10 vs 16:9.** 1440 × 900 is pillarboxed by YouTube, Devpost and Vimeo. Record at **1600 × 900** (the proof does): same height, so the layout the UI pass was tuned for barely moves, and it maps cleanly to 1920 × 1080 and 3840 × 2160.
3. **1:50–2:20 is overloaded.** The mug's card, the fridge, Home Assistant, Your day at 45× and a typed question with a cited answer, in 30 s, against a 30-word line. Keep the mug card, Your day and the answer (that's the "memory" payoff); move Home Assistant to the 2:20 cutaway; drop the fridge to a 2 s pass in the 0:15 tour, where it already appears.
4. **The cold open needs a second camera and a sync plan.** "A hand sets the mug… cut to the real lamp" is a phone shot, not a screen shot. Nothing in the script says how the two line up: see _Real-world shots_.
5. **Speed ramps need to be marked per shot.** "Setup shots run at 2–4×" should name which beats are fast (photo capture, the Spark/SAM wait) so the editor (or the compose script) applies them without guesswork.
6. **Small things read poorly on video.** In the proof, the demo mug's move from Centre to Right barely reads at 1080p even zoomed on the desk. Every "watch this change" beat needs a zoom target.
7. **Voice lines vs time.** At about 150 words a minute the 2:20 line (45 words) needs 18 s of its 25 s: fine. The 0:35 line fits too. Keep every line under 2.5 words per second of its shot.

## What's out there (November 2026)

| Approach                           | Examples                                                                               | Good at                                                                                   | Why not (alone) here                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Recorder with automatic zoom (Mac) | Screen Studio                                                                          | auto-zoom on clicks, smoothed cursor, nice export, minutes to learn                       | every re-take is by hand; the UI is still changing, so a shot will be redone 5–10 times; zooms follow clicks, not the story |
| Programmatic video in React        | Remotion (also Revideo, Motion Canvas)                                                 | motion graphics, kinetic captions (`@remotion/captions`, Whisper.cpp), reusing our own UI | another render stack and dependency; it's a compositor, it doesn't drive the app; company licence above a small team        |
| Playwright-scripted recorders      | DemoForge, playwright-recast, Clipwise, Pagecast (MCP)                                 | a script drives the app, auto-zoom from logged clicks, narration from text                | young projects; generic zoom rules; none paces to our voice over or knows our lamp, zones and Home Assistant                |
| Interactive demos                  | Arcade, HowdyGo                                                                        | click-through tours                                                                       | judges want a video                                                                                                         |
| Voice                              | ElevenLabs (cloning from a short clip), Kokoro 82M (local, Apache 2.0), your own voice | —                                                                                         | macOS `say` (what's installed) is a timing draft only                                                                       |

Sources: [Screen Studio and Remotion overview](https://www.howdygo.com/blog/product-demo-video-production), [Remotion alternatives](https://autoae.online/blog/remotion-alternatives-compared-2026), [Remotion captions/Whisper](https://www.remotion.dev/docs/captions/transcribing), [Remotion TikTok template](https://github.com/remotion-dev/template-tiktok), [DemoForge](https://peerlist.io/dixitram/project/demoforge), [playwright-recast auto-zoom](https://thepatriczek.github.io/playwright-recast/docs/pipeline/auto-zoom), [Clipwise](https://kwakseongjae.github.io/clipwise), [Pagecast](https://mcp.so/server/pagecast/mcpware), [Jodit's own recorder](https://xdsoft.net/blog/ai-powered-demo-video-recorder), [Kokoro vs ElevenLabs](https://www.promptquorum.com/power-local-llm/kokoro-vs-elevenlabs), [hackathon video advice](https://tips.hackathon.com/article/creating-the-best-demo-video-for-a-hackathon-what-to-know), [3-minute pitch](https://blogs.reskilll.com/hackathon-demo-presentation-tips-pitch-3-minutes-win-2026/).

## Decision: roll our own on what we have, borrow the ideas

We already have the hard part: `bun run record` captures the page over the DevTools screencast at device resolution with the app's own pointer marks, and ffmpeg 8 with libass is installed. What the products above add is (a) a script that drives the app, (b) zooms planned from what happens, (c) captions, lower thirds, a voice, music. Each is a few hundred lines on top of `record.ts`, and owning it buys what no tool here does:

- **Voice-first pacing.** Each line's length is known before the take; the director waits on it, so picture and voice can't drift, and a rewritten line re-times the take automatically.
- **Story zooms, not click zooms.** A beat names its target (the mug, the zone's badge, the spend pill), including things that change without a click (the lamp igniting, the zone turning OCCUPIED).
- **Re-takes cost nothing.** A UI change from the polish pass → re-run the shot → same cut. That's the main argument against Screen Studio.
- **Honest lower thirds from the run itself.** The beat log can say when Spark or SAM was actually called (the activity log already times every call), so a label appears when the model acts.

Remotion stays an option for the two moments that are pure motion graphics (cold-open title, end card) if the libass titles look flat. Screen Studio stays the fallback for a shot that refuses to script.

## The pipeline

```
shots/<name>.ts ──► director (Playwright + screencast) ──► take.mp4 (3200×1800) + beats.json
lines (text) ──► voice (draft: say · final: you or ElevenLabs) ──► vo-*.wav ──┘
phone footage ──► sync to beats (lamp/zone event times) ───────────────────────┐
compose (ffmpeg: perspective zoom, xfade, setpts ramps, libass, music ducking, loudnorm) ─► shot.mp4 → film.mp4
check: contact sheet per shot, total ≤ 2:58, loudness, a muted watch
```

1. **Director** (`bun run shot <name>`: `scripts/shot.ts`, `scripts/lib/director.ts`, shots in `scripts/shots/`). A shot is a TypeScript function using a small vocabulary: `say(i)` (start line i, wait for it), `sayOver(i)` (start it and keep acting; `until(t)` waits for its end), `click(locator)` (an eased pointer glide and click), `drag`, `type`, `focus(locator, { part })` / `focus(null)` (a zoom target), `lower(title, sub)`, `title(text)`, `cue(locator)` (wait for the app), `task(title)` (wait out an AI steps dialog), `fast(n)` (an n× stretch). Set-up is off camera; each take starts from **Reset everything to demo** or a saved Live room. Fresh Chrome profile, headless, `--force-device-scale-factor=2`.
2. **Voice.** Lines live beside the shot. Draft with `say` for timing (it's what the proof uses), then record the real thing: your own voice, one file per line, read to the draft timing, beats the best synthetic voice for a hackathon. ElevenLabs is the fallback (a cloned voice from a minute of you). Whatever the voice, the director re-paces to its lengths.
3. **Captions.** From the lines, not from transcription (they're the script). One line per caption, at most about 42 characters a row, cut at phrase ends. Word-by-word highlighting is possible in libass (`\k` tags) if wanted.
4. **Compose.** Per shot: a zoom (`perspective`, sampled at fractional pixels, then one scale) driven by the beats' focus keys (smoothstep, 0.9 s), libass for captions, lower thirds and titles in the app's tokens (`--seen` cyan, `--void`), `setpts` ramps on `fast` stretches with the voice at normal speed. Film: `xfade` between shots (0.3 s), a quiet music bed ducked under the voice (`sidechaincompress`), `loudnorm` to −14 LUFS, H.264 1080p (and 4K from the 2× source if wanted).
5. **Real-world shots.** The phone records the room (hand, mug, lamp, plushie) in 4K. They're synced to the screen take through events both can see: the lamp turning on is at a known time in the activity log and visible on the phone, which is enough to align within a frame. The cold open's split view is composed by ffmpeg (`hstack` with a gutter) from the phone clip and the twin's take, not recorded as one screen.
6. **Check.** Each compose writes a contact sheet (as `out/demo-video/sheet3.png`) and prints the shot's length; the film step fails if the total exceeds 2:58. Watch once muted: captions must carry the story.

## Shot by shot

| Shot        | Capture                                                                     | Zooms and labels                                                                            | Notes                                                                                                                  |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0:00 cold   | phone (hand, mug, lamp) + director in Live, split view                      | composed side by side; title _Living Layer_                                                 | record last; sync on the lamp's ignition                                                                               |
| 0:15 tour   | director, Demo or the saved Live room                                       | room → desk → mug card; fridge 2 s                                                          | **proven** below                                                                                                       |
| 0:35 draft  | director, Live: Capture frame, review, room picture                         | lower thirds **Muse Spark 1.3**, **SAM 3.1**, **Muse Image 1.0** on their calls; wait at 4× | costs about 3 calls a take: rehearse in Demo (`Draft from the demo photo`) until the take is right, then one Live take |
| 1:05 zone   | director                                                                    | the desk's pinned corners, the zone, EMPTY badge                                            |                                                                                                                        |
| 1:15 motion | director + phone (plushie, lamp colour)                                     | MOTION badge; **DINOv3 · on this machine**                                                  | `cue` on the zone reading MOTION, then cut to the phone                                                                |
| 1:25 brush  | director, Live (Spark), boxes dragged by `page.mouse`                       | the box, the panel's steps, the rebuilt desk                                                | try both requests with `bun run brush --around desk` first                                                             |
| 1:50 memory | director, Your day at 45×, typed question                                   | the 15:45 nudge, the cited time                                                             | trimmed per the review                                                                                                 |
| 2:20 server | phone (mug, lamp, monitor) + director reopening the lab; Home Assistant 2 s | the WATCHER pill, the spend total                                                           | the spend number in the voice is filled from the run at compose time                                                   |
| 2:45 end    | the cold open's split, end card                                             | _every thing in your home, with a memory_                                                   |                                                                                                                        |

## Proof: the 0:15 tour, scripted

The first proof, a single script since folded into `bun run shot tour`. In Demo mode, with no model calls: title card over the room, zoom into the iso room, open the desk's close view with an eased pointer glide, zoom on the desk, select the mug (lower third, zoom to its card), move the mug twice with the zoom on the desk, zoom out. Four draft voice lines pace it; captions and lower thirds are burned in.

Result: 21 s, 1920 × 1080 H.264 + AAC, from a 3200 × 1800 take.

Learned on the way:

- A headless screencast arrives at CSS pixels unless Chrome is started with `--force-device-scale-factor=2`; `deviceScaleFactor` alone isn't enough.
- `crop` after a per-frame `scale` keeps the first frame's size, so every zoom sticks to the top-left corner. `zoompan` (crop and scale in one step, time from `in/fps`) works.
- A zoom curve that rounds to 0.99999 makes a frame narrower than the output: ffmpeg dies with SIGBUS and prints nothing. Clamp with `max(1, …)`.
- `st()`/`ld()` shorten ffmpeg expressions but their `;` ends a filter chain: write the sums out.
- The first launch once timed out waiting for the **Demo** button; wait for the page, not a fixed time.

Judged afterwards: `zoompan`'s whole-pixel window did judder (a line fixed in the take moved 9.6, 8.4, 9.7, 11.8, 10.2, 12.1 px a frame mid-zoom); `perspective` samples at fractional pixels and moves it smoothly (… 10.1, 10.5, 10.7, 11, 10.9, 10.7 …), so the zoom uses that now. The draft voice is robotic by design. The iso callout ("CREAM MUG · Nothing kept yet") clips at the pane's edge when zoomed, already listed in `demo-ui.md`.

## Status (2026-11-04)

Built: `bun run shot` (`list`, a shot's name, `all`, `film`; `--compose` re-cuts without recording, `--dry` rehearses). The pure parts (camera curve, ramps, captions, joins) are in `scripts/lib/demo-shot.ts` with unit tests (`tests/demo-shot.test.ts`). Each shot writes `out/demo-video/<shot>/cut.mp4`, `take.json` and a contact sheet `sheet.png`; `bun run shot film` joins the cut shots into `out/demo-video/film.mp4` with cross-fades and loudness at −14 LUFS, and warns past 2:58.

Six shots run end to end in Demo mode, offline: `tour` (0:15), `draft` (0:35), `zone` (1:05), `brush` (1:25), `memory` (1:50), `end` (2:45). Each starts from `POST /api/desk/demo/reset`; the later ones draft the demo frame off camera first (`draftedRoom`), since the reset demo has no mug.

**The voice is left out, with its slot ready.** Lines are captions and pace the take by an estimate (2.5 words a second). Put `<n>.wav` (or `.m4a`, `.mp3`, `.aiff`) for line n in `out/demo-video/voice/<shot>/` (or `--voice <dir>`) and record the shot again: the take waits for each file's real length and the cut mixes it in. Checked with a throwaway recording on `zone`: both lines voiced and audible, the take re-paced from 16.0 s to 14.9 s.

Found while scripting (Demo mode, worth a look before the Live takes):

- **Drag a zone down through the thing.** On the iso desk a screen drag runs along the desk's diagonals: a diagonal drag over the mug made a thin strip beside it, which read "outside" (my mistake, not the app's). Dragged down through the mug, as the browser spec does, it reads "inside, light confirmed". The drafted demo room has no lamp model and its _Right_ / _Front left_ don't move the mug there, so `zone` ends on **Check zones**; the real lamp is the Live take's.
- **The brush asks back on the script's line.** "It's an IKEA Alex desk" alone gets "which would you like?" from the demo's reader (also offline in `bun run brush --around desk`); "Turn this into its own fixture, it's an IKEA Alex desk" builds it. Try the short one live before relying on it.
- **Putting a brushed model in a drafted room is refused** ("the room's camera is calibrated on the Office preset…"), so `brush` uses the preset office.
- **Tracking in Demo** wants _Let tracking call AI_; the shots don't turn it on, since it's server-wide and would also apply to the Live camera.
- The draft's finished-steps card stays in a corner until dismissed; `draftedRoom` dismisses it.

Not yet: Live versions of the shots (`draft`, `zone`, `brush` with real calls), `motion` (1:15) and `server` (2:20), which need the real camera and phone footage, the cold open's phone half, speed ramps in use (`fast` is built and tested, no Demo shot needs it), and music.

## Phases

1. ~~**Director as a tool.**~~ Done (above).
2. ~~**All screen shots in Demo.**~~ Done for the six that Demo can show.
3. **Voice (1–2 h).** Record your lines (or clone); re-run the shots to the real lengths.
4. **Live takes (½ day, about 10 calls).** Switch the shots that need it to Live; phone footage for the cold open, motion, and the server cutaway; sync on the lamp.
5. **Film (2 h).** Joins, music, loudness, end card; a muted watch; export 1080p and 4K; upload unlisted and check in the player judges will use.

## Risks

- Live takes drift (a different SAM outline, the brush asks back): rehearse in Demo, take Live once, keep the take's `beats.json` so it can be re-composed without re-shooting.
- The UI pass changes a selector: shots use roles and names (as the browser suite does), not CSS.
- The dev server's reload card or a toast lands mid-take: always `?recording`; the director's set-up waits for a quiet page.
- Real home footage: the phone and camera clips stay local (`out/`, ignored), like captured rooms.
