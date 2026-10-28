# Architecture

```
browser (apps/web)  ──/api──▶  Fastify (apps/server)  ──▶  Meta Responses API (Spark, SAM)
                                   │                   └─▶  Home Assistant REST API
                                   └─▶  SQLite + files in .data/
```

The browser never talks to Meta or Home Assistant directly. Keys and tokens live in the server's `.env`.

## Modes

Every request carries a `mode`, either `fixture` or `live`.

- **fixture** uses the illustrated desk in `apps/web/public/desk.svg`, hand-written discovery results, a synthetic SAM stream, and a virtual lamp. It never makes network calls. The mug can sit at one of three `FIXTURE_POSITIONS`: the web redraws the desk with the mug offset, the synthetic mask moves by the same amount, and each position counts as its own source image.
- **live** validates and re-encodes an uploaded image with `sharp`, then calls the real services. Each outbound Meta attempt is counted against a per-day limit in SQLite _before_ the request is sent, so failures count too.

Fixture and live have separate desk memory. Fixture runs never count toward the live checklist in the UI.

## Server

| File        | Responsibility                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`    | Routes for the individual probes (`text`, `discover`, `segment`, `lamp`), loopback host/origin checks, and recording each run as an evidence record |
| `desk.ts`   | The placement workflow: select a mug, track it, save a zone, mark the camera fixed, verify, reset                                                   |
| `meta.ts`   | Spark (structured JSON output) and SAM (streamed) through the OpenAI-compatible SDK, with retries disabled                                          |
| `sam.ts`    | Runs the SAM stream through `@meta-sam/parser` and rejects anything incomplete, mismatched, or oversized                                            |
| `lamp.ts`   | Turns one light on, then polls its state to see whether it matches                                                                                  |
| `store.ts`  | SQLite tables for evidence, desk memory, placement claims, and the request budget                                                                   |
| `errors.ts` | `LabError`, and mapping upstream failures to generic messages so provider errors never leak keys or inputs                                          |

## Placement rule

`placementGate` in `packages/domain` makes the decision. A placement is **inside** only when:

- an observation exists for the remembered object and is less than five minutes old,
- a zone was saved on the same source image (zones are tied to a SHA-256 of the prepared image, not to physical coordinates), or the camera is marked fixed and the zone was drawn on a frame of the same size, and
- the whole detection box fits within the zone.

**Fixed camera.** Off by default. When a person marks the camera as fixed, `zoneApplies` lets a zone carry over to any new frame of the same size, and every decision made that way records `assumedFixedCamera: true`. Nothing checks that the camera really stayed put.

**Lamp on entering.** Desk memory keeps the last inside/outside verdict, and each decision records a `transition`: `entered`, `stayed_inside`, `left` or `stayed_outside`. The lamp fires only on `entered`. Saving a new zone or resetting clears the verdict, so the next inside counts as entering. Blocked decisions don't change it.

A newer segmentation replaces the current observation. Each segmentation can still trigger the lamp at most once: `claimPlacement` writes a row before the lamp call, and the pending event is saved first. If the process dies mid-call, the record stays `unconfirmed` and is never retried automatically.

## Tracking

The first identity is always manual: a person confirms a mug mask with `desk/select`. After that, `desk/track` takes the newest mug segmentation, picks the detection that overlaps the last box most (or the nearest one when none overlap) with `pickTracked`, records it as a `tracked` observation with its overlap, and verifies it in the same request. A frame with no mug changes nothing. Earlier observations are kept, newest first, in the memory's `history` (up to 12), which the lab shows as a timeline and a trail on the scene.

## Lamp results

Home Assistant accepting a request, the entity reporting the requested state, and the bulb actually lighting up are three separate things. `LampResult` records the first two (`accepted`, `stateConfirmed`). `physicalEffectVerified` is always `false`, because the software has no way to see the lamp.

## Not built yet

- Automatic motion detection and continuous capture
- Recognising the same mug by appearance. Tracking matches by position only, so two mugs swapping places would fool it.
- Camera calibration, so a zone can carry over between frames from a camera that did move
- More than one object, zone, or light
