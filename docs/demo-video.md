# Demo video script

Under two minutes, for the hackathon submission. It shows the scene-first flow on a real desk, live, then the lamp. Record at 1440 × 900 with the browser's zoom at 100%.

## Before recording

- `.env` has `MODEL_API_KEY`, `META_LIVE_ENABLED=true`, the Home Assistant variables and `HA_LIVE_ENABLED=true`. `bun run doctor` is clean.
- The spend pill shows room for about 6 calls: the photo draft (2 or 3), finding the desk (1), the mug's outline (1) and a couple of tracks.
- A network camera (or the laptop's) points down at the desk from behind the monitor. The mug starts outside the spot it will be moved to.
- **Reset everything to demo** from the ⋯ menu, then switch to **Live**, so the lab opens on the first screen.
- Close other tabs; turn notifications off.

## Shots

| Time      | On screen                                                                                                                                         | Say                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:10 | The first screen.                                                                                                                                 | "Living Layer gives the objects on your desk a memory, so your smart home can react to them. It starts with the room."    |
| 0:10–0:35 | **Photograph your office**, upload the room photo. The review: outlines on the photo, the drafted iso room, the match percentages. Drag a corner. | "Spark lists what's in the photo. SAM outlines all of it in one call. Everything else, the camera included, is measured." |
| 0:35–0:45 | Tick the mug, **Save scene and track 1**. The outline fills in.                                                                                   | "I review it, tick what to track, and save. The outline on the left is also my checklist."                                |
| 0:45–1:00 | Select **Desktop** in the outline. **Camera** under the canvas, **Capture frame**, **Find it again**. Corners appear; **Save pin**.               | "Now the desk, up close. SAM finds it and its corners are measured. I just check them."                                   |
| 1:00–1:15 | **Mug zone**, **Draw / edit zone** around the coaster, **Save zone**. **Split** view: the zone on the photo and on the iso desk.                  | "When the mug is in this zone, turn on the lamp. The zone shows on the photo and on its twin."                            |
| 1:15–1:35 | Move the real mug onto the coaster. **Capture & track**. The status line reads that the lamp turned on; the room warms up; cut to the real lamp.  | "I move the mug and track it. The lamp turns on, and only on entering the zone."                                          |
| 1:35–1:50 | Open the activity drawer: the runs, each with its model, time and cost. Open the placement run.                                                   | "Every model call and every decision is kept with its reason, so you can check what happened."                            |
| 1:50–2:00 | Back to the split view.                                                                                                                           | "Living Layer. Your desk, with a memory."                                                                                 |

## If something goes wrong

- The room photo's pin only fits frames of its own size, so the desk is pinned again on the camera frame (the 0:45 shot). Skipping it leaves the mug off the iso desk.
- The photo draft finds no desk: drag the corners in review, or pin by hand later. Don't re-record the call; it costs.
- **Find the desktop** says no desk was found: **Pin by hand**, four clicks from the back left.
- The lamp doesn't turn on: the rule only fires on entering. Move the mug out, track, move it back, track.
- For a fully offline take, use **Demo** mode: the same steps on the illustrated desk, with a virtual lamp.
