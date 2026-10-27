# Living Layer

Living Layer gives everyday objects a memory so your smart home can react to them. Point a camera at a desk, confirm which blob is your mug, draw a zone, and the lamp turns on when the mug is inside it. Each decision is saved with the reason behind it, so you can check what happened afterwards.

It's an early local lab, not a product. One desk, one mug, one lamp.

## How it works

1. **Discover**: a vision model ([Meta Spark](https://dev.meta.ai/docs)) names up to three movable objects in a photo.
2. **Segment**: [SAM 3.1](https://dev.meta.ai/docs/sam/reading-segmentation) returns a mask for the object you pick.
3. **Remember**: you confirm a mask belongs to your mug. Identity is manual for now.
4. **Place**: draw a zone on the same image. If the mug's whole box fits inside it, Living Layer turns on one Home Assistant light.

Everything runs on your machine. The server binds to `127.0.0.1` and rejects other hosts and origins. A bundled synthetic fixture lets you run the whole loop with no API key, camera, or lamp.

See [docs/architecture.md](docs/architecture.md) for the details.

## Getting started

You need Node 24+ and npm.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310.

In **Fixture** mode, click _Discover objects_, then _Segment object_, _Confirm mug mask #7_, draw a zone around the mug, and _Verify placement_. The lamp is virtual in this mode and nothing leaves your machine.

## Going live

Copy `.env.example` to `.env` and fill in what you need. Restart the server after editing it.

| Variable                             | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `MODEL_API_KEY`                      | Meta API key. Stays on the server and is never sent to the browser.  |
| `META_LIVE_ENABLED`                  | Set to `true` to allow live Meta calls.                              |
| `META_MAX_REQUESTS_PER_DAY`          | Daily cap on outbound attempts, failures included (default 20).      |
| `HA_URL`, `HA_TOKEN`, `HA_ENTITY_ID` | Home Assistant origin, a long-lived token, and one `light.*` entity. |
| `HA_LIVE_ENABLED`                    | Set to `true` to allow the lamp to be switched.                      |

Then switch to **Live** mode, upload or capture a photo, and go through the same steps. Photos are only sent to Meta when you press a probe button.

You can also run the probes from the command line:

```sh
npm run doctor                                     # checks config, makes no network calls
npm run smoke                                      # offline run against the fixture
npm run smoke -- --live --image ./desk.jpg         # live run (add --lamp to switch the light)
```

## Development

```sh
npm run check          # format, typecheck, unit tests, production build
npm run test:browser   # Playwright, after `npx playwright install chromium`
npm run format
```

| Path              | What's there                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `apps/web`        | React UI                                                                         |
| `apps/server`     | Fastify API, Meta/SAM and Home Assistant adapters, SQLite store                  |
| `packages/domain` | Shared types, schemas, and the placement rule                                    |
| `fixtures`        | Synthetic SAM output for the illustrated desk ([provenance](fixtures/README.md)) |
| `tests`           | Vitest integration tests and Playwright browser tests                            |

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
