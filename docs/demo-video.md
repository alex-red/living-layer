# Demo video script

Under two minutes, for the hackathon submission. It shows the scene-first flow on a real desk, live, then the lamp. Record at 1440 × 900 with the browser's zoom at 100%.

## Before recording

- `.env` has `MODEL_API_KEY`, `META_LIVE_ENABLED=true`, the Home Assistant variables and `HA_LIVE_ENABLED=true`. `bun run doctor` is clean.
- The spend pill shows room for about 6 calls: the photo draft (2 or 3), finding the desk (1), the mug's outline (1) and a couple of tracks.
- A fixed camera is mounted high in the room's front corner, looking diagonally across the floor from above. The mug starts outside the spot it will be moved to.
- **Reset everything to demo** from the ⋯ menu, then switch to **Live**, so the lab opens on the first screen.
- Close other tabs; turn notifications off.

## Shots

| Time      | On screen                                                                                                                                                                                                                                                         | Say                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:10 | The first screen.                                                                                                                                                                                                                                                 | "Living Layer gives the objects on your desk a memory, so your smart home can react to them. It starts with the room."     |
| 0:10–0:30 | **Photograph your office**, then **Camera**, **Capture frame** and **Use the current photo** (or **Upload a photo**). The review: outlines on the photo, the drafted iso room, the match percentages. Drag a corner if needed.                                    | "Spark lists what's in the photo. SAM outlines all of it in one call. Everything else, the camera included, is measured."  |
| 0:30–0:40 | Tick the mug, **Save scene and track 1**. The outline fills in.                                                                                                                                                                                                   | "I review it, tick what to track, and save. The outline on the left is also my checklist."                                 |
| 0:40–0:55 | Select **Desktop** in the outline. The room camera is mounted high in the front corner: drafting from a photo fits the room camera and auto-pins the desk in one go (or on the preset office, **Calibrate the camera** fits from the far corner and floor lines). | "The camera is mounted high in the front corner. Drafting fits the camera and auto-pins the desk in one go from geometry." |
| 0:55–1:10 | Under Home Assistant in the outline, click **Expose to Home Assistant** (or **Show in Home Assistant**) and add an entity. Label motion-based occupancy accurately (motion in the room, not proof a person is present).                                           | "I expose an entity to Home Assistant, accurately labelled as motion in the room rather than proof a person is present."   |
| 1:10–1:25 | **Main zone**, **Draw / edit zone** around the coaster, **Save zone**. **Split** view: the zone on the photo and on the iso desk.                                                                                                                                 | "When the mug is in this zone, turn on the lamp. The zone shows on the photo and on its twin."                             |
| 1:25–1:40 | Flip **Watch on the server** to run unattended in the background. Move the real mug onto the coaster. The status line reads that the lamp turned on; the room warms up; cut to the real lamp.                                                                     | "With server-side watching on, the tab can close. I move the mug and the lamp turns on upon entering."                     |
| 1:40–1:50 | Open the activity drawer: the runs, each with its model, time and cost. Open the placement run.                                                                                                                                                                   | "Every model call and every decision is kept with its reason, so you can check what happened."                             |
| 1:50–2:00 | Back to the split view.                                                                                                                                                                                                                                           | "Living Layer. Your desk, with a memory."                                                                                  |

## If something goes wrong

- The corner camera needs both floor lines visible to fit automatically; if furniture hides one, drag the corner in **Calibrate the camera** by hand. The desk is auto-pinned by the room camera.
- The photo draft finds no desk: drag the corners in review, or pin by hand later. Don't re-record the call; it costs.
- The lamp doesn't turn on: the rule only fires on entering. Move the mug out, track, move it back, track.
- For a fully offline take, use **Demo** mode: the same steps on the isometric office rendered through `DEMO_CAMERA`, with a virtual lamp.
