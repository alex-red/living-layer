# Test fixtures

`sam-mug.json` is **synthetic**, not a Meta API response. `apps/web/public/desk.svg` is an original code-drawn illustration, not a camera capture. Fixture discovery labels and the virtual lamp response are deterministic, hand-authored data in `apps/server/src/fixtures.ts`.

The 64 × 64 mug raster was frozen into SAM wire text using the internal deterministic conformance-data encoder distributed in `@meta-sam/parser` 0.1.0. That one-off generation step is not a supported application API; the application and tests import only public package-root APIs. Do not regenerate via an assumed custom codec or treat this as a real model observation.

The saved wire deliberately uses sparse object ID `7`, frame `0`, a crop-local mask, and a source box `(350, 180)–(610, 460)` in a 960 × 640 image. The wire's inclusive `x2/y2` values are 609/459; Meta's parser normalizes those to half-open bounds. The SVG uses exactly the decoded path at that transform and `fill-rule="evenodd"` for holes. Object IDs apply to this response, not permanent LivingLayer identities.

The absent-target fixture returns a finalized empty output-text lane and a completed response. Split-token chunks exercise the actual streaming parser. Tests also cover invalid frames, incomplete responses, malformed masks, and oversized geometry.

`items/` holds masked crops for the item fit benchmark (`bun scripts/fit-bench.ts`): a `<name>.png` with the SAM mask in alpha and every pixel outside it cleared, and a `<name>.json` of `{ "label", "archetype", "elevation"? }`. The four `mug-*.png` crops are real: the project owner's own Tim Hortons mug on their desk, cut from live captures by SAM 3.1 masks and published with the owner's consent on 2026-10-28. Nothing but the masked mug is kept; the wordmark is the mug's own print. Add only crops you have the right to publish, with their provenance.

Real captures and raw SAM responses belong under ignored `.data/evidence/`, with explicit provenance and consent before publishing. Fixture evidence must retain `mode: "fixture"`; it never advances live proof.

The parser is governed by the [SAM license](../licenses/meta-sam-LICENSE.txt). No third-party photographs or frontend assets are bundled.
