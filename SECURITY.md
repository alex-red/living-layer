# Security

Living Layer runs on your own machine and holds secrets that matter: camera URLs with their passwords, a Home Assistant token, an MQTT login and a paid Meta API key. Please report anything that could expose them, or let someone else switch your devices or spend on your key.

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/alex-red/living-layer/security/advisories/new), not in a public issue. Say what is affected, how to reproduce it, and what it lets an attacker do. You should hear back within a week.

## What is in scope

- The API server (`apps/server`): its host and origin checks, routes, and anything that reaches the network.
- The desktop node (`apps/node`) and the optional trackers in `services/`.
- How secrets are stored, logged, redacted or sent to the browser.

The server is meant for one person on a trusted network; exposing the lab to the internet is not supported. `bun run start` listens on loopback. These listen on the network on purpose:

- `bun run dev`: the lab and its API, which accept only this machine's own hostname and addresses.
- The phone camera page (`REMOTE_CAMERA_PORT`, HTTPS): only once a phone is paired, behind a random token.
- The camera relay (MediaMTX): under `bun run dev` its WebRTC media; with a GPU tracker configured, its RTSP, to that node alone with its token as the password.
- Each desktop node (`apps/node`, port 43440): advertised over mDNS, and paired by token with the first lab that adopts it; only `/info`, and `/pair` until it is adopted, answer without the token.
- The GPU tracker node (`services/gpu-tracker`, port 43450 on its own machine): everything but `/health` needs its token.

## Supported versions

Only the latest `main` is maintained.
