# Security

Living Layer runs on your own machine and holds secrets that matter: camera URLs with their passwords, a Home Assistant token, an MQTT login and a paid Meta API key. Please report anything that could expose them, or let someone else switch your devices or spend on your key.

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/alex-red/living-layer/security/advisories/new), not in a public issue. Say what is affected, how to reproduce it, and what it lets an attacker do. You should hear back within a week.

## What is in scope

- The API server (`apps/server`): its host and origin checks, routes, and anything that reaches the network.
- The desktop node (`apps/node`) and the optional trackers in `services/`.
- How secrets are stored, logged, redacted or sent to the browser.

The server is meant for one person on a trusted network. `bun run dev` listens on the LAN on purpose; exposing the lab to the internet is not supported.

## Supported versions

Only the latest `main` is maintained.
