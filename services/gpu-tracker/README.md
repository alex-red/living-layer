# GPU tracker

Follows chosen things through the camera with SAM 2.1's streaming video predictor (`facebook/sam2.1-hiera-small`, Apache-2.0, through 🤗 transformers) on an NVIDIA GPU. It is phase 5 of [multi-tracking.md](../../docs/plans/multi-tracking.md): a worker whose boxes are a reason to look, not a verdict.

The lab picks what is followed and sends a box per thing. The node reads the camera itself (RTSP, or `file://` for a test), cuts the camera's crop, and streams each thing's box back over server-sent events, in shares of the cropped frame like the lab's own boxes. The API is described at the top of `server.py`; everything but `/health` takes `Authorization: Bearer $TRACKER_TOKEN`.

```sh
bun run gpu-tracker deploy                      # rsync to iolinux, token in its .env, compose up --build
bun run gpu-tracker check --box mug=0.361,0.508,0.062,0.083
bun run gpu-tracker watch --box mug=… --box mouse=… [--seconds 30] [--motion 0]
bun run gpu-tracker stop
```

## In the lab

Set `GPU_TRACKER_URL` (`http://iolinux.lan:43450`) and `GPU_TRACKER_TOKEN` (the host's `TRACKER_TOKEN`) in `.env` and restart the server. While the live camera is watched, the watcher opens the same camera on the node with every followed thing at its current box, and reads its results (`apps/server/src/gpu-tracker.ts`). They never judge a zone; each one only corrects the local track (`gpuCorrections`, `packages/domain/src/gpu-track.ts`):

- a thing the GPU sees surely (score ≥ 0.8) and steadily (two results agreeing) where the local match lost it, or far from where the local match put it, starts again there, with no SAM call or whole-frame search; the canvas marks it `GPU`;
- a thing the local match follows at rest that the GPU lost is handed back to the GPU at the local box, at most every 10 s.

The watch summary in the inspector says how fast it runs and how many tracks it fixed, or why it is unavailable. When the node is down the watcher follows on this machine as before and retries every 5 s. Demo mode never calls it. It isn't gated by _Let tracking call AI_: it is your own machine, not a billed API.

The watcher's health bar has a **This machine | GPU node** switch. With the GPU node chosen, its verdict says what the node is doing (`gpuHealth`): _waiting_ while it connects, _stalled_ when it is unavailable (this machine follows meanwhile), _behind_ after 5 s without a result. Its numbers (frame rate, work per frame, CPU) stay this machine's, since the local match still reads every frame; the GPU's step, result rate and fixes are its own rows below them. On a still desk the node sends about one result a second: it skips frames where nothing moved.

**One camera client.** The node reads the camera through the lab's relay (mediamtx), not the camera itself: with a GPU tracker configured, the relay also serves its RTSP on the network to user `gpu` (the tracker's token as its password, from the tracker's address only). A Wi-Fi camera sending two full streams halved both: the tab's view fell from 24 to 11 fps and froze 18% of the time. Without the relay the node reads the camera directly.

**PyAV and the GIL.** FFmpeg's logs go straight to stderr (`av.logging.restore_default_callback()`). Routed through Python, a decoder thread logging a corrupt frame waited for the GIL while a replaced session's reader held it, freeing that decoder: the whole node stopped answering. Corrupt frames are common on this Wi-Fi camera.

## The GPU on iolinux

vLLM holds 0.93 of the 4090 and the docker-AI-orchestrator owns it, so the tracker runs only while vLLM is stopped (`restart: "no"`):

```sh
curl -X POST localhost:7001/admin/pause && docker stop vllm     # on iolinux, before
docker start vllm && curl -X POST localhost:7001/admin/resume   # after: stop the tracker first
```

Registering it as an orchestrator `container` service (with a lease while following) is the next step.

## Measured (November 4, office camera, 1030 × 772 crop, three things)

| What                       | Result                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `/segment`, warm           | 9.6 ms; boxes within a pixel or two of a hand box, score ≥ 0.97                 |
| Following, every frame     | 31 ms a step (p95 32); 251 of 251 frames seen for each thing                    |
| Camera                     | 8.8 frames/s arrive: the camera, not the GPU, sets the rate                     |
| Still desk, motion gate on | 18 steps in 30 s (one a second), 116 frames skipped                             |
| VRAM                       | 93 MB model; grows with the session to about 2.7 GB, re-seeded every 300 frames |

Not tested yet: a thing actually moving, occlusion, two look-alikes swapping.
