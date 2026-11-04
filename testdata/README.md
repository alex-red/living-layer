# Test data

`sam-mug.json` is **synthetic**, not a Meta API response; tests use it as SAM's answer for the mug. `desk.svg` is an original code-drawn illustration, not a camera capture; tests use it as a desk photo. Demo discovery labels and the virtual lamp response are deterministic, hand-authored data in `apps/server/src/demo.ts`.

The 64 × 64 mug raster was frozen into SAM wire text using the internal deterministic conformance-data encoder distributed in `@meta-sam/parser` 0.1.0. That one-off generation step is not a supported application API; the application and tests import only public package-root APIs. Do not regenerate via an assumed custom codec or treat this as a real model observation.

The saved wire deliberately uses sparse object ID `7`, frame `0`, a crop-local mask, and a source box `(350, 180)–(610, 460)` in a 960 × 640 image. The wire's inclusive `x2/y2` values are 609/459; Meta's parser normalizes those to half-open bounds. The SVG uses exactly the decoded path at that transform and `fill-rule="evenodd"` for holes. Object IDs apply to this response, not permanent LivingLayer identities.

The absent-target case returns a finalized empty output-text lane and a completed response. Split-token chunks exercise the actual streaming parser. Tests also cover invalid frames, incomplete responses, malformed masks, and oversized geometry.

`items/` holds masked crops for the item fit benchmark (`bun scripts/fit-bench.ts`): a `<name>.png` with the SAM mask in alpha and every pixel outside it cleared, and a `<name>.json` of `{ "label", "archetype", "elevation"?, "object"?, "sizeCm"? }`. `sizeCm` (`h`, `rim`, `estimate`) is the thing's real size, which the bench's `shape` column is judged by; crops sharing an `object` are one thing seen from several sides (`spread`). A `<name>.sam3d.json` beside a crop is SAM 3D's shape of it (a lathe profile), read by the bench's SAM 3D rows; `bun scripts/experiments/sam3d.ts --local --lathe` writes them again. The four `mug-*.png` crops are real: the project owner's own Tim Hortons mug on their desk, cut from live captures by SAM 3.1 masks and published with the owner's consent on 2026-10-28. Nothing but the masked mug is kept; the wordmark is the mug's own print. Add only crops you have the right to publish, with their provenance.

`apps/web/public/demo/fridge/*.webp` (open, left door, right door, closed) start from the project owner's own photos of their fridge, published with their consent. Before publishing they were redrawn by Muse Image with everyday store-brand items in place of the real ones and the planner wiped, then cut to 960 × 1280 WebP. The demo's Fridge scene shows them until a camera or photo of its own is there.

Real captures and raw SAM responses belong under ignored `.data/evidence/`, with explicit provenance and consent before publishing. Demo evidence must retain `mode: "demo"`; it never advances live proof.

The parser is governed by the [SAM license](../licenses/meta-sam-LICENSE.txt). No third-party photographs or frontend assets are bundled.

`apps/web/public/mouse.svg` (from above), `lamp.svg` (from a little above, so its rims show as ellipses), `monitor.svg` and `cat.svg` are original code-drawn illustrations too, the demo's reference pictures for drafting fixtures (`DEMO_REFERENCES`). Each mask is read from the SVG's own `<name>-body` polygon at runtime (`demoReference` in `apps/server/src/demo.ts`), and `demoFixtureClass` is hand-written.

The photo draft's demo data (`demoPhotoInventory` and `demoPhotoSegmentation` in `apps/server/src/demo.ts`) is the demo office rendered through `DEMO_CAMERA` (`packages/domain/src/demo-room.ts`), with hand-written labels: each thing's mask and box are its own rendered pixels in the frame (`demoDetection`), and the mug's close-up mask is cut the same way from its close render (`demoMugCloseUp`). The masks are handed over as already-decoded detections, not SAM wire text, and no codec was used to make them.

`recipes/alex-desk.json` is a hand-written model recipe for tests and the sheet, not a product specification: its outer size is the desk's listed 131 × 60 × 76 cm, and its parts (side panel, drawer unit, three drawers) are estimated, not checked against the product.
