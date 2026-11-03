# Plan: many things at once

Status: proposed. Builds on [tracking.md](tracking.md) (always-on watching, built). [current.md](current.md) defers new tracking work until the submission checks are done, so phase 0 is the only part that fits before November 4; the rest comes after.

## Goal

1. **Follow up to 16 things at once**, objects and fixtures, in one fixed camera, at the watcher's 10 grey frames a second, with rules updated at 2–5 Hz.
2. **Never swap two look-alikes.** Two white mugs that cross, or one carried behind the other, keep their own ids. When the watcher can't tell them apart, it says so and rules wait; it never guesses.
3. **SAM calls grow with what changed, not with how many things there are.** Ten things on a still desk cost what one does today. Two things moved at once cost one SAM call, not two.

## Where it stands

The watcher already follows several things: the mug, up to four other objects (`MAX_OTHER_OBJECTS`) and up to 12 fixtures. But every layer treats each thing as if it were alone:

- **Layer 1** (`stepLocalTrack`) matches each thing's template near its last box with no knowledge of the others. Two mugs side by side can both lock onto the same one; nothing stops two boxes sitting on the same pixels.
- **Layer 2** (`refind`) embeds a search region per lost thing, about 500 ms at 896 px each, and takes each thing's best peak on its own. Two lost mugs both "find" whichever matches better.
- **Layer 3** (`check`, `ask`) queues SAM one thing at a time. Two mugs that both cross a zone edge cost two calls on two different snapshots with the same concept. Each answer goes through `pickTracked`, which greedily takes the detection overlapping the last box most, so two things can be given the same detection, and the second ask can move a thing onto its neighbour.
- **Identity** is never in doubt as far as the code is concerned: a thing is `following`, `unsure` or `missing`, but nothing says "this is one of two mugs and I don't know which".
- **`bench:track`** measures cost per layer and per thing, with made-up things on textured patches. It has no ground truth, so it can't count an identity swap.

## What the research note changes, and what it doesn't

The note recommends SAM 3.1 (multiplexed video tracking) for accuracy and YOLOE-26 + BoT-SORT as a light baseline, and ends on the right question: discover every object automatically, or pick 5–20 once and follow only those?

- **We pick once.** Identity is a person's call (tracking.md); a thing is followed only after someone confirms its outline. So we need a tracker of chosen things, not an open-vocabulary detector. SAM's concept prompt already covers discovery when a person asks for it.
- **YOLOE / YOLO26 are out for shipping.** Ultralytics weights and code are AGPL-3.0, the reason tracking.md already set them aside. They can be an offline yardstick on recorded clips (phase 5), nothing more. The useful idea from that stack is the tracker, not the detector: **BoT-SORT/OC-SORT's motion model and joint assignment** are a few hundred lines of pure code and fit our layers directly (phase 2).
- **"Process every frame, report at 2–5 Hz"** is what the watcher does already (10 grey frames a second, rules on SAM confirmations). Keep it: the stillness gate and crossing detection need the 10 Hz.
- **SAM 3.1 Object Multiplex** needs CUDA; the official code has no MPS path, and the hosted Meta API we call is image-only. Its throughput figures are on an H100. It's worth a measured experiment on the RTX 4090 as an optional worker (phase 5), not a dependency. The lesson we can apply now with the image API is the multiplexing itself: **one SAM call for every thing that needs one** (phase 3).
- **EdgeTAM** (CoreML export) is the on-Mac candidate for the same experiment.

## Phase 0: measure identity (before anything changes)

You can't fix swaps nobody counts.

- **Clips with several things.** `bun run bench:track capture --name mugs-swap` already records the watcher's own input. Record five scenarios, 30–60 s each, on the office camera:
  1. `still-16`: sixteen things on a still desk, nobody touching them (cost floor).
  2. `swap`: two look-alike mugs swapped by hand.
  3. `cross`: one mug carried past another, briefly hiding it.
  4. `out-and-back`: a thing carried out of view and put back somewhere else.
  5. `busy`: four things moved within ten seconds, two across zone edges.
