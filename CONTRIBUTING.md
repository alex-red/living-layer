# Contributing

Thanks for taking a look. Issues and pull requests are both welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

```sh
nvm use        # Node 24, from .nvmrc
npm ci
npm run dev
```

You don't need any API keys. Fixture mode covers the whole workflow offline.

## Before you open a PR

```sh
npm run check
npm run test:browser   # if you touched the UI
```

`check` runs Prettier, `tsc`, the Vitest suite, and a production build. CI runs the same commands.

A few conventions:

- Tests should never reach the network. Pass a mock `fetcher` into `buildApp`, as `tests/core.test.ts` does.
- Dependencies are pinned to exact versions (`.npmrc` sets `save-exact`).
- Don't commit anything from `.data/`, real photos, or `.env`.
- Write commit messages in the imperative ("Add zone editor", not "Added zone editor"). Keep the subject under about 60 characters and use the body to explain why.

## Reporting security issues

Please don't open a public issue for security problems. Use GitHub's private vulnerability reporting on this repository instead.
