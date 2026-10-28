# Living Layer

Living Layer gives everyday objects a memory so your smart home can react to them. Point a camera at a desk, confirm which blob is your mug, draw a zone, and the lamp turns on when the mug is inside it. Each decision is saved with the reason behind it, so you can check what happened afterwards.

It's an early local lab, not a product. One desk, one mug, one lamp.

## How it works

1. **Discover**: a vision model ([Meta Spark](https://dev.meta.ai/docs)) names up to three movable objects in a photo.
2. **Segment**: [SAM 3.1](https://dev.meta.ai/docs/sam/reading-segmentation) returns a mask for the object you pick.
3. **Remember**: you confirm a mask belongs to your mug. Identity is manual for now.
4. **Place**: draw a zone on the same image. If the mug's whole box fits inside it, Living Layer turns on one Home Assistant light.

Or start from one photo: in the **Iso** view, open **Edit scene** and choose **Upload a photo**. It takes two billed calls, or three with the check:

1. Spark lists what's in the photo, each thing with a loose box.
2. SAM 3.1 outlines every box in a single call.
3. Code measures the rest from the masks:
   - pins the desktop from its outline;
   - works out the camera from those four corners;
   - stands each thing where its outline meets the desk or the floor;
   - fits a pixel-art model to each object;
   - scores the drawing against the masks.

You then review the draft: drag a corner, change or remove things, tick what to track. Save keeps it all in one go.

Everything runs on your machine. The server binds to `127.0.0.1` and rejects other hosts and origins. A bundled synthetic fixture lets you run the whole loop with no API key, camera, or lamp.

See [docs/architecture.md](docs/architecture.md) for the details.

## Getting started

You need [Bun](https://bun.sh) 1.4+. It installs the packages, runs the server and the tests, and stores data with `bun:sqlite`. The web UI is built with Vite, and the browser tests also need Node 24.

```sh
bun install
bun run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310.

In **Fixture** mode, click _Discover objects_, then _Segment object_, _Confirm mug mask #7_, draw a zone around the mug, and _Verify placement_. The lamp is virtual in this mode and nothing leaves your machine.

## Going live

Copy `.env.example` to `.env` and fill in what you need. Restart the server after editing it.

| Variable                             | Purpose                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `MODEL_API_KEY`                      | Meta API key. Stays on the server and is never sent to the browser.                       |
| `META_LIVE_ENABLED`                  | Set to `true` to allow live Meta calls.                                                   |
| `META_DAILY_SPEND_LIMIT_USD`         | Daily cap on Meta spend in USD (default 10). Changeable in the lab's Setup tab.           |
| `HA_URL`, `HA_TOKEN`, `HA_ENTITY_ID` | Home Assistant origin, a long-lived token, and one `light.*` entity.                      |
| `HA_EXTRA_ENTITY_IDS`                | Optional. More `light.*` entities that extra placement rules may switch, comma-separated. |
| `HA_LIVE_ENABLED`                    | Set to `true` to allow the lamp to be switched.                                           |
| `CAMERA_STREAMS`                     | Optional. WHEP URLs of network cameras, for networks where mDNS discovery is blocked.     |

Then switch to **Live** mode, upload or capture a photo, and go through the same steps. Photos are only sent to Meta when you press a probe button.

You can also run the probes from the command line:

```sh
bun run doctor                                     # checks config, makes no network calls
bun run smoke                                      # offline run against the fixture
bun run smoke --live --image ./desk.jpg            # live run (add --lamp to switch the light)
```

### Network cameras

Any Mac or Linux machine (a Raspberry Pi with a USB webcam works) can share its camera with the labs:

```sh
scripts/share-camera.sh                            # --list, --device, --size, --fps, --name; see --help
```

It needs `ffmpeg` and [MediaMTX](https://github.com/bluenviron/mediamtx), and offers to install whichever is missing (`--yes` skips the question): ffmpeg through your package manager, MediaMTX through Homebrew or as the checksum-verified release binary in `~/.local/bin`. The camera is encoded once to H.264 (VideoToolbox on macOS, passed through untouched on Linux when the camera already outputs H.264) and served as WebRTC (WHEP, what the labs play, around 100 ms of latency) and RTSP. It is advertised over mDNS, so it shows up as a camera source in the desk lab and the playground; **Find network cameras** rescans.

## Development

```sh
bun run check          # format, typecheck, unit tests, web build
bun run test:browser   # Playwright, after `bunx playwright install chromium`
bun run format
```

| Path              | What's there                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/web`        | React UI                                                                         |
| `apps/server`     | Fastify API, Meta/SAM and Home Assistant adapters, SQLite store                  |
| `packages/domain` | Shared types, schemas, and the placement rule                                    |
| `fixtures`        | Synthetic SAM output for the illustrated desk ([provenance](fixtures/README.md)) |
| `tests`           | `bun test` integration tests and Playwright browser tests                        |

Local data (captures, raw SAM output, SQLite history, exports) is written to `.data/`, which is gitignored. Delete it with the server stopped to start fresh. The evidence export leaves out image bytes but does include object descriptions and your lamp's entity ID, so read it before sharing.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Meta Global AI Developer Hackathon

Living Layer was built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie track) between October 26 and November 4, 2026. The first commit is dated October 27, so the git history shows the whole build.

**Built during the event:** all the code and assets in this repository. That covers the web UI, the API server and its Meta and Home Assistant adapters, the shared domain types and placement rule, the SQLite evidence store, the synthetic fixture, the illustrated desk and favicon, the tests, and the scripts.

**From third parties:**

- [Muse Spark](https://dev.meta.ai/docs) and SAM 3.1, Meta's models, called through Meta's API
- `@meta-sam/parser`, Meta's library for parsing SAM output and decoding masks. Its encoder was also used once to produce the synthetic fixture ([details](fixtures/README.md)).
- [Home Assistant](https://www.home-assistant.io/), which controls the lamp
- Open source packages listed in `package.json`, including Fastify, React, Vite, sharp, zod, and the OpenAI SDK

## License

[MIT](LICENSE). The SAM stream parser (`@meta-sam/parser`) is under its own license; see [licenses/](licenses/README.md).
