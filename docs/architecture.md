# Architecture

```
browser (apps/web)  ──/api──▶  Fastify (apps/server)  ──▶  Meta Responses API (Spark, SAM)
                                   │                   └─▶  Home Assistant REST API
                                   └─▶  SQLite + files in .data/
```

The browser never talks to Meta or Home Assistant directly. Keys and tokens live in the server's `.env`.

## Modes

Every request carries a `mode`, either `fixture` or `live`.

- **fixture** uses the illustrated desk in `apps/web/public/desk.svg`, hand-written discovery results, a synthetic SAM stream, and a virtual lamp. It never makes network calls.
- **live** validates and re-encodes an uploaded image with `sharp`, then calls the real services. Each outbound Meta attempt is counted against a per-day limit in SQLite _before_ the request is sent, so failures count too.

Fixture and live have separate desk memory. Fixture runs never count toward the live checklist in the UI.

## Server

| File        | Responsibility                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`    | Routes for the individual probes (`text`, `discover`, `segment`, `lamp`), loopback host/origin checks, and recording each run as an evidence record |
| `desk.ts`   | The placement workflow: select a mug, save a zone, verify, reset                                                                                    |
| `meta.ts`   | Spark (structured JSON output) and SAM (streamed) through the OpenAI-compatible SDK, with retries disabled                                          |
| `sam.ts`    | Runs the SAM stream through `@meta-sam/parser` and rejects anything incomplete, mismatched, or oversized                                            |
| `lamp.ts`   | Turns one light on, then polls its state to see whether it matches                                                                                  |
| `store.ts`  | SQLite tables for evidence, desk memory, placement claims, and the request budget                                                                   |
| `errors.ts` | `LabError`, and mapping upstream failures to generic messages so provider errors never leak keys or inputs                                          |

## Placement rule

`placementGate` in `packages/domain` makes the decision. A placement is **inside** only when:

- an observation exists for the remembered object and is less than five minutes old,
- a zone was saved on the same source image (zones are tied to a SHA-256 of the prepared image, not to physical coordinates), and
- the whole detection box fits within the zone.

A newer segmentation replaces the current observation. Each segmentation can trigger the lamp at most once: `claimPlacement` writes a row before the lamp call, and the pending event is saved first. If the process dies mid-call, the record stays `unconfirmed` and is never retried automatically.

## Lamp results

Home Assistant accepting a request, the entity reporting the requested state, and the bulb actually lighting up are three separate things. `LampResult` records the first two (`accepted`, `stateConfirmed`). `physicalEffectVerified` is always `false`, because the software has no way to see the lamp.

## Not built yet

- Automatic motion detection and continuous capture
- Recognising the same mug across photos without a manual confirmation
- Camera calibration, so a zone can carry over between frames
- More than one object, zone, or light
