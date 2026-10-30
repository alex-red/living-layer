# Plan: always-on tracking

Status: planned. Builds on the [Tracking](../architecture.md#tracking) section of the architecture and on [fixtures.md](fixtures.md), both built. Changes two decisions made there: fixtures can now be tracked, and rules fire with no tab open.

## Goal

1. **The server watches the camera.** Rules fire whether or not a lab tab is open. A tab shows what the watcher sees; it doesn't do the watching.
2. **Anything in view can be followed: objects and fixtures alike.** A mouse that gets pushed across the desk moves in the room. A lamp that is carried away shows as missing. A wall switch that never moves costs almost nothing to watch.
3. **Cheap per frame, billed only when it matters.** Most frames need no model at all. SAM stays the only thing a rule's verdict comes from.

## What changes in the design

- **"Objects move, fixtures stay" becomes "objects are watched, fixtures are acted on, and either can move."** A fixture is still placed by hand and still carries a control. Once it has been found in the camera view, it is followed like an object: its place in the room follows it, and it can be the subject of a rule (_when the mouse is inside this zone, turn on the monitor_). A fixture that was never found in view stays exactly where it was placed, as today.
- **The local tracker moves from the browser to the server.** `packages/domain/src/tracker.ts` is pure code, so it runs on the server unchanged. `Follow locally` in the lab becomes `Watching`, a switch on the server that is kept in desk memory and resumes after a restart.
- **The lamp still only fires on a SAM observation.** Unattended, that matters more, not less: a wrong local guess would switch a real light with nobody there to see why.

## The layers

Each layer runs only when the one before it can't decide. Every tracked thing has a region of the frame to watch: its last box grown by its own size on each side, as `frameMotion` already uses.

| Layer | Runs when                                    | Cost per thing        | Does                                                                                                |
| ----- | -------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| 0     | every sample (10 a second, 320 px grey)      | microseconds          | `frameMotion` over the thing's region. Nothing changed means nothing to do.                         |
| 1     | its region changed                           | under a millisecond   | Masked template match near the last box (`stepLocalTrack`), the stillness gate and the lead check.  |
| 2     | layer 1 is unsure, or a look-alike is close  | 10–30 ms, local model | Find it again by appearance: patch features of the frame against the thing's prototype.             |
| 3     | a zone edge is crossed, or layer 2 is unsure | one billed SAM call   | The authority. `desk/track` / `desk/objects/track` as today; rules decide on this observation only. |

### Layer 2: finding a thing again by appearance

Template matching breaks on big turns, size and lighting changes, low contrast (a white mug on a white shirt) and look-alikes. Each of those is a SAM re-anchor today, and two mugs swapping places fools it.

- **Model:** DINOv3 ViT-S/16, a self-supervised feature model from Meta (about 21M parameters, about 45 MB in fp16). DINOv2-small (Apache-2.0) is the fallback if DINOv3's licence doesn't suit. No training and no labels.
- **Prototype:** when SAM confirms a thing, the frame is embedded and the patch features inside its mask are averaged into a prototype. Up to four are kept per thing, from different sightings, so a turned mug still matches one.
- **Search:** embed the search area at 448 px, take the cosine similarity of every patch with each prototype, and read the box from the peak. The gap between the best and second-best peak plays the role `lead` plays in layer 1. A confident peak restarts layer 1 there, with a template cut from the last SAM frame as now. An unsure one goes to layer 3.
- **What it's not:** a verdict. Like a local box, it is a reason to look again.
- **Not a detector.** YOLO-style detectors find kinds of things, not this mug. YOLOE's example-prompted detection is AGPL. SAM-style video trackers (EdgeTAM, SAM 3 video) keep full masks but are too heavy to run all the time. None of them is needed when the camera is fixed and every thing's last place is known.

### Fixtures that don't move

A wall switch or a ceiling lamp sits in layer 0 forever: its region doesn't change, so nothing runs. When something does change there (a hand passes), layer 1 checks it's still in place and it goes quiet again.

## Fixtures in the camera's view

- **Finding it once.** A fixture becomes tracked when it has a confirmed mask in a camera frame, the same rule as objects: identity is always a person's call. A fixture drafted with `Box it on the desk photo`, or found by a room scan, already has one and only needs confirming. For one drafted from a separate photo, `Find in camera` projects its place in the room through the pin (`projectPoint`) to an expected box and sends that to SAM as a box prompt (`segmentBoxes`). The person confirms the outline.
- **State.** `Fixture.track` (new, optional):

  ```ts
  track?: {
    observation: DeskObservation; // the last SAM-confirmed sighting, like an object's
    history: DeskObservation[]; // newest first, up to 12
    status: 'seen' | 'moved' | 'missing' | 'out-of-view';
  };
  ```

  - `seen`: still where SAM last confirmed it.
  - `moved`: SAM confirmed it somewhere new. Its `at` and `surfaceId` are set from the new box through the pin (`projectBox`, then `settleFixtures`), so the room follows it.
  - `missing`: layers 1–3 couldn't find it. It keeps its last place in the room, drawn faded.
  - `out-of-view`: its scene isn't the pinned one, or its place projects outside the frame. Never watched.

- **Moving it by hand** in the room clears `track`, since the old sighting no longer says where it is.
- **Rules.** A rule's subject (`objectId`) can be a tracked fixture. `objectById` already finds fixtures, and `ruleGate` is unchanged. The rule editor lists tracked fixtures after objects. A fixture can't be the subject and the target of the same rule.
- **Budget.** At most `MAX_FIXTURES` (12) fixtures plus five objects. Fixtures count towards the same SAM calls; see [Spending, unattended](#spending-unattended).

## The watcher

`apps/server/src/watcher.ts`, started with the server.

- **Which camera.** Desk memory gets `camera: { streamId, rtsp }`, set when the person marks the camera fixed (`POST /api/desk/camera`). The watcher only runs on a fixed camera, since every zone and pin assumes one.
- **Frames.** A child `ffmpeg` (spawned with an argument list, no shell) reads the stream's RTSP URL and writes two outputs:
  - grey frames at 10 a second, 320 px wide, raw on a pipe, for layers 0–2
  - a full-size JPEG twice a second; the newest one is kept for SAM.

  `share-camera.sh` already serves RTSP beside WHEP and already needs ffmpeg. `CAMERA_STREAMS` accepts `rtsp://` URLs as well as WHEP ones. A camera that offers only WHEP can be watched in a tab but not by the server (see [Open decisions](#open-decisions)). If ffmpeg exits, the watcher restarts it with backoff and the lab shows the camera as lost.

- **Running layer 2.** ONNX Runtime with the CoreML provider on macOS and the CPU provider elsewhere. Whether `onnxruntime-node` loads under Bun isn't known yet; if it doesn't, layer 2 runs in a small Node child process spoken to over stdin and stdout. The weights are downloaded once into the data directory with a pinned checksum, never bundled, and `bun run doctor` reports them.
- **Calling SAM.** The watcher calls the same functions the `desk/track` and `desk/objects/track` routes call, with the kept JPEG. Every call and every decision is recorded as a run with its reason, as today. Watcher events that cost nothing (lost, found again by layer 2, missing) go to the activity drawer, at most one per thing every 10 s.
- **The lab.** `GET /api/watch/events` is a server-sent event stream: each thing's box, which layer placed it, its status, and the watcher's state (`watching`, `paused: spending limit`, `camera lost`). `POST /api/watch` turns watching on or off. The canvas draws the boxes over the tab's own WHEP playback, so the picture stays at ~100 ms latency. The browser's local tracker is retired once the watcher covers it.
- **Demo mode.** A synthetic source replaces ffmpeg: the illustrated desk at the mug's `DEMO_POSITIONS`, and each mug move is a new frame. Layer 2 is skipped unless its weights are present. The tests run the real loop this way.

## Spending, unattended

With nobody watching, a stuck re-anchor could spend the day's budget overnight. So:

- Re-anchors keep their backoff (2 s up to 30 s) and add a per-thing cap: a thing still missing after three re-anchors is marked `missing` and is only looked for again when layer 0 sees its old region or its zones change.
- Confirms keep the 2 s minimum gap.
- The daily spend limit is enforced as today. When it's reached the watcher keeps following locally, rules pause, and the lab's spend pill and the watcher state say so. Nothing fires on a local box to make up for it.

## Build order

1. **Spike.** In Bun: ffmpeg RTSP to grey frames from `share-camera.sh`, and DINOv3 ViT-S through `onnxruntime-node` on this Mac. Time both. Decide Bun or a Node child for layer 2.
2. **Watcher in demo mode.** Layers 0–1 on the server with `tracker.ts`, the event stream, `Watching` in the lab, resume after restart. Tests with the synthetic source.
3. **Live frames.** ffmpeg ingest, `camera.rtsp` in desk memory, `rtsp://` in `CAMERA_STREAMS`, doctor checks for ffmpeg.
4. **Rules from the watcher.** Confirms and re-anchors through the existing track paths, the spending rules above. Try it with the tab closed.
5. **Tracked fixtures.** `Fixture.track`, `Find in camera`, `at` following SAM, fixtures as rule subjects, the faded `missing` look.
6. **Layer 2.** Prototypes on each SAM confirm, re-finding, the look-alike case. A bench on recorded clips: re-anchors per hour with and without it.
7. **Docs.** Architecture's Tracking and Fixtures sections; "As built" here.

## Open decisions

- **Phones.** A paired phone streams peer to peer to the lab tab; the server only carries the SDP, so it never sees the frames. To be watched without a tab, the phone would publish (WHIP) to a mediamtx the lab runs, and the watcher would read that. Until then, a phone camera is tab-only.
- **More than one camera.** One fixed camera for now, matching one pin.
- **Lamp state from the picture.** A shade's brightness could say a light looks on, which would catch a lamp switched by hand. It would be evidence only, never amber: amber stays reserved for a state Home Assistant confirmed.
- **A confident layer 2 match as a verdict.** It would save SAM calls on zone crossings, but breaks "the lamp only fires on a SAM observation". Revisit with the bench from step 6.
