# Third-party notices

Living Layer uses Meta's `@meta-sam/parser` 0.1.0 for SAM stream parsing and mask conversion. Its SAM license is reproduced in [meta-sam-LICENSE.txt](meta-sam-LICENSE.txt). See installed dependency metadata and the lockfile for the other packages and their licenses. The project does not bundle SAM model weights.

The desk illustration and favicon are original code-drawn SVGs. `design/reference/office.webp`, the picture the room's tones are matched to, was generated with Meta's image model for this project. Typography uses system fallbacks; no external font, analytics, or image requests are required by the app.

Nothing below is bundled with this repository or covered by its MIT license; each is installed or downloaded separately and keeps its own license:

- [FFmpeg](https://ffmpeg.org/legal.html), which the server runs as a separate program to read cameras: LGPL 2.1 or later, or GPL 2 or later when built with its optional GPL parts (as many packaged builds are). The server only calls the `ffmpeg` on your `PATH`.
- [MediaMTX](https://github.com/bluenviron/mediamtx), the camera relay the server starts when it finds `mediamtx` on your `PATH`: MIT.
- [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects), the experimental shape refiner (off unless `SAM3D_ENABLED=true`): its code and checkpoints are under Meta's SAM License. It runs through mlx-spatial with weights you download yourself, or on fal.ai under fal's terms.
- SAM 2.1 (`facebook/sam2.1-hiera-small`), which the optional GPU tracker node downloads through Hugging Face transformers: Apache-2.0.
- Apple's Vision framework, part of macOS, which the optional vision tracker calls: Apple's macOS terms.

The optional appearance fallback downloads DINOv3 ViT-S/16 int8 weights from [ONNX Community](https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX). That repository identifies the license as `dinov3-license`; see also [Meta's source model](https://huggingface.co/facebook/dinov3-vits16-pretrain-lvd1689m). The weights are stored locally in `DATA_DIR`, are not bundled with this repository, and are not covered by this repository's MIT license. The download source and SHA-256 checksums are recorded in `apps/server/src/appearance.ts`.
