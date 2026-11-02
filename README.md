# Living Layer

Living Layer gives everyday objects a memory so your smart home can react to them. Point a camera at a desk, confirm which blob is your mug, draw a zone, and the lamp turns on when the mug is inside it. Each decision is saved with the reason behind it, so you can check what happened afterwards.

It runs on your own machine. One corner camera, calibrated to the room, places what it sees in the room's isometric twin. It tracks several objects and fixtures, lets you change the room with the AI brush, keeps watching from the server with no tab open, and shows up in Home Assistant as entities of its own.

![The workspace: the scene outline, the photo beside its isometric twin, and the mug's inspector](docs/media/workspace.png)

## How it works

The lab is scene first: it keeps a small map of your room, and every object, zone and light lives in it.

1. **Your office.** Photograph the room, or use the demo office. From a photo, [Meta Spark](https://dev.meta.ai/docs) lists what's there with loose boxes, [SAM 3.1](https://dev.meta.ai/docs/sam/reading-segmentation) outlines every box in one call, and code measures the rest from the masks: the desktop's corners, the camera, where each thing stands, and a pixel-art model fitted to each object. You review the draft (drag a corner, change or remove things, tick what to track) and save it in one go. That's two billed calls, or three with Spark's check.
2. **The office desk.** A close view inside the office, the one the camera watches. SAM outlines the desk on a close photo and its corners are measured for you to check, or you click them yourself. The pin maps the camera's pixels onto the desk, so a mug on the photo stands in the right spot in the iso room.
3. **Objects.** SAM outlines what you name, or what Spark suggests. You confirm which outline is your mug; identity is always your call.
4. **A rule.** _When the mug is inside this zone, turn on the desk lamp._ Draw the zone on the photo or the iso desk.
5. **Run it.** Move the mug and track it. If its whole box is inside the zone, Living Layer turns on one Home Assistant light, and the decision is saved with its reason.
6. **Leave it watching.** `Watch on the server` follows the mug, other objects and fixtures found in the camera with no tab open. Frames are matched locally, a lost thing is looked for by how it looks, and SAM is asked only to confirm a zone crossing or find what nothing else can. Rules still fire only on SAM's answer.

The scene outline on the left doubles as the setup checklist. The inspector on the right shows whatever you select, with one main action. Every model call and decision is in the activity drawer below, with what it cost.

Everything runs on your machine. The server binds to `127.0.0.1` and rejects other hosts and origins. A bundled synthetic demo lets you run the whole loop with no API key, camera, or lamp.

See [docs/architecture.md](docs/architecture.md) for the details.

See [current priorities](docs/plans/current.md) for the October 29 source review and the live checks remaining before submission.

## Getting started

You need [Bun](https://bun.sh) 1.4+. It installs the packages, runs the server and the tests, and stores data with `bun:sqlite`. The web UI is built with Vite, and the browser tests also need Node 24.

```sh
bun install
bun run dev
```

Open http://127.0.0.1:43430. The API runs on port 43431.

![The first screen: start from the demo office or a photo of your own](docs/media/start.png)

Choose **Use the demo office**. Its frames come from a virtual camera high in the office’s front corner, already calibrated, so the desk comes pinned. Then:

1. In the outline, choose **Add object**, then **Segment object** and **Confirm mug mask #7**.
2. Select **Main zone**, choose **Draw / edit zone**, drag a box around the mug and **Save zone**.
3. Choose **Verify placement · virtual lamp**. The room warms up when the lamp turns on.
4. Move the mug with **Right** under the canvas, select **My desk mug** and choose **Track the mug** to watch the rule decide again.

The lamp is virtual in this mode and nothing leaves your machine.

## Going live

Copy `.env.example` to `.env` and fill in what you need. Restart the server after editing it.

| Variable                                 | Purpose                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_API_KEY`                          | Meta API key. Stays on the server and is never sent to the browser.                                                        |
| `META_LIVE_ENABLED`                      | Set to `true` to allow live Meta calls.                                                                                    |
| `META_DAILY_SPEND_LIMIT_USD`             | Daily cap on Meta spend in USD (default 10). Changeable from the spend pill.                                               |
| `HA_URL`, `HA_TOKEN`                     | Home Assistant origin and a long-lived token. Then tick the devices in the lab (_Home Assistant → Devices it can switch_). |
| `HA_LIVE_ENABLED`                        | On by default; `false` switches nothing at all.                                                                            |
| `HA_ENTITY_ID`                           | Optional. The main light, instead of ticking it in the lab.                                                                |
| `HA_EXTRA_ENTITY_IDS`                    | Optional. More `light.*` entities, comma-separated.                                                                        |
| `HA_SWITCH_ENTITY_IDS`                   | Optional. `switch.*`, `fan.*` or `input_boolean.*` entities, comma-separated.                                              |
| `MQTT_URL`, `MQTT_USERNAME`, `_PASSWORD` | Optional. The MQTT broker Home Assistant reads, for entities you show there (e.g. `binary_sensor.ll_office_presence`).     |
| `MQTT_LIVE_ENABLED`                      | Set to `true` to publish them. `MQTT_DISCOVERY_PREFIX` and `MQTT_BASE_TOPIC` change the topics.                            |
| `MQTT_DEVICES`                           | Optional. Lights and switches switched over MQTT (e.g. Zigbee2MQTT): `light.desk=zigbee2mqtt/Desk lamp`, comma-separated.  |
| `CAMERA_STREAMS`                         | Optional. WHEP or `rtsp://` URLs of network cameras, where mDNS discovery is blocked.                                      |
| `REMOTE_CAMERA_PORT`                     | HTTPS port for the phone camera page (default 43432). Only listens once a phone is paired.                                 |
| `REMOTE_CAMERA_HOST`                     | Optional. Address the pairing QR code points at, if the detected LAN address is wrong.                                     |
| `REMOTE_CAMERA_CERT`, `_KEY`             | Optional. PEM certificate and key for the phone page (e.g. mkcert); else self-signed.                                      |

Then switch to **Live** mode and go through the same steps with your own camera: mount it high in a corner of the room, looking across at the far corner, and **Calibrate the camera** on one of its frames (SAM outlines the floor and walls; you drag three marks and give the room’s size). Every scan, pin and picture then goes through that camera. Photos are only sent to Meta when you press a button that says it calls a model. The spend pill in the top bar shows today's spend against the limit.

You can also run the smoke checks from the command line:

```sh
bun run doctor                                     # checks config, makes no network calls
bun run fetch-model                                # the feature model the watcher uses, ~22 MB
bun run smoke                                      # offline run against the demo
bun run smoke --live --image ./desk.jpg            # live run (add --lamp to switch the light)
```

### Network cameras

Any Mac or Linux machine (a Raspberry Pi with a USB webcam works) can share its camera with the labs:

```sh
scripts/share-camera.sh                            # --list, --device, --size, --fps, --name; see --help
```

It needs `ffmpeg` and [MediaMTX](https://github.com/bluenviron/mediamtx), and offers to install whichever is missing (`--yes` skips the question): ffmpeg through your package manager, MediaMTX through Homebrew or as the checksum-verified release binary in `~/.local/bin`. The camera is encoded once to H.264 (VideoToolbox on macOS, passed through untouched on Linux when the camera already outputs H.264) and served as WebRTC (WHEP, what Living Layer plays, around 100 ms of latency) and RTSP. It is advertised over mDNS, so it shows up as a camera source in the workspace and the playground; **Find network cameras** rescans.

Its RTSP output is what lets the server watch it with no tab open: choose it as the camera, then **Watch on the server** on the mug. The server reads it with ffmpeg at 10 grey frames a second and takes a full picture only when SAM or the feature model needs one. `bun run fetch-model` downloads that feature model (DINOv3 ViT-S/16, about 22 MB, checksum-verified) into `DATA_DIR`; without it a lost thing goes straight to SAM. A phone camera streams to the tab only, so it can be followed in the tab but not watched by the server.

### A phone as the camera

**Phone** next to **Camera** in the live workspace (or **Use a phone as the camera** in the playground) shows a QR code. Scan it with a phone on the same Wi-Fi, accept the certificate warning once, and allow camera access; the panel then offers **Use the phone camera**. The phone streams its back camera to the lab over WebRTC, peer to peer; the lab server only relays the two SDPs (`apps/server/src/remote.ts`). Phone browsers only share the camera over HTTPS, so the phone page is served on its own port with a certificate made in `DATA_DIR` by `openssl` (or `REMOTE_CAMERA_CERT`); that port opens with the first pairing and serves nothing but the page and its signalling, behind a random token. A new code retires the old one, and a code nobody scans stops working after 15 minutes.

## Development

```sh
bun run ci             # format, typecheck, unit tests, web build
bun run test:browser   # Playwright, after `bunx playwright install chromium`
bun run test:browser:strict  # the same with tighter waits, to catch what CI's slower runner would fail
bun run format
```

`bun install` points git at `.githooks`, whose pre-push hook runs `ci` and `test:browser:strict`; `git push --no-verify` skips it.

| Path              | What's there                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- |
| `apps/web`        | React UI                                                                               |
| `apps/server`     | Fastify API, Meta/SAM and Home Assistant adapters, SQLite store                        |
| `packages/domain` | Shared types, schemas, and the placement rule                                          |
| `testdata`        | Recorded SAM output and sample photos for the tests ([provenance](testdata/README.md)) |
| `tests`           | `bun test` integration tests and Playwright browser tests                              |

Local data (captures, raw SAM output, SQLite history, exports) is written to `.data/`, which is gitignored. Delete it with the server stopped to start fresh. The evidence export leaves out image bytes but does include object descriptions and your lamp's entity ID, so read it before sharing.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Meta Global AI Developer Hackathon

Living Layer was built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie track) between October 26 and November 4, 2026. The first commit is dated October 27, so the git history shows the whole build.

**Built during the event:** all the code and assets in this repository. That covers the web UI, the API server and its Meta and Home Assistant adapters, the shared domain types and placement rule, the SQLite evidence store, the synthetic demo, the illustrated desk and favicon, the tests, and the scripts.

**From third parties:**

- [Muse Spark](https://dev.meta.ai/docs) and SAM 3.1, Meta's models, called through Meta's API
- `@meta-sam/parser`, Meta's library for parsing SAM output and decoding masks. Its encoder was also used once to produce the synthetic mug mask ([details](testdata/README.md)).
- [Home Assistant](https://www.home-assistant.io/), which controls the lamp
- DINOv3 ViT-S/16, an optional local appearance model downloaded from [ONNX Community](https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX), under its own DINOv3 license
- Open source packages listed in `package.json`, including Fastify, React, Vite, sharp, zod, and the OpenAI SDK

## License

[MIT](LICENSE). The SAM stream parser (`@meta-sam/parser`) is under its own license; see [licenses/](licenses/README.md).