- **Truth.** A `<clip>.tracks.json` beside each clip: for every thing, its box on keyframes (every 10th frame), marked on a gridded keyframe (`bun run bench:track truth <clip>`). Mark only what the frame shows; a hidden thing is marked hidden, not guessed. Only marked keyframes are scored, nothing is interpolated.
- **Metrics,** added to `bench:track`:

  | Metric         | What it says                                                        |
  | -------------- | ------------------------------------------------------------------- |
  | ID switches    | times a thing's box moved onto another thing's truth                |
  | IDF1           | share of frames each thing is on its own truth (IoU ≥ 0.5)          |
  | False sure     | frames a thing is `following` on the wrong thing (worst kind)       |
  | Honest unsure  | frames a thing is `unsure`/`ambiguous` while it really is ambiguous |
  | SAM calls      | per clip and per hour, by reason (confirm, reanchor)                |
  | Cost per frame | as today, at 1 / 5 / 10 / 16 things                                 |

- **SAM offline.** The bench can't call SAM. Recorded answers wouldn't do either: a changed watcher asks on other frames. So each ask is answered from the marks: every marked box of the thing's concept on the nearest keyframe (within a second), without ids, as SAM answers. That is a perfect SAM, so what's judged is the following and which detection is taken (`pickTracked`), not SAM. A SAM that misses small things is a later option.
- **Targets** (`TRACK_TARGETS`, shared with the tests as `ROOM_TARGETS` is): zero false-sure frames on every clip; ID switches 0 on `swap` and `cross`; SAM calls on `still-16` no more than on a 1-thing clip; cost per frame at 16 things under 10 ms. Write the baseline numbers here before phase 1.

### Phase 0 as built

