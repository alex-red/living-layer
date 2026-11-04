# Third-party notices

Living Layer uses Meta's `@meta-sam/parser` 0.1.0 for SAM stream parsing and mask conversion. Its SAM license is reproduced in [meta-sam-LICENSE.txt](meta-sam-LICENSE.txt). See installed dependency metadata and the lockfile for the other packages and their licenses. The project does not bundle SAM model weights.

The desk illustration and favicon are original code-drawn SVGs. `design/reference/office.webp`, the picture the room's tones are matched to, was generated with Meta's image model for this project. Typography uses system fallbacks; no external font, analytics, or image requests are required by the app.

The optional appearance fallback downloads DINOv3 ViT-S/16 int8 weights from [ONNX Community](https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX). That repository identifies the license as `dinov3-license`; see also [Meta's source model](https://huggingface.co/facebook/dinov3-vits16-pretrain-lvd1689m). The weights are stored locally in `DATA_DIR`, are not bundled with this repository, and are not covered by this repository's MIT license. The download source and SHA-256 checksums are recorded in `apps/server/src/appearance.ts`.
