# Vision tracker

Apple Vision's object tracker (`VNTrackObjectRequest`, revision 1) as a small Swift helper the live watcher runs on Apple silicon, with `VISION_TRACKER=true`. It is part of macOS: nothing to download, and the helper is about 100 KB.

It steers layer 1 instead of replacing it. Each frame, the watcher sends the boxes of the things that may have moved (motion around them, or lost) and Vision says where it sees each one. `stepLocalTrack` searches a little way around that box first (`LOCAL_TRACK.hintRadius`), and the template still has to match there, with the other things' boxes excluded as before. When it doesn't match, the usual search runs as if there were no hint. So a thing carried faster than the search radius is followed, and Vision can't move a thing onto a look-alike or judge a zone.

`apps/server/src/vision-tracker.ts` builds it with `swiftc -O` into `DATA_DIR/bin/vision-tracker-<hash of main.swift>` the first time the live watcher starts (about a second), and spawns it once. The protocol is at the top of `main.swift`: a JSON line and the grey frame's bytes in, a JSON line out. A frame it hasn't answered within 250 ms stops it, and the watcher goes on without it.

## Measured (November 4, M4 Pro, 320 × 240 grey, the watcher's own frames)

| What                                 | Result                                                      |
| ------------------------------------ | ----------------------------------------------------------- |
| 8 things, round trip from Bun        | 3.4 ms a frame (one `perform` for all; one each cost 16 ms) |
| Per thing, in the helper             | about 0.35 ms; 16 at 1030 × 772 about 14 ms                 |
| Memory                               | a few MB, even at 16 things                                 |
| A made-up thing carried 7 px a frame | followed on all 41 frames, at most 0.5 px off               |
| First build                          | about 1 s                                                   |

Revision 2 (the default) was set aside: on the same frames it cost 3–5 cores and up to 900 MB for 16 things, and failed with "unexpected tracked object bounding box size" after about 100 frames on some boxes.

Not measured yet: real things carried, hidden or swapped on a marked clip (`bun run bench:track`).