- `bun run bench:track truth <clip> …` (`scripts/track-truth.ts`): `thing`, `zone`, `frame` (a gridded keyframe, `--zoom`), `add` (a box or `hidden`), `copy` (one keyframe's marks over a still stretch), `remove`.
- `scripts/lib/track-truth.ts`: the marks, `replayClip` (the watcher's own `watchStep`, `asked`, `missed` and `pickTracked` over every frame, a thing starting on the first keyframe it is marked), `scoreReplay` and `TRACK_TARGETS`.
- `bun run bench:track <clip>` prints an identity table per thing when the clip has marks: IDF1, switches, false sure, honest and needless unsure, asks and wrong picks.
- Tests on made-up frames (`tests/track-truth.test.ts`) already show the look-alike failure: a mug carried off, with an identical one still in view, is found by its whole-frame search on the other one and followed there, sure, with two boxes on the same pixels and no SAM call. That test is to change when phase 1 makes it an honest `unsure`.
- Tried on a copy of `office-still` with the mug marked: IDF1 1.00, no asks, meets its targets.

Still to do, by hand: record the five clips and mark them, then write their baseline here. Recording needs the office camera and someone moving the mugs.

## Phase 1: one owner per pixel (layer 1)

The cheapest fix: things stop competing for the same place.

- **Step all things together.** `watchStep` per thing becomes `watchFrame(things, frame)`, which steps every thing and then resolves claims. The per-thing logic stays in `watchStep`; the new function only adds the joint part.
- **Exclusion.** After matching, if two things' boxes overlap by more than `MULTI.claimIoU` (0.3), the one with the weaker score and lead is re-matched with the other's box masked out of its search. If it can't find a lead above `LOCAL_TRACK.minLead` elsewhere, it holds its box and turns `unsure`.
- **Second peaks are worth keeping.** `matchTemplate` already computes the runner-up for `lead`; return its box too. When a look-alike thing's box is near a thing's runner-up peak, `lead` is judged against the neighbour's position, not as noise.
- **Entangled pairs.** When two things of the same concept come within one box width of each other while either is moving, both become `entangled` (new status, a kind of `unsure`): boxes held, rules for both wait, no SAM call yet. When they separate and the scene is still (`quietSteps`), they are resolved together in phase 3's joint ask, never one at a time.
- **Measured by** ID switches on `swap` and `cross`, and false-sure frames everywhere. Cost: one extra mask-out re-match only when boxes collide, so `still-16` should not move.

## Phase 2: motion and joint assignment

What the SORT family gets right, on our own boxes.

- **A motion model per thing.** A constant-velocity Kalman filter in unit coordinates (centre, size; velocity on centre only), stepped every frame, reset on each SAM confirmation. It moves the search region ahead of a thing being carried, instead of centring it on the last box, and gives the expected box after a short occlusion. Things on a desk are mostly still, so the process noise is low and the filter mostly says "it's where it was"; it earns its keep on `cross` and `out-and-back`.
- **Joint assignment** (`assignTracks`, pure, in `packages/domain/src/assign.ts`). Given candidate boxes (local matches, appearance peaks, or SAM detections) and the things that want them, build a cost matrix and solve it with the Hungarian algorithm (16 × 16 is trivial). The cost combines:
  - IoU with the motion model's predicted box (as BoT-SORT),
  - appearance distance: cosine between the candidate's patch features and the thing's prototypes (phase 4), when there are any,
  - concept mismatch (infinite: a mug never takes a book's detection),
  - a gate: a pair farther than `MULTI.gate` is not allowed, so a thing can go unassigned rather than take a far detection.
- **Margins, not just winners.** For each assigned thing, the cost of the best alternative assignment (swap it with the next thing) gives an identity margin. A margin under `MULTI.minMargin` leaves both things `entangled` instead of `following`, exactly as `lead` does for one thing.
- **`pickTracked` goes.** Every place that maps detections to things (the watcher's ask, `trackObject`, `trackFixture`, `trackMug`, the lab's manual track) calls `assignTracks` for all things of that concept at once. A detection is given to at most one thing; one left over is reported ("SAM sees another mug") but never attached to anything without a person.
- **All tunables in one place:** `MULTI` in `watch.ts`, swept with `bun run bench:track --set multi.gate=…` like `LAYOUT_TUNING`.

## Phase 3: one SAM call for many things (layer 3)

SAM 3.1's multiplexing, done with the API we have.

- **Batch the queue.** `check()` stops taking `pending[0]`. It takes every pending thing whose ask is due, groups them by concept, and makes one call per group on one snapshot. Things of different concepts that are due together share a snapshot, so the assignment of one can't be stale against another.
- **Box prompts for many things at once.** For things whose place is roughly known (a confirm, or a reanchor with a motion-model guess), use `segmentBoxes` (already up to 16 boxes in one call, `maxMasks: 16`) with each thing's predicted box grown by its own size. One call, one mask per thing, ids by prompt order. A thing with no usable guess (missing, out-and-back) goes in its concept's text call instead.
- **Assignment on the answer.** Text-prompt detections go through `assignTracks` with every thing of that concept, not just the ones that asked: a call made for one mug also confirms the others it sees, at no extra cost. A box-prompt mask that overlaps another thing's box more than `MULTI.claimIoU` is treated as unresolved for both.
- **Entangled pairs resolve here.** When an entangled pair separates, both are asked in one call and assigned jointly, with appearance in the cost (phase 4). If the margin is still too small, the lab asks the person: two outlines, "Which is My desk mug?" — the same kind of question `askPerson` already asks for an empty zone.
- **Spending.** The per-thing back-off and `maxMisses` stay; the 2 s confirm gap becomes per call, not per thing. Expected effect: on `busy`, SAM calls drop from one per moved thing to about one per burst. Measured on the replayed clips.
- **Rules.** A rule decides only on things whose last state came from SAM with a margin above `minMargin`. An `entangled` thing holds its last verdict; nothing fires on it, the same rule as "the lamp only fires on a SAM observation".

## Phase 4: appearance that tells look-alikes apart (layer 2)

Today's prototypes answer "is this a mug?". With two mugs the question is "is this my mug or the other one?".

- **One embedding per frame, for every lost thing.** `refind` per thing becomes `refindAll`: one embed of the union of all lost things' search regions (or the whole frame at 896 px when several are lost, about 500 ms, once), then every thing's similarity map from the same grid, and `assignTracks` over the peaks. Cost stops growing with the number of lost things.
- **Discriminative prototypes.** When two followed things share a concept, keep each thing's prototypes and also its look-alikes' ones; a thing's score is its own similarity minus the best look-alike's at that place. Two white mugs that differ only by a logo or a handle side then lead each other by more than the raw score would, and the gap is the margin phase 2 needs. Measured by the lead between the two mugs on the `swap` clip.
- **Prototype hygiene.** Prototypes are learned only from SAM masks with a margin above `minMargin` and no overlap with another thing, so an entangled frame never teaches a thing the other's look.
- **Close-ups help most here.** Across a room a mug is about 17 × 23 pixels. [streaming.md](streaming.md) phase 3 (full-resolution stills) is what makes two mugs tell apart; until then the bench will show where the 448 px grid can't, and phase 3's "ask the person" covers it.

## Phase 5 (experiment): a video tracker as a worker

Only if phases 1–4 leave swaps or SAM calls the bench can't get under target.

- **Candidates,** run offline on the recorded clips against the same truth and metrics, with the same initial masks the watcher had:
  - SAM 3.1 video predictor with multiplexing, on the RTX 4090 (CUDA). Check the SAM licence's terms for our use first.
  - SAM 2.1 / EfficientTAM, on the Mac (MPS) and the 4090.
  - EdgeTAM through CoreML on the Mac.
  - YOLOE-26s + BoT-SORT as a yardstick only (AGPL, never shipped).
- **What it would replace.** Layers 1–2 for things in an entangled pair or a busy burst, not the whole watcher: the stillness gate and layer 0 keep a still desk at microseconds. SAM through the API stays the authority for rules, so a worker's mask is a reason to look, like a local box today.
- **Shape.** A small HTTP worker (`TRACKER_WORKER_URL`) that takes the full-size stills the watcher already keeps and masks to start from, and streams boxes back. Off unless configured, like `SAM3D_ENABLED`. `bun run doctor` reports it.
- **Decide by:** ID switches and false-sure frames on `swap`, `cross` and `busy` versus phases 1–4, frames a second sustained at 16 things, and the latency from still to box. Keep it only if it removes swaps the cheap path can't, at ≥ 5 Hz on the 4090.

## Phase 6: lift the caps and show it

- **Limits.** `MAX_OTHER_OBJECTS` 4 → 15 (16 things with the mug, matching `segmentBoxes`' 16 masks). `MAX_FIXTURES` stays 12, but the watcher's total of followed things is capped at 24 with a clear message. Raise only after phase 0's `still-16` numbers show the cost holds.
- **Remembering several at once.** The lab's "remember these" already takes a list (`track` in `desk.ts`); with phase 2 the ids come from one assignment, so two mugs ticked in one frame can't be given the same detection.
- **The canvas.** Each thing's box in its own colour from the categorical palette, its label, and a dashed outline with "which one?" while `entangled`. The activity drawer gets "The two mugs crossed; checking which is which" and the outcome.
- **The demo.** A second mug in the demo office (`demo-room.ts`), with a demo move that swaps them, so the tests and the video show the hard case. Its frames and masks come from the render, as the first mug's do.

## Build order

0. Clips, truth marking, replayed SAM answers, the metrics. Baseline written here. (Fits before the submission: no runtime change.)
1. `watchFrame`, exclusion, entangled status.
2. Kalman motion, `assignTracks`, margins; `pickTracked` replaced everywhere.
3. Batched SAM asks with box prompts; joint resolution of pairs; "Which one?" question.
4. `refindAll`, discriminative prototypes.
5. Worker experiment, only if the bench calls for it.
6. Caps, canvas, demo's second mug, docs (architecture's Tracking section; an "As built" here).

Each phase: `bun run bench:track` on every clip before and after (`bun run bench:at HEAD track` once the bench has a truth mode), unit tests of the pure parts (`assignTracks`, `watchFrame`, the Kalman step) with made-up frames, and the watcher end to end in demo mode.

## Not doing

- **Automatic discovery of everything in view.** A person picks what is followed; SAM's text prompt finds candidates when asked.
- **Shipping an AGPL detector.**
- **Firing a rule on a local or worker box,** however confident. Unchanged from tracking.md.
- **More than one camera.** Still one fixed camera per room.

## Open decisions

- **How many things really matter?** 16 is the API's mask limit, not a need. If the real use is the mug plus four, phases 1–3 matter and 6's limits don't.
- **Asking the person.** When two look-alikes can't be told apart, is a "Which one?" prompt acceptable, or should the pair just stay `entangled` until one moves alone?
- **The 4090.** Is it reachable from the lab's machine on the LAN, and allowed to run always-on? Phase 5 depends on it.
- **Overlap with other sessions.** `watch.ts`, `desk.ts` and `memory.ts` have uncommitted zone-event changes from another session; phase 1 starts after those land.
